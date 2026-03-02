'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { MODEL_CONFIGS, type ModelId } from '@/lib/agent/models';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';

export interface ModelSelectorProps {
  value: ModelId;
  onChange: (model: ModelId) => void;
  providerAccess: Record<string, boolean | null>; // provider → has credentials
  size?: 'sm' | 'md';
  className?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  moonshot: 'Moonshot',
  fireworks: 'Fireworks',
};

function formatContextSize(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

const MODEL_ORDER: ModelId[] = [
  'gpt-5.3-codex',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
  'claude-opus-4.6',
  'kimi-k2-thinking-turbo',
  'fireworks-minimax-m2p5',
  'fireworks-glm-5',
];

export function ModelSelector({ value, onChange, providerAccess, size = 'md', className }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const currentConfig = MODEL_CONFIGS[value];

  const handleSelect = useCallback((modelId: ModelId) => {
    const config = MODEL_CONFIGS[modelId];
    const hasAccess = providerAccess[config.provider];
    if (hasAccess === false) {
      toast({
        title: 'Missing API key',
        description: `Please add your ${PROVIDER_LABELS[config.provider]} credentials in Settings.`,
      });
      return;
    }
    onChange(modelId);
    setOpen(false);
  }, [onChange, providerAccess, toast]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const isSm = size === 'sm';

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 border transition',
          isSm
            ? 'bg-elevated border-border rounded-md px-2 py-1 text-xs text-muted'
            : 'pointer-events-auto rounded-full border-border bg-elevated px-3 py-1.5 text-sm font-medium text-[var(--sand-text)] shadow-sm shadow-soft hover:border-transparent hover:bg-accent/15',
        )}
      >
        <span>{currentConfig.displayName}</span>
        <ChevronDown className={cn(isSm ? 'h-3 w-3' : 'h-3.5 w-3.5', 'opacity-50')} />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 min-w-[260px] rounded-xl border border-border bg-surface shadow-lg overflow-hidden',
            isSm ? 'right-0' : 'left-0',
          )}
        >
          {MODEL_ORDER.map((modelId) => {
            const config = MODEL_CONFIGS[modelId];
            const hasAccess = providerAccess[config.provider];
            const isInaccessible = hasAccess === false;
            const isSelected = modelId === value;

            return (
              <button
                key={modelId}
                type="button"
                onClick={() => handleSelect(modelId)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2.5 text-left transition',
                  isSelected ? 'bg-elevated' : 'hover:bg-elevated/60',
                  isInaccessible && 'opacity-40',
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn('text-sm font-medium', isSelected ? 'text-foreground' : 'text-foreground')}>
                      {config.displayName}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-soft px-1.5 py-0.5 text-[10px] font-medium text-muted">
                      {PROVIDER_LABELS[config.provider]}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">
                    {formatContextSize(config.maxContextTokens)} context
                  </div>
                </div>
                {isInaccessible && (
                  <div className="flex items-center gap-1 text-muted">
                    <Lock className="h-3 w-3" />
                    <span className="text-[10px]">no key</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
