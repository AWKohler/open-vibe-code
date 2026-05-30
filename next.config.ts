import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@webcontainer/api'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.sanity.io',
        pathname: '/images/**',
      },
    ],
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
  // COEP/COOP cross-origin isolation was only ever needed for the legacy
  // WebContainer platform (SharedArrayBuffer). WebContainer is fully removed and
  // the public (/p/) view is now a static iframe of the deployed site, so no
  // route needs these headers anymore — and COEP 'credentialless' would strip
  // cookies from cross-origin iframes (e.g. Stripe Connect).
};

export default nextConfig;
