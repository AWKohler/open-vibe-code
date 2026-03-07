/**
 * Credit system — every model's token usage is converted to "MiniMax-equivalent" credits.
 * 1 credit = 1 uncached MiniMax input token equivalent ($0.30 / MTok base).
 *
 * Credits are calculated per token type (input, cached input, output, cache write)
 * using each model's actual pricing divided by the MiniMax base price.
 *
 * Monthly budgets are split into weekly slices (÷ 4) stored in Redis with an 8-day TTL.
 * Monthly totals are summed from usage_records.credits in Neon.
 */

import { redis } from './redis';
import { getDb } from '@/db';
import { usageRecords } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import type { ModelId } from './agent/models';
import type { Tier } from './tier';

// ─── Env-var helpers ──────────────────────────────────────────────────────────

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ─── Per-token-type credit rates (credits per token) ──────────────────────────
// Base unit: $0.30 / MTok (MiniMax uncached input price)
// Rate = model_price_per_MTok / 0.30

interface ModelPricing {
  input: number;         // credits per uncached input token
  cachedInput: number;   // credits per cached input token
  output: number;        // credits per output token
  cacheWrite?: number;   // credits per cache-write token (Anthropic only)
}

const BASE_PRICE = 0.30; // MiniMax input $/MTok — our credit base unit

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'fireworks-minimax-m2p5': {
    input:       0.30 / BASE_PRICE,   // 1.0
    cachedInput: 0.03 / BASE_PRICE,   // 0.1
    output:      1.20 / BASE_PRICE,   // 4.0
  },
  'fireworks-glm-5': {
    input:       1.00 / BASE_PRICE,   // 3.33
    cachedInput: 0.20 / BASE_PRICE,   // 0.67
    output:      3.20 / BASE_PRICE,   // 10.67
  },
  'gpt-5.3-codex': {
    input:       1.75 / BASE_PRICE,   // 5.83
    cachedInput: 0.175 / BASE_PRICE,  // 0.58
    output:      14.00 / BASE_PRICE,  // 46.67
  },
  // GPT-5.4 ≤272K context — the >272K tier is handled in calculateCredits()
  'gpt-5.4': {
    input:       2.50 / BASE_PRICE,   // 8.33
    cachedInput: 0.25 / BASE_PRICE,   // 0.83
    output:      15.00 / BASE_PRICE,  // 50.0
  },
  'claude-sonnet-4.6': {
    input:       3.00 / BASE_PRICE,   // 10.0
    cachedInput: 0.30 / BASE_PRICE,   // 1.0  (cache hit/refresh)
    output:      15.00 / BASE_PRICE,  // 50.0
    cacheWrite:  3.75 / BASE_PRICE,   // 12.5 (5-min ephemeral cache write)
  },
  'claude-opus-4.6': {
    input:       5.00 / BASE_PRICE,   // 16.67
    cachedInput: 0.50 / BASE_PRICE,   // 1.67 (cache hit/refresh)
    output:      25.00 / BASE_PRICE,  // 83.33
    cacheWrite:  6.25 / BASE_PRICE,   // 20.83 (5-min ephemeral cache write)
  },
};

// GPT-5.4 pricing at >272K context length
const GPT54_LONG_CONTEXT_PRICING: ModelPricing = {
  input:       5.00 / BASE_PRICE,   // 16.67
  cachedInput: 0.50 / BASE_PRICE,   // 1.67
  output:      22.50 / BASE_PRICE,  // 75.0
};

const GPT54_LONG_CONTEXT_THRESHOLD = 272_000;

/**
 * Rounded per-model cost multiplier for frontend display.
 * Shown in model selector dropdown to give users a sense of relative cost.
 */
export const MODEL_COST_MULTIPLIER: Record<ModelId, number> = {
  'fireworks-minimax-m2p5': 1,
  'fireworks-glm-5': 2,
  'gpt-5.3-codex': 4,
  'claude-sonnet-4.6': 5,
  'gpt-5.4': 6,
  'claude-opus-4.6': 10,
};

export interface CreditCalculationInput {
  model: ModelId;
  inputTokens: number;      // uncached input tokens (Anthropic: usage.inputTokens; OpenAI/FW: inputTokens - cachedRead)
  outputTokens: number;
  cachedReadTokens: number;  // tokens served from cache
  cacheWriteTokens: number;  // tokens written to cache (Anthropic only)
}

/**
 * Calculate credits for a completed request using per-token-type pricing.
 * This replaces the old flat-multiplier rawToCredits() function.
 */
export function calculateCredits(params: CreditCalculationInput): number {
  const { model, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens } = params;

  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Fallback: treat as MiniMax pricing
    pricing = MODEL_PRICING['fireworks-minimax-m2p5'];
  }

  // GPT-5.4: use higher pricing tier if total input context exceeds 272K
  if (model === 'gpt-5.4' && (inputTokens + cachedReadTokens) > GPT54_LONG_CONTEXT_THRESHOLD) {
    pricing = GPT54_LONG_CONTEXT_PRICING;
  }

  const inputCredits = inputTokens * pricing.input;
  const cachedCredits = cachedReadTokens * pricing.cachedInput;
  const outputCredits = outputTokens * pricing.output;
  const cacheWriteCredits = cacheWriteTokens * (pricing.cacheWrite ?? pricing.input);

  return Math.ceil(inputCredits + cachedCredits + outputCredits + cacheWriteCredits);
}

// ─── Legacy helper (kept for any remaining callers) ──────────────────────────

/** @deprecated Use calculateCredits() instead */
export function rawToCredits(tokens: number, model: ModelId): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['fireworks-minimax-m2p5'];
  // Approximate: treat all tokens as uncached input (overestimates — prefer calculateCredits)
  return Math.ceil(tokens * pricing.input);
}

// ─── Monthly limits by tier ───────────────────────────────────────────────────

export function getMonthlyLimit(tier: Tier): number {
  switch (tier) {
    case 'free': return envInt('CREDITS_FREE_MONTHLY', 2_000_000);
    case 'pro':  return envInt('CREDITS_PRO_MONTHLY', 40_000_000);
    case 'max':  return envInt('CREDITS_MAX_MONTHLY', 200_000_000);
  }
}

export function getWeeklyLimit(tier: Tier): number {
  return Math.floor(getMonthlyLimit(tier) / 4);
}

// ─── ISO week key (e.g. "2026-W10") ─────────────────────────────────────────

export function currentWeekKey(): string {
  const now = new Date();
  // ISO week: week containing Thursday of that week
  const thursday = new Date(now);
  thursday.setUTCDate(now.getUTCDate() + (4 - (now.getUTCDay() || 7)));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function weeklyRedisKey(userId: string): string {
  return `wcred:${userId}:${currentWeekKey()}`;
}

const WEEK_TTL = 8 * 24 * 3600; // 8 days

// ─── Redis: weekly credits ────────────────────────────────────────────────────

export async function getWeeklyCredits(userId: string): Promise<number> {
  const val = await redis.get<number>(weeklyRedisKey(userId));
  return val ?? 0;
}

export async function incrementWeeklyCredits(userId: string, credits: number): Promise<void> {
  const key = weeklyRedisKey(userId);
  const newVal = await redis.incrby(key, credits);
  if (newVal <= credits) {
    // First write this week — set TTL
    await redis.expire(key, WEEK_TTL);
  }
}

// ─── Neon: monthly credits ────────────────────────────────────────────────────

export function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function getMonthlyCredits(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(credits), 0)::bigint` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.userId, userId),
        eq(usageRecords.period, currentPeriod())
      )
    );
  return row?.total ?? 0;
}
