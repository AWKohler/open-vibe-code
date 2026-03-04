'use client';

import { X, Zap, ArrowRight } from 'lucide-react';

export interface LimitReachedPayload {
  error: 'limit_reached';
  limitType: string;
  current: number;
  limit: number;
  tier: 'free' | 'pro' | 'max';
  upgradeTarget: 'pro' | 'max' | null;
  model?: string | null;
  message: string;
}

interface Props {
  payload: LimitReachedPayload;
  onClose: () => void;
}

const TIER_NAMES: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
};

const TIER_PRICES: Record<string, string> = {
  pro: '$20 / month',
  max: '$60 / month',
};

const LIMIT_TYPE_ICONS: Record<string, string> = {
  project_count: '📁',
  agent_turns_daily: '⚡',
  token_budget: '🪙',
  convex_project_count: '⚙️',
  cf_pages_count: '🌐',
  screenshot_daily: '📸',
};

/** Parse a 402 API response body into a LimitReachedPayload, or null if not a limit error */
export function parseLimitPayload(body: unknown): LimitReachedPayload | null {
  if (
    body &&
    typeof body === 'object' &&
    (body as Record<string, unknown>).error === 'limit_reached'
  ) {
    return body as LimitReachedPayload;
  }
  return null;
}

export function LimitModal({ payload, onClose }: Props) {
  const { upgradeTarget, message, limitType, current, limit, tier } = payload;
  const icon = LIMIT_TYPE_ICONS[limitType] ?? '⚠️';
  const targetName = upgradeTarget ? TIER_NAMES[upgradeTarget] : null;
  const targetPrice = upgradeTarget ? TIER_PRICES[upgradeTarget] : null;

  const handleUpgrade = () => {
    // Open settings modal to subscription tab
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'subscription' } }));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-xl">
              {icon}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted">Limit reached</p>
              <p className="text-base font-semibold text-foreground">
                {TIER_NAMES[tier]} plan limit
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted transition hover:bg-elevated hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pb-4">
          <p className="text-sm text-muted">{message}</p>

          {/* Usage bar (only show when there's meaningful progress to show) */}
          {limit > 0 && current > 0 && (
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-xs text-muted">
                <span>{current.toLocaleString()} used</span>
                <span>{limit === Infinity ? '∞' : limit.toLocaleString()} limit</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-soft">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: limit === Infinity ? '0%' : `${Math.min((current / limit) * 100, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-6 pt-4">
          {upgradeTarget ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-accent/20 bg-accent/5 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      Upgrade to {targetName}
                    </p>
                    {targetPrice && (
                      <p className="text-xs text-muted">{targetPrice}</p>
                    )}
                  </div>
                  <Zap className="h-5 w-5 text-accent" />
                </div>
                <p className="mt-2 text-xs text-muted">
                  {upgradeTarget === 'pro'
                    ? 'Unlock more projects, server-side AI, and higher limits.'
                    : 'Unlock Sonnet, Opus, and the highest limits available.'}
                </p>
              </div>
              <button
                onClick={handleUpgrade}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
              >
                Upgrade now
                <ArrowRight className="h-4 w-4" />
              </button>
              <button
                onClick={onClose}
                className="text-center text-xs text-muted transition hover:text-foreground"
              >
                Maybe later
              </button>
            </div>
          ) : (
            <button
              onClick={onClose}
              className="w-full rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-soft"
            >
              Got it
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
