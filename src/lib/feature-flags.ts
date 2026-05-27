/**
 * Feature flags — controlled via environment variables.
 * NEXT_PUBLIC_ prefix makes them available in both server and client code.
 */

/** When false: Anthropic OAuth CTAs are hidden, existing OAuth tokens are ignored,
 *  and Claude models require a BYOK API key or Pro server key. */
export const ANTHROPIC_OAUTH_ENABLED =
  process.env.NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED === 'true';

/** When true: Anthropic models on sandbox platforms (swift, sandboxed-web) are
 *  driven via a Claude Code subprocess running inside the Vercel Sandbox. The
 *  user's OAuth tokens are written into the sandbox's ~/.claude/.credentials.json
 *  and the official Anthropic Agent SDK orchestrates the session. When false,
 *  all models — including Anthropic ones — go through the regular /api/agent
 *  pipeline. Mirrors T3Code's approach so the user's Pro/Max subscription is
 *  consumed by the official Claude Code client, not by us. */
export const CLAUDE_CODE_ENABLED =
  process.env.NEXT_PUBLIC_CLAUDE_CODE_ENABLED === 'true';

/** When true: the Stripe Connect integration is exposed — the
 *  `initializeStripePayments` AI tool is registered, the Stripe tab can
 *  appear in workspaces, and the proxy endpoints accept requests. When
 *  false: all of those are hidden / refuse. Default off until the slice
 *  is verified end-to-end on botflow.io. */
export const STRIPE_CONNECT_ENABLED =
  process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED === 'true';
