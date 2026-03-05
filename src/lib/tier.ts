/**
 * Tier detection and plan limits.
 *
 * Tiers: 'free' | 'pro' | 'max'
 *
 * Tier is read from Clerk user publicMetadata.plan.
 * All numeric limits are env-var driven so they can be tuned without a deploy.
 */

import { clerkClient } from '@clerk/nextjs/server';
import { redis } from './redis';

export type Tier = 'free' | 'pro' | 'max';

export interface TierLimits {
  tier: Tier;
  // Projects
  maxProjects: number;
  // Agent turns per day (server-side keys only; BYOK is unlimited)
  maxAgentTurnsPerDay: number;
  // Monthly credit budget in MiniMax-equivalent tokens
  monthlyCreditBudget: number;
  // Convex backends
  maxConvexProjects: number;
  // Cloudflare Pages live deployments
  maxCfPagesDeployments: number;
  // Screenshots per day
  maxScreenshotsPerDay: number;
  // Agent request timeout (seconds)
  maxAgentDurationSecs: number;
  // Whether to allow custom deploy domains
  customDomain: boolean;
}

// ─── Env-var helpers ──────────────────────────────────────────────────────────

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ─── Plan limit tables ────────────────────────────────────────────────────────

export function getLimitsForTier(tier: Tier): TierLimits {
  switch (tier) {
    case 'free':
      return {
        tier: 'free',
        maxProjects: 3,
        maxAgentTurnsPerDay: 0, // no daily turn cap — credit budget handles it
        monthlyCreditBudget: envInt('CREDITS_FREE_MONTHLY', 500_000),
        maxConvexProjects: 1,
        maxCfPagesDeployments: 1,
        maxScreenshotsPerDay: 5,
        maxAgentDurationSecs: 120,
        customDomain: false,
      };

    case 'pro':
      return {
        tier: 'pro',
        maxProjects: 15,
        maxAgentTurnsPerDay: 0,
        monthlyCreditBudget: envInt('CREDITS_PRO_MONTHLY', 10_000_000),
        maxConvexProjects: 3,
        maxCfPagesDeployments: 5,
        maxScreenshotsPerDay: 50,
        maxAgentDurationSecs: 240,
        customDomain: true,
      };

    case 'max':
      return {
        tier: 'max',
        maxProjects: Infinity,
        maxAgentTurnsPerDay: 0,
        monthlyCreditBudget: envInt('CREDITS_MAX_MONTHLY', 50_000_000),
        maxConvexProjects: 10,
        maxCfPagesDeployments: 20,
        maxScreenshotsPerDay: Infinity,
        maxAgentDurationSecs: 300,
        customDomain: true,
      };
  }
}

// ─── Tier detection ───────────────────────────────────────────────────────────

const TIER_CACHE_TTL = 300; // 5 minutes

export async function getUserTier(userId: string): Promise<Tier> {
  const cacheKey = `tier:${userId}`;

  const cached = await redis.get<string>(cacheKey);
  if (cached === 'free' || cached === 'pro' || cached === 'max') {
    return cached;
  }

  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const plan = (user.publicMetadata as Record<string, unknown>)?.plan as string | undefined;

  const tier: Tier =
    plan === 'pro' ? 'pro' :
    plan === 'max' ? 'max' :
    'free';

  await redis.setex(cacheKey, TIER_CACHE_TTL, tier);
  return tier;
}

/** Get tier + limits together (most callers need both) */
export async function getUserTierAndLimits(userId: string): Promise<TierLimits> {
  const tier = await getUserTier(userId);
  return getLimitsForTier(tier);
}

/** Invalidate the tier cache for a user (call after subscription change webhook) */
export async function invalidateTierCache(userId: string): Promise<void> {
  await redis.del(`tier:${userId}`);
}

// ─── Model → tier requirement ─────────────────────────────────────────────────

/** Which tier is required to use a model on server-side keys */
export const MODEL_TIER_REQUIREMENT: Record<string, Tier> = {
  'gpt-5.3-codex': 'free',          // BYOK/OAuth only
  'fireworks-minimax-m2p5': 'free',
  'fireworks-glm-5': 'free',         // Now available on free tier
  'claude-sonnet-4.6': 'pro',        // Requires Pro+
  'kimi-k2.5': 'free',               // BYOK only
  'claude-opus-4.6': 'pro',          // Requires Pro+
};

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, max: 2 };

export function tierMeetsRequirement(userTier: Tier, required: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[required];
}
