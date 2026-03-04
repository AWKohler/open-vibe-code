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
        // SharedArrayBuffer (required by WebContainer) needs cross-origin isolation
        // Applied globally so it works regardless of which route hosts the workspace
        source: '/(.*)',
        headers: [
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
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
