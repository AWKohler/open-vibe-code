/**
 * Upstash Redis client — single shared instance for the whole app.
 * Import `redis` for raw key-value ops, `ratelimit` helpers live in rate-limit.ts.
 */

import { Redis } from '@upstash/redis';

// Singleton — Next.js module cache keeps this alive across hot reloads in dev
let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});
