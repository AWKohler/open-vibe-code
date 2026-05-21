/**
 * Single source of truth for "should this request route to the Claude Code
 * agent instead of the regular /api/agent pipeline?"
 *
 * Activation requires ALL of:
 *   1. NEXT_PUBLIC_CLAUDE_CODE_ENABLED === 'true'
 *   2. Selected model is an Anthropic model
 *   3. Project platform is a Vercel-sandbox platform (sandboxed-web or swift) —
 *      WebContainer projects are explicitly out of scope.
 *   4. User has at least one Anthropic credential we can drive Claude Code with
 *      (an OAuth access token OR a BYOK API key).
 *
 * When any of those fail, callers fall back to the regular /api/agent flow.
 * That flow uses our server's ANTHROPIC_API_KEY for Anthropic models — so the
 * user still gets a working Claude experience, just without their personal
 * subscription / API key flowing through Claude Code.
 */
import { CLAUDE_CODE_ENABLED } from "@/lib/feature-flags";
import { isAnthropicModel, type ModelId } from "@/lib/agent/models";
import { isSandboxPlatform } from "@/lib/project-platform";

export interface ClaudeCodeCreds {
  /** Stored Claude OAuth access token (from /api/oauth/claude/exchange). */
  claudeOAuthAccessToken: string | null;
  /** BYOK Anthropic API key. */
  anthropicApiKey: string | null;
}

export function isClaudeCodeFlagEnabled(): boolean {
  return CLAUDE_CODE_ENABLED;
}

/**
 * Decide whether a given request should be routed through Claude Code.
 * Pure function — safe to call from both server and client (the client uses
 * it only to pick which API endpoint to hit; the server re-validates
 * authoritatively).
 */
export function shouldUseClaudeCode(input: {
  model: ModelId;
  platform: string | null | undefined;
  creds: ClaudeCodeCreds | null | undefined;
}): boolean {
  if (!CLAUDE_CODE_ENABLED) return false;
  if (!isAnthropicModel(input.model)) return false;
  if (!input.platform || !isSandboxPlatform(input.platform)) return false;

  // Need *something* the Claude Code subprocess can authenticate with.
  const hasOAuth = Boolean(input.creds?.claudeOAuthAccessToken);
  const hasApiKey = Boolean(input.creds?.anthropicApiKey);
  if (!hasOAuth && !hasApiKey) return false;

  return true;
}
