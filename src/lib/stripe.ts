/**
 * Stripe Connect (Express) — server-side platform client.
 *
 * Each Botflow project = one Express connected account per mode. The platform
 * holds two pairs of API keys (test + live); every call into Stripe goes
 * through these helpers so the keys never leak past this file.
 *
 * See drizzle/0017_add_stripe_integration.sql + src/db/schema.ts for the
 * data model, and AUTODEV.md's surrounding design notes for the rationale
 * (per-project marketplaces, KYC prefill across projects, 1% platform fee).
 */
import Stripe from 'stripe';

export type StripeMode = 'test' | 'live';

/** Platform application fee taken on every charge made by connected accounts. */
export const STRIPE_PLATFORM_FEE_PERCENT = Number(
  process.env.STRIPE_PLATFORM_FEE_PERCENT ?? '1'
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Set it in .env.local and the Vercel project settings.`
    );
  }
  return v;
}

const clients: Partial<Record<StripeMode, Stripe>> = {};

/** Get a platform Stripe client scoped to the given mode. Cached per process. */
export function getStripe(mode: StripeMode): Stripe {
  const cached = clients[mode];
  if (cached) return cached;
  // Live keys: accept either STRIPE_SECRET_KEY_LIVE (preferred) or the legacy
  // STRIPE_SECRET_KEY name that predates the multi-mode design.
  const key =
    mode === 'live'
      ? process.env.STRIPE_SECRET_KEY_LIVE ||
        requireEnv('STRIPE_SECRET_KEY')
      : requireEnv('STRIPE_SECRET_KEY_TEST');
  const client = new Stripe(key, {
    // Lock to a known-good API version so a future Stripe rollout doesn't
    // silently change shapes on us. Bump deliberately when validating a new
    // version.
    apiVersion: '2025-08-27.basil',
    typescript: true,
    appInfo: { name: 'Botflow', url: 'https://botflow.io' },
  });
  clients[mode] = client;
  return client;
}

/** Publishable key for embedding the Stripe.js SDK on the client side. */
export function getPublishableKey(mode: StripeMode): string {
  if (mode === 'live') {
    return (
      process.env.STRIPE_PUBLISHABLE_KEY_LIVE ||
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
      requireEnv('STRIPE_PUBLISHABLE_KEY_LIVE')
    );
  }
  return requireEnv('STRIPE_PUBLISHABLE_KEY_TEST');
}

/** Webhook signing secret for the platform-level Connect endpoint. */
export function getWebhookSecret(): string {
  return requireEnv('STRIPE_WEBHOOK_SECRET');
}

/** Connect OAuth client_id (`ca_…`) for the platform. Required to mint the
 *  authorize URL users visit at connect.stripe.com to link their Standard
 *  account. Test vs live mode use distinct client_ids configured separately
 *  in the Stripe dashboard. */
export function getConnectClientId(mode: StripeMode): string {
  return mode === 'live'
    ? requireEnv('STRIPE_CONNECT_CLIENT_ID_LIVE')
    : requireEnv('STRIPE_CONNECT_CLIENT_ID_TEST');
}

export function isConnectOAuthConfigured(mode: StripeMode): boolean {
  return Boolean(
    mode === 'live'
      ? process.env.STRIPE_CONNECT_CLIENT_ID_LIVE
      : process.env.STRIPE_CONNECT_CLIENT_ID_TEST,
  );
}

/** True when the platform has API keys configured for the given mode. */
export function isStripeConfigured(mode: StripeMode): boolean {
  return Boolean(
    mode === 'live'
      ? process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY
      : process.env.STRIPE_SECRET_KEY_TEST
  );
}
