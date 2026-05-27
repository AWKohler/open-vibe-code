/**
 * POST /api/projects/[id]/stripe/initialize
 *
 * Slice 1 — silently provision an Express **test** account for this project.
 * No KYC, no Stripe-hosted popup, no Stripe.js: Express test accounts are
 * server-side creations. The live account is created lazily by a separate
 * endpoint when the user flips the workspace toolbar to Live (future slice).
 *
 * Idempotent: if `stripe_enabled` is already true, returns the stored
 * account id with `alreadyEnabled: true` and does no Stripe work.
 *
 * Auth: Clerk session; caller must own the project.
 * Tier: Pro/Max only (see canUseStripeConnect).
 * Feature flag: STRIPE_CONNECT_ENABLED.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { canUseStripeConnect } from '@/lib/tier';
import { getStripe, isStripeConfigured } from '@/lib/stripe';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!STRIPE_CONNECT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Stripe Connect is not enabled on this deployment.' },
      { status: 404 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id: projectId } = await params;
  const db = getDb();

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }

  if (project.backendType === 'none') {
    return NextResponse.json(
      {
        ok: false,
        status: 'backend-blocked',
        error:
          'This project was created with the No Backend option. Stripe requires a backend (Convex) to receive webhook events and store billing state.',
      },
      { status: 400 },
    );
  }

  const gate = await canUseStripeConnect(userId);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, status: 'tier-blocked', error: gate.reason, tier: gate.tier },
      { status: 402 },
    );
  }

  // Idempotency: already initialized.
  if (project.stripeEnabled && project.stripeTestAccountId) {
    return NextResponse.json({
      ok: true,
      status: 'already-enabled',
      mode: project.stripePaymentMode,
      testAccountId: project.stripeTestAccountId,
      liveAccountId: project.stripeLiveAccountId,
      alreadyEnabled: true,
    });
  }

  if (!isStripeConfigured('test')) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Stripe test keys are not configured on this deployment. Set STRIPE_SECRET_KEY_TEST in the Vercel project env and redeploy.',
      },
      { status: 500 },
    );
  }

  let account: Awaited<ReturnType<ReturnType<typeof getStripe>['accounts']['create']>>;
  try {
    const stripe = getStripe('test');
    account = await stripe.accounts.create({
      type: 'express',
      metadata: {
        botflow_project_id: projectId,
        botflow_user_id: userId,
        botflow_mode: 'test',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/initialize] accounts.create threw:', err);
    return NextResponse.json(
      { ok: false, error: `Stripe account creation failed: ${message}` },
      { status: 500 },
    );
  }

  // Per-project HMAC for signing webhook deliveries we'll later forward into
  // the project's Convex HTTP endpoint. Generated now so a future slice can
  // start using it without another DB write.
  const webhookSecret = `bfws_${randomBytes(32).toString('hex')}`;

  await db
    .update(projects)
    .set({
      stripeTestAccountId: account.id,
      stripeEnabled: true,
      stripePaymentMode: 'test',
      stripeWebhookSecret: webhookSecret,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));

  return NextResponse.json({
    ok: true,
    status: 'enabled',
    mode: 'test',
    testAccountId: account.id,
    alreadyEnabled: false,
  });
}
