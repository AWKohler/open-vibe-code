/**
 * POST /api/projects/[id]/stripe/initialize
 *
 * Standard Connect via OAuth. There are three outcomes:
 *
 *   1. The user already has a Stripe account linked for the current mode.
 *      Flip projects.stripe_enabled = true and return already-connected.
 *
 *   2. The user has not yet linked their Stripe account. Return
 *      needs-connect + an authorizeUrl so the UI / modal can launch OAuth.
 *
 *   3. The project doesn't qualify (no backend, tier-blocked, flag off).
 *
 * No Stripe API call is made here — the heavy lift happens in
 * /api/stripe/oauth/callback after the user authorizes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '@/db';
import { projects, userStripeIdentity } from '@/db/schema';
import { canUseStripeConnect } from '@/lib/tier';
import { isConnectOAuthConfigured } from '@/lib/stripe';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

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
          'This project has no backend. Stripe requires a backend (Convex) to receive webhook events and store billing state.',
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

  // Does the caller already have a Stripe account linked for this mode?
  const [identity] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, userId))
    .limit(1);

  const existingAccountId =
    identity && mode === 'live' ? identity.liveAccountId : identity?.testAccountId;

  if (existingAccountId) {
    // Reuse: just opt this project in. We also generate the per-project
    // webhook HMAC if it hasn't been set yet.
    const webhookSecret =
      project.stripeWebhookSecret ?? `bfws_${randomBytes(32).toString('hex')}`;
    await db
      .update(projects)
      .set({
        stripeEnabled: true,
        stripeWebhookSecret: webhookSecret,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    return NextResponse.json({
      ok: true,
      status: 'already-connected',
      mode,
      accountId: existingAccountId,
      message:
        'Your Stripe account is already linked. This project is now enabled to use it.',
    });
  }

  // Not yet linked. Hand back an authorize URL the UI can launch.
  const origin = new URL(req.url).origin;
  const authorizeUrl = `${origin}/api/stripe/oauth/start?projectId=${encodeURIComponent(
    projectId,
  )}&mode=${mode}`;

  return NextResponse.json({
    ok: true,
    status: 'needs-connect',
    mode,
    authorizeUrl,
    message:
      'The user has not yet connected their Stripe account. They need to click "Connect with Stripe" and authorize through Stripe\'s site.',
  });
}
