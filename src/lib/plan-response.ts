/**
 * Structured plan-limit response helpers.
 *
 * Every limit-hit response returns:
 * {
 *   error: "limit_reached",
 *   limitType: string,   // machine-readable
 *   current: number,
 *   limit: number,
 *   tier: Tier,
 *   upgradeTarget: Tier | null,
 *   message: string,     // human-readable
 * }
 */

import type { Tier } from './tier';

export type LimitType =
  | 'project_count'
  | 'agent_turns_daily'
  | 'token_budget'
  | 'convex_project_count'
  | 'cf_pages_count'
  | 'screenshot_daily';

interface LimitReachedOptions {
  limitType: LimitType;
  current: number;
  limit: number;
  tier: Tier;
  model?: string; // for token_budget
}

function upgradeTarget(tier: Tier): Tier | null {
  if (tier === 'free') return 'pro';
  if (tier === 'pro') return 'max';
  return null;
}

function humanMessage(opts: LimitReachedOptions): string {
  const target = upgradeTarget(opts.tier);
  const upgradeSuffix = target ? ` Upgrade to ${target.charAt(0).toUpperCase() + target.slice(1)} to continue.` : '';

  switch (opts.limitType) {
    case 'project_count':
      return `You've reached the ${opts.limit}-project limit on the ${opts.tier} plan.${upgradeSuffix}`;
    case 'agent_turns_daily':
      return `You've used all ${opts.limit} agent turns for today on the ${opts.tier} plan.${upgradeSuffix}`;
    case 'token_budget':
      return `You've exhausted your monthly ${opts.model ?? 'model'} token budget (${(opts.limit / 1_000_000).toFixed(1)}M tokens) on the ${opts.tier} plan.${upgradeSuffix}`;
    case 'convex_project_count':
      return `You've reached the ${opts.limit}-Convex-project limit on the ${opts.tier} plan.${upgradeSuffix}`;
    case 'cf_pages_count':
      return `You've reached the ${opts.limit}-deployment limit on the ${opts.tier} plan.${upgradeSuffix}`;
    case 'screenshot_daily':
      return `You've used all ${opts.limit} screenshots for today on the ${opts.tier} plan.${upgradeSuffix}`;
  }
}

export function limitReachedResponse(opts: LimitReachedOptions): Response {
  return Response.json(
    {
      error: 'limit_reached',
      limitType: opts.limitType,
      current: opts.current,
      limit: opts.limit,
      tier: opts.tier,
      upgradeTarget: upgradeTarget(opts.tier),
      model: opts.model ?? null,
      message: humanMessage(opts),
    },
    { status: 402 }
  );
}
