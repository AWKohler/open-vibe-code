/**
 * Shared auth + lookup for the platform's Stripe proxy endpoints.
 *
 * The Convex actions scaffolded into user projects call back to the platform
 * (e.g. /api/projects/[id]/stripe/checkout-session) with the project's
 * per-project HMAC secret in the X-Botflow-Project-Secret header. The
 * platform's master Stripe key never enters the sandbox; the proxy is the
 * only place that can act on behalf of a connected account.
 *
 * Each proxy endpoint funnels through `authProjectSecret` to:
 *   - constant-time compare the header against projects.stripe_webhook_secret
 *   - load the calling user's user_stripe_identity row
 *   - pick the active mode's acct_ id
 *
 * On any failure, returns { ok: false, status, body } so the caller can
 * NextResponse.json(body, { status }) directly.
 */
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, userStripeIdentity } from '@/db/schema';
import { isStripeConfigured, type StripeMode } from '@/lib/stripe';

export interface ProxyAuthSuccess {
  ok: true;
  project: typeof projects.$inferSelect;
  accountId: string;
  mode: StripeMode;
  userId: string;
}

export interface ProxyAuthFailure {
  ok: false;
  status: number;
  body: { ok: false; error: string };
}

function constantTimeEqual(a: string, b: string): boolean {
  // Same-length precondition for timingSafeEqual; pad with random data via
  // length comparison first to avoid leaking length via the throw path.
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function authProjectSecret(opts: {
  projectId: string;
  headerSecret: string | null;
  /** When set, force this mode instead of reading the project row. Used by webhook fan-out. */
  forceMode?: StripeMode;
}): Promise<ProxyAuthSuccess | ProxyAuthFailure> {
  const { projectId, headerSecret, forceMode } = opts;
  if (!headerSecret) {
    return {
      ok: false,
      status: 401,
      body: { ok: false, error: 'Missing X-Botflow-Project-Secret header' },
    };
  }
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return { ok: false, status: 404, body: { ok: false, error: 'Project not found' } };
  }
  if (!project.stripeWebhookSecret) {
    return {
      ok: false,
      status: 412,
      body: { ok: false, error: 'Project is not Stripe-enabled' },
    };
  }
  if (!constantTimeEqual(headerSecret, project.stripeWebhookSecret)) {
    return { ok: false, status: 403, body: { ok: false, error: 'Bad project secret' } };
  }
  const mode: StripeMode =
    forceMode ?? (project.stripePaymentMode === 'live' ? 'live' : 'test');
  if (!isStripeConfigured(mode)) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: `Stripe keys for ${mode} mode are not configured` },
    };
  }
  const [identity] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, project.userId))
    .limit(1);
  const accountId =
    identity && mode === 'live' ? identity.liveAccountId : identity?.testAccountId;
  if (!accountId) {
    return {
      ok: false,
      status: 412,
      body: {
        ok: false,
        error: `User has not linked a Stripe account for ${mode} mode`,
      },
    };
  }
  return { ok: true, project, accountId, mode, userId: project.userId };
}

