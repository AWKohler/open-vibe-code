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
    // WebContainer requires cross-origin isolation (SharedArrayBuffer) — apply to
    // routes that boot WebContainer: /workspace/* (owner) and /p/* (public view).
    const coepHeaders = [
      {
        key: 'Cross-Origin-Embedder-Policy',
        // 'credentialless' enables SharedArrayBuffer (required by WebContainer) while
        // allowing cross-origin resources that don't set CORP headers (Clerk, CDN fonts, etc.)
        value: 'credentialless',
      },
      {
        key: 'Cross-Origin-Opener-Policy',
        value: 'same-origin',
      },
    ];
    return [
      { source: '/workspace/(.*)', headers: coepHeaders },
      { source: '/p/(.*)', headers: coepHeaders },
    ];
  },
};

export default nextConfig;
