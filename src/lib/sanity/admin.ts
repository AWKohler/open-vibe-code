import { createClient } from '@sanity/client';
import { SANITY_API_VERSION, SANITY_DATASET, SANITY_PROJECT_ID } from './env';

let cached: ReturnType<typeof createClient> | null = null;

export function getSanityWriteClient() {
  const token = process.env.SANITY_PROGAMATIC;
  if (!token) {
    throw new Error(
      'SANITY_PROGAMATIC env var is not set — required for programmatic Sanity writes',
    );
  }
  if (cached) return cached;
  cached = createClient({
    projectId: SANITY_PROJECT_ID,
    dataset: SANITY_DATASET,
    apiVersion: SANITY_API_VERSION,
    token,
    useCdn: false,
    perspective: 'published',
  });
  return cached;
}
