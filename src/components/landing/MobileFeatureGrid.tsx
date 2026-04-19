'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Feature = {
  icon: LucideIcon;
  title: string;
  description: string;
  shortTitle?: string;
};

const EASE = [0.43, 0.195, 0.02, 1] as const;

/**
 * MobileFeatureGrid — compact 2x3 glyph grid (mobile only).
 *
 * Shows just each feature's icon. Tapping a cell fills the grid area with
 * that feature's details; a bottom icon row lets the user jump between
 * features without going back to the grid.
 */
export function MobileFeatureGrid({ features }: { features: Feature[] }) {
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <div
      className="relative mx-auto w-full overflow-hidden border-y border-dashed border-[var(--sand-border)] shadow-[0_4px_24px_-16px_rgba(0,0,0,0.15)]"
      // className="relative mx-auto w-full overflow-hidden border-y border-dashed border-[var(--sand-border)] bg-[var(--sand-surface)] shadow-[0_4px_24px_-16px_rgba(0,0,0,0.15)]"
      style={{ aspectRatio: '3 / 4', maxWidth: 420 }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {selected === null ? (
          <motion.div
            key="grid"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="absolute inset-0 grid grid-cols-2 grid-rows-3"
          >
            {features.map((f, i) => (
              <GridCell
                key={f.title}
                feature={f}
                index={i}
                onSelect={() => setSelected(i)}
              />
            ))}
          </motion.div>
        ) : (
          <motion.div
            key="detail"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="absolute inset-0 flex flex-col p-6"
          >
            <DetailView
              features={features}
              selected={selected}
              onClose={() => setSelected(null)}
              onSelect={setSelected}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function GridCell({
  feature,
  index,
  onSelect,
}: {
  feature: Feature;
  index: number;
  onSelect: () => void;
}) {
  const Icon = feature.icon;
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05, ease: EASE }}
      className={cn(
        'group relative flex flex-col items-center justify-center gap-2.5 overflow-hidden px-2 py-4 transition-colors duration-300',
        'hover:bg-[var(--sand-elevated)] active:bg-[var(--sand-elevated)]',
        index % 2 === 0 && 'border-r border-dashed border-[var(--sand-border)]',
        index < 4 && 'border-b border-dashed border-[var(--sand-border)]',
      )}
      aria-label={feature.title}
    >
      {/* accent glow on hover */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(60% 60% at 50% 50%, color-mix(in oklab, var(--sand-accent) 10%, transparent), transparent 70%)',
        }}
      />
      <Icon
        strokeWidth={1.25}
        className="relative h-[120px] w-[120px] opacity-70 transition-all duration-300 group-hover:scale-[1.08] group-hover:text-[var(--sand-accent)] group-hover:opacity-100 group-active:scale-95"
      />
      <span className="relative text-[15px] font-semibold tracking-tight text-[var(--sand-text)] transition-colors duration-300 group-hover:text-[var(--sand-accent)]">
        {feature.shortTitle ?? feature.title}
      </span>
    </motion.button>
  );
}

function DetailView({
  features,
  selected,
  onClose,
  onSelect,
}: {
  features: Feature[];
  selected: number;
  onClose: () => void;
  onSelect: (i: number) => void;
}) {
  const f = features[selected];
  const Icon = f.icon;

  return (
    <>
      <button
        type="button"
        onClick={onClose}
        aria-label="Back to grid"
        className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-transparent text-[var(--sand-text-muted)] transition-colors hover:border-[var(--sand-border)] hover:bg-[var(--sand-elevated)] hover:text-[var(--sand-text)]"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Ghost glyph watermark — upper-left background asset */}
      <motion.div
        key={`ghost-${selected}`}
        initial={{ opacity: 0, scale: 0.92, x: -6, y: -6 }}
        animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
        transition={{ duration: 0.5, ease: EASE }}
        aria-hidden
        className="pointer-events-none absolute -left-8 -top-8 select-none"
      >
        {/* <Icon
          strokeWidth={1}
          style={{ width: 360, height: 360 }}
          className="text-[var(--sand-soft)] pl-5 pt-2.5 opacity-60"
        /> */}
      </motion.div>

      <motion.h3
        key={`title-${selected}`}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.08, ease: EASE }}
        className="relative z-10 mt-2 text-3xl font-semibold leading-tight tracking-tight"
      >
        {f.title}
      </motion.h3>

      <motion.p
        key={`desc-${selected}`}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.14, ease: EASE }}
        className="relative z-10 mt-4 text-[0.95rem] leading-relaxed text-[var(--sand-text-muted)]"
      >
        {f.description}
      </motion.p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.15, ease: EASE }}
        className="mt-auto flex items-center justify-between gap-2 pt-4"
      >
        <div className="flex items-center gap-1.5">
          {features.map((item, i) => {
            const ItemIcon = item.icon;
            const active = i === selected;
            return (
              <button
                key={item.title}
                type="button"
                onClick={() => onSelect(i)}
                aria-label={item.title}
                className={cn(
                  'flex h-9 w-9 items-center justify-center border border-dashed transition-all duration-200',
                  // 'flex h-9 w-9 items-center justify-center rounded-lg border transition-all duration-200',

                  active
                    ? 'border-[var(--sand-accent)] bg-[var(--sand-accent)] text-white shadow-sm'
                    : 'border-[var(--sand-border)] bg-[var(--sand-elevated)] text-[var(--sand-text-muted)] hover:border-[var(--sand-accent)]/40 hover:text-[var(--sand-accent)]',
                )}
              >
                <ItemIcon className="h-[14px] w-[14px]" />
              </button>
            );
          })}
        </div>
        <span className="font-mono text-[11px] tabular-nums text-[var(--sand-text-muted)]">
          {String(selected + 1).padStart(2, '0')}/{String(features.length).padStart(2, '0')}
        </span>
      </motion.div>
    </>
  );
}
