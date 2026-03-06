/**
 * Model configurations — token limits, provider mappings, display names.
 */

export type ModelId =
  | "gpt-5.3-codex"
  | "claude-sonnet-4.6"
  | "claude-haiku-4.5"
  | "claude-opus-4.6"
  | "kimi-k2.5"
  | "fireworks-minimax-m2p5"
  | "fireworks-glm-5";

export type Provider = "openai" | "anthropic" | "moonshot" | "fireworks";

export interface ModelConfig {
  id: ModelId;
  provider: Provider;
  /** Provider-specific model identifier for API calls */
  apiModelId: string;
  /** Display name for the UI */
  displayName: string;
  /** Max context window in tokens */
  maxContextTokens: number;
  /** Warn at this percentage of max context */
  warnThreshold: number;
  /** Critical at this percentage of max context */
  criticalThreshold: number;
  /** Whether this model supports image/file inputs */
  supportsImages: boolean;
}

export const MODEL_CONFIGS: Record<ModelId, ModelConfig> = {
  "gpt-5.3-codex": {
    id: "gpt-5.3-codex",
    provider: "openai",
    apiModelId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    maxContextTokens: 400_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "claude-sonnet-4.6": {
    id: "claude-sonnet-4.6",
    provider: "anthropic",
    apiModelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    maxContextTokens: 200_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "claude-haiku-4.5": {
    id: "claude-haiku-4.5",
    provider: "anthropic",
    apiModelId: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    maxContextTokens: 200_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "claude-opus-4.6": {
    id: "claude-opus-4.6",
    provider: "anthropic",
    apiModelId: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    maxContextTokens: 200_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "kimi-k2.5": {
    id: "kimi-k2.5",
    provider: "moonshot",
    apiModelId: "kimi-k2.5",
    displayName: "Kimi K2.5",
    maxContextTokens: 64_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "fireworks-minimax-m2p5": {
    id: "fireworks-minimax-m2p5",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/minimax-m2p5",
    displayName: "MiniMax-M2.5",
    maxContextTokens: 32_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: false,
  },
  "fireworks-glm-5": {
    id: "fireworks-glm-5",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/glm-5",
    displayName: "GLM-5",
    maxContextTokens: 202_800,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: false,
  },
};

/** Resolve stored model value (handles legacy migrations) */
export function resolveModelId(stored: string | null | undefined): ModelId {
  if (stored === "claude-sonnet-4.5") return "claude-sonnet-4.6";
  if (stored === "claude-opus-4.5") return "claude-opus-4.6";
  if (stored === "gpt-4.1") return "gpt-5.3-codex"; // migrate legacy
  if (stored === "gpt-5.2") return "gpt-5.3-codex"; // migrate legacy
  if (stored === "kimi-k2-thinking-turbo") return "kimi-k2.5"; // migrate legacy
  if (stored && stored in MODEL_CONFIGS) return stored as ModelId;
  return "gpt-5.3-codex";
}

/** Check if a model supports image/file inputs */
export function modelSupportsImages(model: ModelId): boolean {
  return MODEL_CONFIGS[model].supportsImages;
}

/** Check if a model uses the Anthropic provider */
export function isAnthropicModel(model: ModelId): boolean {
  return MODEL_CONFIGS[model].provider === "anthropic";
}

/** Get the provider key name needed in user settings */
export function getProviderKeyName(model: ModelId): string {
  const map: Record<Provider, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    moonshot: "Moonshot",
    fireworks: "Fireworks",
  };
  return map[MODEL_CONFIGS[model].provider];
}
