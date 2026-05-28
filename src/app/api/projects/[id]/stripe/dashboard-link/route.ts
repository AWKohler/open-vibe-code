/**
 * POST /api/projects/[id]/stripe/dashboard-link
 *
 * Returns a URL into the connected account's Stripe Dashboard. Botflow uses
 * Standard Connect, so the account holder has their OWN dashboard at
 * dashboard.stripe.com — `stripe.accounts.createLoginLink` is Express-only
 * and would 400 here. We construct the canonical deep-link URL instead:
 *   test: https://dashboard.stripe.com/test/{acct_id}
 *   live: https://dashboard.stripe.com/{acct_id}
 * If the user is signed into Stripe in the browser, they land directly on
 * that account's view. Otherwise Stripe prompts for sign-in first.
 *
 * Auth: X-Botflow-Project-Secret matches projects.stripe_webhook_secret.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authProjectSecret } from '@/lib/stripe-proxy-auth';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 10;

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
  const { id: projectId } = await params;

  const auth = await authProjectSecret({
    projectId,
    headerSecret: req.headers.get('x-botflow-project-secret'),
  });
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const segment = auth.mode === 'live' ? '' : '/test';
  const url = `https://dashboard.stripe.com${segment}/${auth.accountId}`;
  return NextResponse.json({ url, mode: auth.mode });
}
