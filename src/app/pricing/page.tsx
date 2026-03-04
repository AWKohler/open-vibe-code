'use client';

import Link from 'next/link';
import { PricingTable } from '@clerk/nextjs';
import { SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/nextjs';

export default function PricingPage() {
  return (
    <div className="antialiased text-fg bg-bg min-h-screen">
      {/* Ambient background */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div
          className="absolute -top-1/3 -left-1/4 h-[80vh] w-[80vw] rounded-full blur-3xl opacity-50"
          style={{
            background:
              'radial-gradient(circle, color-mix(in oklab, var(--sand-accent) 26%, transparent) 0%, transparent 68%)',
          }}
        />
        <div
          className="absolute top-1/3 left-1/2 h-[90vh] w-[80vw] -translate-x-1/2 rounded-full blur-3xl opacity-40"
          style={{
            background:
              'radial-gradient(circle, color-mix(in oklab, var(--sand-text-muted) 20%, transparent) 0%, transparent 72%)',
          }}
        />
      </div>

      {/* Header */}
      <header>
        <div className="mx-auto max-w-7xl px-6 py-5">
          <div className="flex items-center justify-between">
            <Link className="flex items-center gap-3" href="/">
              <img src="/brand/botflow-glyph.svg" alt="" className="h-8 w-8" />
              <img
                src="/brand/botflow-wordmark.svg"
                alt="Botflow"
                className="h-5 w-auto botflow-wordmark-invert"
              />
            </Link>

            <div className="flex items-center gap-3">
              <Link
                href="/projects"
                className="text-sm text-muted hover:text-fg transition"
              >
                My Projects
              </Link>
              <SignedOut>
                <SignInButton>
                  <button className="inline-flex items-center rounded-xl border border-border bg-elevated px-3.5 py-2 text-sm font-medium text-fg shadow-sm hover:bg-soft transition">
                    Log in
                  </button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <UserButton afterSignOutUrl="/" />
              </SignedIn>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-7xl px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-semibold tracking-tight mb-3">Simple, transparent pricing</h1>
          <p className="text-muted text-lg max-w-xl mx-auto">
            Start for free — no credit card required. Upgrade when you need more.
          </p>
        </div>

        <PricingTable
          newSubscriptionRedirectUrl="/projects"
          ctaPosition="bottom"
        />
      </main>
    </div>
  );
}
