/**
 * POST /api/projects/[id]/stripe/initialize
 *
 * Agent-triggered modal-driven Stripe Connect setup. Mirrors the
 * setupOAuthProvider tool pattern in src/lib/agent/sandboxed-web-tools.ts.
 *
 * Outcomes (returned to the agent):
 *   • already-connected — the user previously linked Stripe; this project is
 *     now flipped on without any user action. The agent proceeds.
 *   • connected         — modal opened, user clicked Connect with Stripe,
 *     OAuth completed, DB updated. The agent proceeds.
 *   • dismissed         — user clicked X. The agent should NOT retry.
 *   • timeout           — 5 min elapsed with no action. Treat like dismiss.
 *   • backend-blocked / tier-blocked / misconfigured — preflight failures.
 *
 * The request blocks for up to 5 minutes while polling the request row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '@/db';
import { projects, userStripeIdentity } from '@/db/schema';
import { canUseStripeConnect } from '@/lib/tier';
import { isConnectOAuthConfigured } from '@/lib/stripe';
import {
  cancelPendingConnectRequests,
  createConnectRequest,
  mintStripeAuthorizeUrl,
  pollConnectRequest,
} from '@/lib/stripe-connect';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
// Stripe OAuth + user clicks easily fit within 5 minutes. Cap matches
// setupOAuthProvider for parity.
export const maxDuration = 300;

const POLL_DEADLINE_MS = 5 * 60 * 1000;

async function flipProjectEnabled(projectId: string, stripeWebhookSecret: string | null) {
  const db = getDb();
  const webhookSecret = stripeWebhookSecret ?? `bfws_${randomBytes(32).toString('hex')}`;
  await db
    .update(projects)
    .set({
      stripeEnabled: true,
      stripeWebhookSecret: webhookSecret,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
}

export async function POST(
  req: NextRequest,
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
          'This project has no backend. Stripe requires a Convex backend to receive webhook events and store billing state.',
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

  const mode = project.stripePaymentMode === 'live' ? 'live' : 'test';
  if (!isConnectOAuthConfigured(mode)) {
    return NextResponse.json(
      {
        ok: false,
        status: 'misconfigured',
        error: `Stripe Connect OAuth client_id for ${mode} mode is not configured on the server.`,
      },
      { status: 500 },
    );
  }

  // Already linked → flip project flag, done.
  const [identity] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, userId))
    .limit(1);
  const existingAccountId =
    identity && mode === 'live' ? identity.liveAccountId : identity?.testAccountId;
  if (existingAccountId) {
    await flipProjectEnabled(projectId, project.stripeWebhookSecret);
    return NextResponse.json({
      ok: true,
      status: 'already-connected',
      mode,
      accountId: existingAccountId,
      message:
        'The user has previously linked their Stripe account. This project is now enabled to use it.',
    });
  }

  // Not linked → open the modal + poll.
  await cancelPendingConnectRequests(projectId);
  const { state, authorizeUrl } = await mintStripeAuthorizeUrl({
    userId,
    projectId,
    mode,
    appOrigin: new URL(req.url).origin,
  });
  const { id: requestId } = await createConnectRequest({
    userId,
    projectId,
    mode,
    state,
    authorizeUrl,
  });

  const deadlineMs = Date.now() + POLL_DEADLINE_MS;
  const result = await pollConnectRequest({ requestId, projectId, deadlineMs });

  if (result === 'completed') {
    // Re-read identity (callback wrote the acct id).
    const [linked] = await db
      .select()
      .from(userStripeIdentity)
      .where(eq(userStripeIdentity.userId, userId))
      .limit(1);
    const accountId =
      linked && mode === 'live' ? linked.liveAccountId : linked?.testAccountId;
    // Flip project flag (and seed webhook secret if not already).
    await flipProjectEnabled(projectId, project.stripeWebhookSecret);
    return NextResponse.json({
      ok: true,
      status: 'connected',
      mode,
      accountId,
      message:
        'User completed Stripe OAuth. The project is enabled and the Stripe tab is now available in the workspace.',
    });
  }

  if (result === 'dismissed' || result === 'gone') {
    return NextResponse.json({
      ok: false,
      status: 'dismissed',
      message:
        'User declined to connect Stripe. The modal was dismissed and no account was linked. Do not retry automatically. Continue with the rest of the implementation and tell the user they can set up Stripe later from the workspace.',
    });
  }

  return NextResponse.json({
    ok: false,
    status: 'timeout',
    message:
      'Timed out waiting for the user to complete Stripe OAuth (5 minutes elapsed). The modal is no longer visible. Treat like a dismiss — do not retry.',
  });
}
