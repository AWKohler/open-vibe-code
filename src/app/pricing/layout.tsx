import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Simple, transparent pricing for Botflow. Start free and upgrade when you need more AI credits, projects, and features.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'Botflow Pricing — Start Free, Scale as You Grow',
    description:
      'Simple, transparent pricing for Botflow. Start free and upgrade when you need more AI credits, projects, and features.',
    url: '/pricing',
    type: 'website',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'Botflow Pricing' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Botflow Pricing',
    description:
      'Simple, transparent pricing for Botflow. Start free and upgrade when you need more AI credits, projects, and features.',
    images: ['/og-image.png'],
  },
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
