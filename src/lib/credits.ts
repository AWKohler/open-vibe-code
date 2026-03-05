/**
 * Credit system — every model's token usage is converted to "MiniMax-equivalent" credits.
 * MiniMax is the base unit (multiplier 1.0).
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

// ─── Model multipliers (raw tokens → MiniMax-equivalent credits) ──────────────

export const MODEL_MULTIPLIER: Partial<Record<ModelId, number>> = {
  'fireworks-minimax-m2p5': 1.0,
  'fireworks-glm-5': envFloat('CREDIT_MULTIPLIER_GLM5', 1.7),
  'gpt-5.3-codex': envFloat('CREDIT_MULTIPLIER_CODEX', 10.0),
  'claude-sonnet-4.6': envFloat('CREDIT_MULTIPLIER_SONNET', 10.0),
  'claude-opus-4.6': envFloat('CREDIT_MULTIPLIER_OPUS', 50.0),
  'kimi-k2.5': 1.0, // BYOK only — not on credit budget
};

export function rawToCredits(tokens: number, model: ModelId): number {
  const multiplier = MODEL_MULTIPLIER[model] ?? 1.0;
  return Math.ceil(tokens * multiplier);
}

// ─── Monthly limits by tier ───────────────────────────────────────────────────

export function getMonthlyLimit(tier: Tier): number {
  switch (tier) {
    case 'free': return envInt('CREDITS_FREE_MONTHLY', 500_000);
    case 'pro':  return envInt('CREDITS_PRO_MONTHLY', 10_000_000);
    case 'max':  return envInt('CREDITS_MAX_MONTHLY', 50_000_000);
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
