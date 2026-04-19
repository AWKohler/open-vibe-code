'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * CardSpotlight — subtle mouse-tracking spotlight overlay for cards.
 *
 * Drop as a child of a `group relative` card. It attaches a mousemove listener
 * to its parent and paints a soft accent-tinted radial gradient at the cursor,
 * layered over a faint dotted pattern. Both only appear on hover.
 *
 * Uses CSS variables (--sand-accent) so it tracks light/dark themes.
 */
export function CardSpotlight({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const onMove = (e: MouseEvent) => {
      const rect = parent.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      el.style.setProperty('--my', `${e.clientY - rect.top}px`);
    };
    parent.addEventListener('mousemove', onMove);
    return () => parent.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] opacity-0 transition-opacity duration-500 group-hover:opacity-100',
        className,
      )}
      style={{
        ['--mx' as string]: '50%',
        ['--my' as string]: '50%',
      }}
    >
      {/* Dotted pattern, masked so only the area near the cursor shows */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--sand-accent) 55%, transparent) 1px, transparent 0)',
          backgroundSize: '14px 14px',
          WebkitMaskImage:
            'radial-gradient(220px circle at var(--mx) var(--my), black 0%, transparent 70%)',
          maskImage:
            'radial-gradient(220px circle at var(--mx) var(--my), black 0%, transparent 70%)',
          opacity: 0.35,
        }}
      />

      {/* Soft accent glow following the cursor */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(360px circle at var(--mx) var(--my), color-mix(in oklab, var(--sand-accent) 10%, transparent), transparent 65%)',
        }}
      />
    </div>
  );
}
