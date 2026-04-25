/**
 * Model configurations — token limits, provider mappings, display names.
 */

export type ModelId =
  | "gpt-5.3-codex"
  | "gpt-5.4"
  | "claude-sonnet-4-0"
  | "claude-opus-4-7"
  | "gemini-3.1-pro-preview"
  | "fireworks-minimax-m2p5"
  | "fireworks-glm-5p1"
  | "fireworks-kimi-k2p6";

export type Provider = "openai" | "anthropic" | "google" | "fireworks";

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
    displayName: "GPT-5.3",
    maxContextTokens: 400_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    provider: "openai",
    apiModelId: "gpt-5.4",
    displayName: "GPT-5.4",
    maxContextTokens: 400_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "claude-sonnet-4-0": {
    id: "claude-sonnet-4-0",
    provider: "anthropic",
    apiModelId: "claude-sonnet-4-0",
    displayName: "Claude Sonnet 4",
    maxContextTokens: 200_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "claude-opus-4-7": {
    id: "claude-opus-4-7",
    provider: "anthropic",
    apiModelId: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    maxContextTokens: 200_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    apiModelId: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    maxContextTokens: 1_000_000,
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
  // "fireworks-glm-5": {
  //   id: "fireworks-glm-5",
  //   provider: "fireworks",
  //   apiModelId: "accounts/fireworks/models/glm-5",
  //   displayName: "GLM-5",
  //   maxContextTokens: 202_800,
  //   warnThreshold: 0.7,
  //   criticalThreshold: 0.9,
  //   supportsImages: false,
  // },
  "fireworks-glm-5p1": {
    id: "fireworks-glm-5p1",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/glm-5p1",
    displayName: "GLM-5.1",
    maxContextTokens: 202_800,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: false,
  },
  "fireworks-kimi-k2p6": {
    id: "fireworks-kimi-k2p6",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/kimi-k2p6",
    displayName: "Kimi K2.6",
    maxContextTokens: 131_072,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: false,
  },
};

/** Resolve stored model value (handles legacy migrations) */
export function resolveModelId(stored: string | null | undefined): ModelId {
  if (stored === "claude-sonnet-4.5") return "claude-sonnet-4-0";
  if (stored === "claude-sonnet-4.6") return "claude-sonnet-4-0";
  if (stored === "claude-opus-4.5") return "claude-opus-4-7";
  if (stored === "claude-opus-4.6") return "claude-opus-4-7";
  if (stored === "claude-opus-4.7") return "claude-opus-4-7";
  if (stored === "claude-opus-4-1") return "claude-opus-4-7"; // legacy rename
  if (stored === "gpt-4.1") return "gpt-5.3-codex"; // migrate legacy
  if (stored === "gpt-5.2") return "gpt-5.3-codex"; // migrate legacy
  if (stored === "claude-haiku-4.5") return "claude-sonnet-4-0"; // removed model
  if (stored === "kimi-k2.5") return "fireworks-minimax-m2p5"; // removed model
  if (stored === "kimi-k2-thinking-turbo") return "fireworks-minimax-m2p5"; // removed model
  if (stored === "fireworks-glm-5") return "fireworks-glm-5p1"; // updated model
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

/** Check if a model uses the OpenAI provider */
export function isOpenAIModel(model: ModelId): boolean {
  return MODEL_CONFIGS[model].provider === "openai";
}

/** Get the provider key name needed in user settings */
export function getProviderKeyName(model: ModelId): string {
  const map: Record<Provider, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    fireworks: "Fireworks",
  };
  return map[MODEL_CONFIGS[model].provider];
}
