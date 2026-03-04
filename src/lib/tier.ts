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
  // Monthly token budgets per model (0 = not available on server key)
  tokenBudgets: Partial<Record<string, number>>;
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
        maxAgentTurnsPerDay: 0, // BYOK only — no server-side budget
        tokenBudgets: {
          // MiniMax is the free-tier server-side model
          'fireworks-minimax-m2p5': envInt('TIER_FREE_MINIMAX_TOKEN_BUDGET', 500_000),
        },
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
        maxAgentTurnsPerDay: 100,
        tokenBudgets: {
          'claude-haiku-4.5': envInt('TIER_PRO_HAIKU_TOKEN_BUDGET', 10_000_000),
          'fireworks-glm-5': envInt('TIER_PRO_GLM5_TOKEN_BUDGET', 10_000_000),
          // Sonnet available via BYOK or Haiku budget (server key uses Haiku)
        },
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
        maxAgentTurnsPerDay: 500,
        tokenBudgets: {
          'claude-haiku-4.5': envInt('TIER_PRO_HAIKU_TOKEN_BUDGET', 10_000_000), // also gets haiku
          'claude-sonnet-4.6': envInt('TIER_MAX_SONNET_TOKEN_BUDGET', 5_000_000),
          'claude-opus-4.6': envInt('TIER_MAX_OPUS_TOKEN_BUDGET', 5_000_000),
          'fireworks-glm-5': envInt('TIER_PRO_GLM5_TOKEN_BUDGET', 10_000_000),
          'fireworks-minimax-m2p5': envInt('TIER_FREE_MINIMAX_TOKEN_BUDGET', 500_000),
        },
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
  'gpt-5.3-codex': 'free',       // BYOK/OAuth only
  'fireworks-minimax-m2p5': 'free',
  'claude-haiku-4.5': 'pro',
  'fireworks-glm-5': 'pro',
  'claude-sonnet-4.6': 'max',
  'kimi-k2.5': 'free',            // BYOK only
  'claude-opus-4.6': 'max',
};

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, max: 2 };

export function tierMeetsRequirement(userTier: Tier, required: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[required];
}
