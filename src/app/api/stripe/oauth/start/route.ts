/**
 * GET /api/stripe/oauth/start?projectId=…&mode=test|live
 *
 * Mints the connect.stripe.com authorize URL the user visits to link their
 * Standard Stripe account to Botflow. Stores a short-lived state token that
 * binds the callback to this user+project+mode and prevents CSRF.
 *
 * Returns JSON { authorizeUrl }. The agent tool wraps this; the modal opens
 * the URL in a popup. On success, the callback redirects back into the
 * workspace.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '@/db';
import { projects, stripeOauthStates } from '@/db/schema';
import { canUseStripeConnect } from '@/lib/tier';
import {
  getConnectClientId,
  isConnectOAuthConfigured,
  type StripeMode,
} from '@/lib/stripe';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
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

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  const modeParam = url.searchParams.get('mode') ?? 'test';
  if (!projectId) {
    return NextResponse.json({ ok: false, error: 'projectId required' }, { status: 400 });
  }
  const mode: StripeMode = modeParam === 'live' ? 'live' : 'test';

  if (!isConnectOAuthConfigured(mode)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Stripe Connect OAuth client_id for ${mode} mode is not configured. Set STRIPE_CONNECT_CLIENT_ID_${mode.toUpperCase()} in the Vercel project env.`,
      },
      { status: 500 },
    );
  }

  const db = getDb();
  const [project] = await db
    .select({ id: projects.id, userId: projects.userId, backendType: projects.backendType })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }
  if (project.backendType === 'none') {
    return NextResponse.json(
      { ok: false, error: 'Stripe requires a backend project (Convex).' },
      { status: 400 },
    );
  }

  const gate = await canUseStripeConnect(userId);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, error: gate.reason, tier: gate.tier },
      { status: 402 },
    );
  }

  const state = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000);
  await db.insert(stripeOauthStates).values({
    state,
    userId,
    projectId,
    mode,
    createdAt: now,
    expiresAt,
  });

  const clientId = getConnectClientId(mode);
  const redirectUri = `${url.origin}/api/stripe/oauth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_write',
    redirect_uri: redirectUri,
    state,
    // 'stripe_user[email]' would be a nice prefill but we don't reliably know
    // the user's preferred Stripe email here. Skip — Stripe lets them type it.
  });
  const authorizeUrl = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;

  return NextResponse.json({ ok: true, authorizeUrl, state, mode });
}
