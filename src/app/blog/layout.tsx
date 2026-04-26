import type { Metadata } from 'next';
import {
  EditorialGrid,
  LandingFooter,
  LandingNav,
} from '@/components/landing/shared';

const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://botflow.io';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Blog — Botflow',
    template: '%s — Botflow Blog',
  },
  description:
    'Engineering notes, product updates, and field guides on building full-stack apps in the browser with AI.',
  alternates: {
    canonical: '/blog',
    types: {
      'application/rss+xml': [{ url: '/blog/rss.xml', title: 'Botflow Blog' }],
    },
  },
  openGraph: {
    type: 'website',
    siteName: 'Botflow',
    url: '/blog',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen bg-[var(--sand-bg)] text-[var(--sand-text)] antialiased">
      <EditorialGrid />
      <LandingNav />
      <main className="relative z-10">{children}</main>
      <LandingFooter />
    </div>
  );
}
