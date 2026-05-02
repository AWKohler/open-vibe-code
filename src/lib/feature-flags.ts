/**
 * Feature flags — controlled via environment variables.
 * NEXT_PUBLIC_ prefix makes them available in both server and client code.
 */

/** When false: Anthropic OAuth CTAs are hidden, existing OAuth tokens are ignored,
 *  and Claude models require a BYOK API key or Pro server key. */
export const ANTHROPIC_OAUTH_ENABLED =
  process.env.NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED === 'true';
