/**
 * Agent backend resolution.
 *
 * Decides which agent backend(s) a given user can use for a given model on a
 * given project platform. Single source of truth shared by:
 *   - AgentPanel (to show/hide the chip + lock to a backend)
 *   - /api/agent/claude-code (to validate the user's pick at request time)
 *   - Project creation (to pre-set agent_backend based on creds)
 *
 * Constraint matrix (for Anthropic models on a sandbox platform):
 *
 *   Creds              │ Available backends         │ Notes
 *   ───────────────────┼────────────────────────────┼─────────────────────────
 *   OAuth only         │ ['claude-code']            │ ToS — OAuth tokens MUST
 *                      │                            │ flow through claude.
 *   OAuth + BYOK       │ ['claude-code']            │ OAuth wins (cheaper).
 *                      │                            │ BYOK is a silent fallback
 *                      │                            │ if Claude Code is broken.
 *   BYOK only          │ ['botflow', 'claude-code'] │ User can pick.
 *   Nothing            │ ['botflow']                │ Platform key stays on
 *                      │                            │ our server; sandbox env
 *                      │                            │ is unsafe.
 *
 * For non-Anthropic models, Claude Code is never available (it only runs
 * Anthropic models). Always ['botflow'].
 *
 * For WebContainer projects, Claude Code is never available — the sandbox it
 * needs to run in doesn't exist. Always ['botflow'].
 *
 * When the feature flag is off, Claude Code is never available. Always
 * ['botflow'].
 */
import { CLAUDE_CODE_ENABLED } from "@/lib/feature-flags";
import { isAnthropicModel, type ModelId } from "@/lib/agent/models";
import { isSandboxPlatform } from "@/lib/project-platform";

export type AgentBackend = "botflow" | "claude-code";

export interface BackendCreds {
  /** Whether the user has a working Claude OAuth access token. */
  hasClaudeOAuth: boolean;
  /** Whether the user has a BYOK Anthropic API key on file. */
  hasAnthropicKey: boolean;
}

export interface BackendResolutionInput {
  model: ModelId;
  platform: string | null | undefined;
  creds: BackendCreds;
}

export interface BackendResolution {
  /** Backends the user CAN pick for this combination. Always non-empty. */
  available: AgentBackend[];
  /**
   * The single backend the user MUST use, if any. When this is set the chip
   * should be displayed as an info badge with no toggle. When null, the user
   * has a choice (or there's only one option but it's the default Botflow).
   */
  locked: AgentBackend | null;
  /** Recommended default when the user has no prior preference. */
  defaultBackend: AgentBackend;
  /** Why this resolution exists — useful for the "What this means" popover. */
  reason: ResolutionReason;
}

export type ResolutionReason =
  /** Claude Code is disabled platform-wide via env flag. */
  | "flag_disabled"
  /** Platform doesn't support Claude Code (WebContainer). */
  | "non_sandbox_platform"
  /** Model isn't Anthropic; Claude Code doesn't apply. */
  | "non_anthropic_model"
  /** User signed in with Claude — OAuth flows MUST use Claude Code. */
  | "oauth_required"
  /** User has BYOK only; both backends work but defaults to Botflow. */
  | "byok_choice"
  /** No Anthropic creds at all; falls back to Botflow + platform key. */
  | "platform_key_only";

export function resolveBackends(input: BackendResolutionInput): BackendResolution {
  const { model, platform, creds } = input;

  // Hard rule #1: feature flag off → Botflow universally.
  if (!CLAUDE_CODE_ENABLED) {
    return {
      available: ["botflow"],
      locked: "botflow",
      defaultBackend: "botflow",
      reason: "flag_disabled",
    };
  }

  // Hard rule #2: Claude Code only runs Anthropic models.
  if (!isAnthropicModel(model)) {
    return {
      available: ["botflow"],
      locked: "botflow",
      defaultBackend: "botflow",
      reason: "non_anthropic_model",
    };
  }

  // Hard rule #3: Claude Code needs a sandbox platform.
  if (!platform || !isSandboxPlatform(platform)) {
    return {
      available: ["botflow"],
      locked: "botflow",
      defaultBackend: "botflow",
      reason: "non_sandbox_platform",
    };
  }

  // From here, model is Anthropic AND platform is a sandbox.
  // Choice depends on which credentials the user has.

  if (creds.hasClaudeOAuth) {
    // OAuth flows MUST go through Claude Code per Anthropic's ToS. We accept
    // BYOK as a hidden fallback if Claude Code itself fails, but the user is
    // locked to Claude Code from a UI perspective.
    return {
      available: ["claude-code"],
      locked: "claude-code",
      defaultBackend: "claude-code",
      reason: "oauth_required",
    };
  }

  if (creds.hasAnthropicKey) {
    // BYOK: both backends work; user can pick. Default is Botflow because
    // it's simpler / no install latency.
    return {
      available: ["botflow", "claude-code"],
      locked: null,
      defaultBackend: "botflow",
      reason: "byok_choice",
    };
  }

  // No Anthropic creds. Falls through to Botflow + platform key. We
  // CANNOT use Claude Code here — passing our platform key into the
  // sandbox env exposes it to the user/agent.
  return {
    available: ["botflow"],
    locked: "botflow",
    defaultBackend: "botflow",
    reason: "platform_key_only",
  };
}

/**
 * Decide the backend to use for a request, given the project's persisted
 * `agent_backend` setting and the user's current creds. If the persisted
 * setting is no longer available (e.g. user signed out of Claude OAuth),
 * coerce to the recommended default + return a flag.
 */
export function resolveActiveBackend(input: {
  projectBackend: string;
  model: ModelId;
  platform: string | null | undefined;
  creds: BackendCreds;
}): { backend: AgentBackend; resolution: BackendResolution; coerced: boolean } {
  const resolution = resolveBackends({
    model: input.model,
    platform: input.platform,
    creds: input.creds,
  });
  const persisted = input.projectBackend as AgentBackend;
  if (resolution.available.includes(persisted)) {
    return { backend: persisted, resolution, coerced: false };
  }
  return { backend: resolution.defaultBackend, resolution, coerced: true };
}

export function isAgentBackend(value: string): value is AgentBackend {
  return value === "botflow" || value === "claude-code";
}
