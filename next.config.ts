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
  headers: async () => {
    // COEP/COOP isolation was needed for the legacy WebContainer platform
    // (SharedArrayBuffer). The Sandboxed Web platform doesn't use it — the
    // preview is rendered by a remote Vercel Sandbox in an iframe — so
    // /workspace/ no longer needs it. Worse, COEP 'credentialless' strips
    // cookies from cross-origin iframes (including Stripe's embedded
    // Connect components), which breaks the data-layer channel.
    //
    // /p/ (public preview view) keeps the headers in case a legacy
    // WebContainer-based project is still published there. Drop those too
    // once we've confirmed no live /p/ traffic exercises WebContainer.
    const coepHeaders = [
      { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ];
    return [
      { source: '/p/(.*)', headers: coepHeaders },
    ];
  },
};

export default nextConfig;
