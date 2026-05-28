/**
 * POST /api/webhooks/stripe
 *
 * Platform-level Stripe Connect webhook receiver. Stripe sends ALL events
 * for all connected accounts here (one endpoint per mode in Stripe dashboard;
 * we verify against whichever secret matches). We then:
 *
 *   1. Verify Stripe-Signature against STRIPE_WEBHOOK_SECRET_TEST or
 *      STRIPE_WEBHOOK_SECRET (live). The first one that verifies wins.
 *   2. Claim the event by INSERTing into stripe_webhook_events. PK conflict
 *      = already processed → 200 ok.
 *   3. Look up which Botflow projects belong to event.account.
 *   4. Normalize to canonical types (subscription.activated|canceled|updated,
 *      payment.succeeded|failed, account.updated).
 *   5. Fan out to each affected project's Convex HTTP endpoint, HMAC-signed
 *      with the project's stripe_webhook_secret. Inline 3-try backoff per
 *      fan-out; failures are logged but don't 500 the response (we already
 *      claimed the event).
 *
 * Failures inside step 1 return 400 so Stripe retries (the test/live secret
 * setup is platform-side and recoverable). Failures after that return 200
 * so Stripe doesn't re-deliver (we own the retry budget from here on).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { getDb } from '@/db';
import {
  projects,
  stripeWebhookEvents,
  userStripeIdentity,
} from '@/db/schema';
import { getStripe, type StripeMode } from '@/lib/stripe';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface CanonicalEvent {
  type:
    | 'subscription.activated'
    | 'subscription.canceled'
    | 'subscription.updated'
    | 'payment.succeeded'
    | 'payment.failed'
    | 'account.updated';
  id: string;
  accountId: string | null;
  mode: StripeMode;
  data: Record<string, unknown>;
}

// ─── Signature verification (try each mode's secret) ─────────────────────

function configuredWebhookSecrets(): Array<{ mode: StripeMode; secret: string }> {
  const out: Array<{ mode: StripeMode; secret: string }> = [];
  const test = process.env.STRIPE_WEBHOOK_SECRET_TEST;
  if (test) out.push({ mode: 'test', secret: test });
  const live = process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET;
  if (live) out.push({ mode: 'live', secret: live });
  return out;
}

function verifyAny(
  rawBody: string,
  signatureHeader: string,
): { event: Stripe.Event; mode: StripeMode } | null {
  const secrets = configuredWebhookSecrets();
  for (const { mode, secret } of secrets) {
    try {
      // Pick a Stripe client for constructEvent — any will do; this is local
      // crypto only.
      const stripe = getStripe(mode);
      const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
      return { event, mode };
    } catch {
      // Wrong secret for this mode — try the next.
    }
  }
  return null;
}

// ─── Normalization ────────────────────────────────────────────────────────

function normalize(event: Stripe.Event, mode: StripeMode): CanonicalEvent | null {
  const accountId = event.account ?? null;
  const id = event.id;
  switch (event.type) {
    case 'customer.subscription.created': {
      const sub = event.data.object as Stripe.Subscription;
      // A brand-new sub may be 'trialing' or 'active'. We treat 'active' or
      // 'trialing' as activation; anything else falls through to updated.
      if (sub.status === 'active' || sub.status === 'trialing') {
        return {
          type: 'subscription.activated',
          id,
          accountId,
          mode,
          data: {
            subscriptionId: sub.id,
            customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
            status: sub.status,
            priceId: sub.items.data[0]?.price?.id ?? null,
            metadata: sub.metadata,
          },
        };
      }
      return {
        type: 'subscription.updated',
        id,
        accountId,
        mode,
        data: { subscriptionId: sub.id, status: sub.status, metadata: sub.metadata },
      };
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      return {
        type: 'subscription.canceled',
        id,
        accountId,
        mode,
        data: {
          subscriptionId: sub.id,
          customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          metadata: sub.metadata,
        },
      };
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      // Transition to canceled / past_due → emit canceled
      if (sub.status === 'canceled' || sub.cancel_at_period_end) {
        return {
          type: 'subscription.canceled',
          id,
          accountId,
          mode,
          data: {
            subscriptionId: sub.id,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            status: sub.status,
            metadata: sub.metadata,
          },
        };
      }
      return {
        type: 'subscription.updated',
        id,
        accountId,
        mode,
        data: {
          subscriptionId: sub.id,
          status: sub.status,
          priceId: sub.items.data[0]?.price?.id ?? null,
          metadata: sub.metadata,
        },
      };
    }
    case 'payment_intent.succeeded':
    case 'checkout.session.completed': {
      const obj = event.data.object as
        | Stripe.PaymentIntent
        | Stripe.Checkout.Session;
      const metadata = (obj.metadata ?? {}) as Record<string, string>;
      if (event.type === 'checkout.session.completed') {
        const session = obj as Stripe.Checkout.Session;
        if (session.payment_status !== 'paid') return null;
        return {
          type: 'payment.succeeded',
          id,
          accountId,
          mode,
          data: {
            sessionId: session.id,
            paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
            amountTotal: session.amount_total ?? null,
            currency: session.currency ?? null,
            customerEmail: session.customer_details?.email ?? null,
            metadata,
          },
        };
      }
      const pi = obj as Stripe.PaymentIntent;
      return {
        type: 'payment.succeeded',
        id,
        accountId,
        mode,
        data: {
          paymentIntentId: pi.id,
          amount: pi.amount,
          currency: pi.currency,
          metadata,
        },
      };
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        type: 'payment.failed',
        id,
        accountId,
        mode,
        data: {
          paymentIntentId: pi.id,
          amount: pi.amount,
          currency: pi.currency,
          lastError: pi.last_payment_error?.message ?? null,
          metadata: pi.metadata,
        },
      };
    }
    case 'account.updated': {
      const acct = event.data.object as Stripe.Account;
      return {
        type: 'account.updated',
        id,
        accountId,
        mode,
        data: {
          chargesEnabled: acct.charges_enabled,
          payoutsEnabled: acct.payouts_enabled,
          detailsSubmitted: acct.details_submitted,
          requirementsDisabledReason: acct.requirements?.disabled_reason ?? null,
        },
      };
    }
    default:
      return null;
  }
}

// ─── Fan-out to project Convex sites ──────────────────────────────────────

function convexSiteUrlFor(project: typeof projects.$inferSelect): string | null {
  const deployUrl = project.userConvexUrl ?? project.convexDeployUrl;
  if (!deployUrl) return null;
  return deployUrl.replace('.convex.cloud', '.convex.site');
}

async function deliverWithRetry(opts: {
  url: string;
  signature: string;
  body: string;
}): Promise<{ ok: boolean; lastStatus?: number; lastError?: string }> {
  const delays = [200, 1000, 5000];
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  for (let i = 0; i < delays.length; i++) {
    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Botflow-Signature': opts.signature,
        },
        body: opts.body,
        // Reasonable per-attempt timeout — Convex HTTP actions are quick.
        signal: AbortSignal.timeout(8000),
      });
      lastStatus = res.status;
      if (res.ok) return { ok: true, lastStatus };
      lastError = (await res.text()).slice(0, 300);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (i < delays.length - 1) {
      await new Promise((r) => setTimeout(r, delays[i + 1]));
    }
  }
  return { ok: false, ...(lastStatus !== undefined ? { lastStatus } : {}), ...(lastError ? { lastError } : {}) };
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!STRIPE_CONNECT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Stripe Connect is not enabled on this deployment.' },
      { status: 404 },
    );
  }

  const signatureHeader = req.headers.get('stripe-signature');
  if (!signatureHeader) {
    return NextResponse.json({ ok: false, error: 'Missing Stripe-Signature' }, { status: 400 });
  }

  const rawBody = await req.text();
  const verified = verifyAny(rawBody, signatureHeader);
  if (!verified) {
    return NextResponse.json({ ok: false, error: 'Signature did not verify' }, { status: 400 });
  }
  const { event, mode } = verified;

  // Claim the event — PK conflict = already processed → 200 to Stripe.
  const db = getDb();
  try {
    await db.insert(stripeWebhookEvents).values({ eventId: event.id });
  } catch {
    // Duplicate key. Stripe is re-delivering; we already handled it.
    return NextResponse.json({ ok: true, dedup: true });
  }

  const canonical = normalize(event, mode);
  if (!canonical) {
    // We don't care about this event type — already deduped, just ack.
    return NextResponse.json({ ok: true, ignored: event.type });
  }

  // Find which Botflow user owns the connected account, then fan out to all
  // of their Stripe-enabled projects.
  if (!canonical.accountId) {
    return NextResponse.json({ ok: true, ignored: 'no_account_on_event' });
  }
  const accountCol =
    canonical.mode === 'live' ? userStripeIdentity.liveAccountId : userStripeIdentity.testAccountId;
  const [identity] = await db
    .select({ userId: userStripeIdentity.userId })
    .from(userStripeIdentity)
    .where(eq(accountCol, canonical.accountId))
    .limit(1);
  if (!identity) {
    return NextResponse.json({ ok: true, ignored: 'no_botflow_user_for_account' });
  }
  const projectRows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.userId, identity.userId),
        eq(projects.stripeEnabled, true),
        // Only deliver to projects in the same mode the event came from —
        // a project switched to 'live' shouldn't receive 'test' events.
        eq(projects.stripePaymentMode, canonical.mode),
      ),
    );

  const payload = JSON.stringify(canonical);
  const deliveries = await Promise.all(
    projectRows.map(async (project) => {
      if (!project.stripeWebhookSecret) {
        return { projectId: project.id, ok: false, reason: 'no_secret' };
      }
      const siteUrl = convexSiteUrlFor(project);
      if (!siteUrl) {
        return { projectId: project.id, ok: false, reason: 'no_convex_site' };
      }
      const signature = createHmac('sha256', project.stripeWebhookSecret)
        .update(payload)
        .digest('hex');
      const result = await deliverWithRetry({
        url: `${siteUrl}/stripe/webhook`,
        signature,
        body: payload,
      });
      if (!result.ok) {
        console.error(
          '[stripe/webhook] fan-out failed',
          project.id,
          'lastStatus=',
          result.lastStatus,
          'lastError=',
          result.lastError,
        );
      }
      return { projectId: project.id, ok: result.ok, ...(result.lastStatus !== undefined ? { lastStatus: result.lastStatus } : {}) };
    }),
  );

  return NextResponse.json({ ok: true, deliveries: deliveries.length, type: canonical.type });
}

