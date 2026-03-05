import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@webcontainer/api'],
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
    return [
      {
        // WebContainer requires cross-origin isolation (SharedArrayBuffer) — apply only to
        // workspace routes so Stripe/Clerk checkout iframes work everywhere else.
        source: '/workspace/(.*)',
        headers: [
          {
            key: 'Cross-Origin-Embedder-Policy',
            // 'credentialless' enables SharedArrayBuffer (required by WebContainer) while
            // allowing cross-origin resources that don't set CORP headers (Clerk, CDN fonts, etc.)
            // 'require-corp' was too strict and broke third-party embeds, preventing crossOriginIsolated.
            value: 'credentialless',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
