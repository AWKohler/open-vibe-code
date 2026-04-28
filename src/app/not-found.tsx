import Link from 'next/link';
import { ArrowRight, Compass } from 'lucide-react';
import {
  EditorialGrid,
  LandingFooter,
  LandingNav,
  LineDivider,
  Reveal,
  SectionLabel,
  serif,
} from '@/components/landing/shared';
import { cn } from '@/lib/utils';

export const metadata = {
  title: 'Page not found',
  description:
    "The page you're looking for has wandered off. Head back to Botflow or explore what others are building.",
};

export default function NotFound() {
  return (
    <div className="antialiased text-[var(--sand-text)] bg-[var(--sand-bg)] min-h-screen flex flex-col">
      <EditorialGrid />
      <LandingNav />

      {/* ================================================================ */}
      {/* HERO 404                                                         */}
      {/* ================================================================ */}
      <section className="relative flex-1 overflow-hidden hero-grid">
        {/* Soft accent halo behind the numerals */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div
            className="h-[40vmin] w-[40vmin] sm:h-[50vmin] sm:w-[50vmin] rounded-full blur-3xl opacity-40"
            style={{
              background:
                'radial-gradient(circle at center, color-mix(in oklab, var(--sand-accent) 35%, transparent) 0%, transparent 70%)',
            }}
          />
        </div>

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 pt-12 sm:pt-20 pb-16 sm:pb-24">
          <div className="mx-auto max-w-3xl text-center flex flex-col items-center">
            {/* Tracked label */}
            <Reveal>
              <div className="flex items-center justify-center gap-3 mb-2">
                <span
                  aria-hidden
                  className="h-px w-8 sm:w-12"
                  style={{ background: 'var(--sand-border)' }}
                />
                <SectionLabel>Error · Off the map</SectionLabel>
                <span
                  aria-hidden
                  className="h-px w-8 sm:w-12"
                  style={{ background: 'var(--sand-border)' }}
                />
              </div>
            </Reveal>

            {/* The 404 — center, oversized, serif */}
            <Reveal delay={120}>
              <h1
                aria-label="404"
                className={cn(
                  serif.className,
                  'select-none leading-none tracking-tight',
                  'text-[28vw] sm:text-[22vw] md:text-[18rem] lg:text-[20rem]',
                )}
                style={{ lineHeight: 0.9 }}
              >
                <span className="inline-flex items-baseline">
                  <span className="numeral-fade">4</span>
                  <span className="numeral-orbit relative inline-block align-baseline">
                    <span style={{ color: 'var(--sand-accent)' }}>0</span>
                    {/* subtle orbiting dot inside the zero */}
                    <span
                      aria-hidden
                      className="orbit-dot absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                    >
                      <span
                        className="block h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full"
                        style={{ background: 'var(--sand-accent)' }}
                      />
                    </span>
                  </span>
                  <span className="numeral-fade">4</span>
                </span>
              </h1>
            </Reveal>

            {/* Italic serif tagline echoing the hero pattern */}
            <Reveal delay={220}>
              <h2
                className={cn(
                  serif.className,
                  'mt-6 sm:mt-8 text-3xl sm:text-4xl md:text-5xl tracking-tight leading-[1.1]',
                )}
              >
                You&apos;ve wandered{' '}
                <span className="relative inline-block italic">
                  off the path
                  <span
                    aria-hidden
                    className="absolute -bottom-1 left-0 right-0 h-[3px] rounded-full origin-center underline-grow"
                    style={{
                      background: 'var(--sand-accent)',
                      opacity: 0.5,
                    }}
                  />
                </span>
                .
              </h2>
            </Reveal>

            {/* Muted description */}
            <Reveal delay={300}>
              <p className="mt-5 sm:mt-6 text-base sm:text-lg text-[var(--sand-text-muted)] max-w-xl mx-auto leading-relaxed">
                We couldn&apos;t find the page you were looking for. It may have
                moved, been renamed, or never existed in the first place.
              </p>
            </Reveal>

            {/* CTAs */}
            <Reveal delay={400}>
              <div className="mt-8 sm:mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link
                  href="/"
                  className="group relative inline-flex items-center gap-2 rounded-xl bg-[var(--sand-text)] text-[var(--sand-bg)] px-5 py-3 text-sm sm:text-base font-medium shadow-md hover:opacity-90 transition"
                >
                  Take me home
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
                </Link>
                <Link
                  href="/explore"
                  className="group inline-flex items-center gap-2 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-5 py-3 text-sm sm:text-base font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
                >
                  <Compass className="h-4 w-4 text-[var(--sand-text-muted)] group-hover:text-[var(--sand-accent)] transition" />
                  Explore community projects
                </Link>
              </div>
            </Reveal>

            {/* Quiet quick-links — like a sitemap footnote */}
            <Reveal delay={500}>
              <div className="mt-10 sm:mt-14 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-2 text-xs sm:text-sm text-[var(--sand-text-muted)]">
                <span className="uppercase tracking-[0.18em] mr-2 opacity-70">
                  Try
                </span>
                <QuickLink href="/projects">Projects</QuickLink>
                <Dot />
                <QuickLink href="/pricing">Pricing</QuickLink>
                <Dot />
                <QuickLink href="/blog">Blog</QuickLink>
                <Dot />
                <QuickLink href="/convex">Convex</QuickLink>
                <Dot />
                <QuickLink href="/explore">Explore</QuickLink>
              </div>
            </Reveal>
          </div>
        </div>

        {/* Local keyframes — scoped via plain <style> */}
        <style>{`
          @keyframes underlineGrow {
            from { transform: scaleX(0); }
            to { transform: scaleX(1); }
          }
          .underline-grow {
            transform: scaleX(0);
            animation: underlineGrow 0.9s cubic-bezier(0.5, 0, 0, 1) 0.7s forwards;
          }

          @keyframes orbit {
            from { transform: translate(-50%, -50%) rotate(0deg) translateX(0.42em) rotate(0deg); }
            to   { transform: translate(-50%, -50%) rotate(360deg) translateX(0.42em) rotate(-360deg); }
          }
          .orbit-dot {
            animation: orbit 9s linear infinite;
          }

          @keyframes driftIn {
            from { opacity: 0; letter-spacing: 0.04em; }
            to   { opacity: 1; letter-spacing: 0; }
          }
          .numeral-fade {
            display: inline-block;
            animation: driftIn 1.1s cubic-bezier(0.43, 0.195, 0.02, 1) both;
          }
          .numeral-fade:first-child { animation-delay: 0.15s; }
          .numeral-fade:last-child  { animation-delay: 0.35s; }

          @keyframes pulseAccent {
            0%, 100% { transform: scale(1); opacity: 1; }
            50%      { transform: scale(1.04); opacity: 0.92; }
          }
          .numeral-orbit > span:first-child {
            display: inline-block;
            animation: pulseAccent 4s ease-in-out 1s infinite;
          }

          @media (prefers-reduced-motion: reduce) {
            .underline-grow,
            .orbit-dot,
            .numeral-fade,
            .numeral-orbit > span:first-child {
              animation: none !important;
              transform: none !important;
              opacity: 1 !important;
            }
            .underline-grow { transform: scaleX(1) !important; }
          }
        `}</style>
      </section>

      <LineDivider />
      <LandingFooter />
    </div>
  );
}

function QuickLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-md px-1.5 py-0.5 hover:text-[var(--sand-text)] hover:bg-[var(--sand-elevated)] transition"
    >
      {children}
    </Link>
  );
}

function Dot() {
  return (
    <span
      aria-hidden
      className="inline-block h-1 w-1 rounded-full opacity-50"
      style={{ background: 'currentColor' }}
    />
  );
}
