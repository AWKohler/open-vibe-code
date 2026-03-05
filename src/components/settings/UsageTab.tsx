'use client';

import { useEffect, useState } from 'react';
import { CreditGauge } from '@/components/ui/CreditGauge';
import { Loader2 } from 'lucide-react';

interface ModelRow {
  model: string;
  credits: number;
  turns: number;
}

interface CreditsData {
  tier: string;
  weeklyUsed: number;
  weeklyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  pct: number;
  monthlyPct: number;
  models: ModelRow[];
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const MODEL_DISPLAY: Record<string, string> = {
  'fireworks-minimax-m2p5': 'MiniMax M2.5',
  'fireworks-glm-5': 'GLM-5',
  'claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'claude-opus-4.6': 'Claude Opus 4.6',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'kimi-k2.5': 'Kimi K2.5',
};

export function UsageTab() {
  const [data, setData] = useState<CreditsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch('/api/usage/credits')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="py-10 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted py-4">Could not load usage data.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Weekly gauge + stats */}
      <div className="flex items-center gap-8">
        <CreditGauge pct={data.pct} size="lg" />
        <div className="space-y-3 flex-1">
          <div>
            <p className="text-xs text-muted mb-1">Weekly credits</p>
            <p className="text-sm font-medium text-fg">
              {fmt(data.weeklyUsed)} <span className="text-muted font-normal">/ {fmt(data.weeklyLimit)}</span>
            </p>
            <div className="mt-1.5 h-1.5 rounded-full bg-soft overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${data.pct}%`,
                  backgroundColor: data.pct >= 80 ? '#ef4444' : data.pct >= 60 ? '#f59e0b' : '#22c55e',
                }}
              />
            </div>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Monthly credits</p>
            <p className="text-sm font-medium text-fg">
              {fmt(data.monthlyUsed)} <span className="text-muted font-normal">/ {fmt(data.monthlyLimit)}</span>
            </p>
            <div className="mt-1.5 h-1.5 rounded-full bg-soft overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${data.monthlyPct}%`,
                  backgroundColor: data.monthlyPct >= 80 ? '#ef4444' : data.monthlyPct >= 60 ? '#f59e0b' : '#22c55e',
                }}
              />
            </div>
          </div>
          <p className="text-xs text-muted">
            Plan: <span className="capitalize font-medium text-fg">{data.tier}</span>
            {' · '}Credits reset weekly (Mon) and monthly.
          </p>
        </div>
      </div>

      {/* Model breakdown */}
      {data.models.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">This month by model</h3>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted">Model</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Credits</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Turns</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((row, i) => (
                  <tr key={row.model} className={i < data.models.length - 1 ? 'border-b border-border' : ''}>
                    <td className="px-3 py-2 text-fg">
                      {MODEL_DISPLAY[row.model] ?? row.model}
                    </td>
                    <td className="px-3 py-2 text-right text-muted tabular-nums">{fmt(row.credits)}</td>
                    <td className="px-3 py-2 text-right text-muted tabular-nums">{row.turns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.models.length === 0 && (
        <p className="text-sm text-muted">No usage this month yet.</p>
      )}
    </div>
  );
}
