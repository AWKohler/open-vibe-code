/**
 * POST /api/projects/[id]/stripe/dashboard-link
 *
 * Generates a one-time login link into the connected account's Stripe
 * Dashboard. Standard Connect supports stripe.accounts.createLoginLink
 * (Express/Custom do not — that's the embedded-components dashboard path).
 *
 * Auth: X-Botflow-Project-Secret matches projects.stripe_webhook_secret.
 *
 * Returns: { url } — a short-lived URL the caller should open in a new tab.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authProjectSecret } from '@/lib/stripe-proxy-auth';
import { getStripe } from '@/lib/stripe';
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
  const { id: projectId } = await params;

  const auth = await authProjectSecret({
    projectId,
    headerSecret: req.headers.get('x-botflow-project-secret'),
  });
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const stripe = getStripe(auth.mode);
  try {
    const link = await stripe.accounts.createLoginLink(auth.accountId);
    return NextResponse.json({ url: link.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/dashboard-link] threw:', err);
    return NextResponse.json(
      { ok: false, error: `Stripe login link failed: ${message}` },
      { status: 502 },
    );
  }
}
