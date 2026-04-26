import { createClient } from '@sanity/client';
import {
  SANITY_API_VERSION,
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_USE_CDN,
} from './env';

export const sanityClient = createClient({
  projectId: SANITY_PROJECT_ID,
  dataset: SANITY_DATASET,
  apiVersion: SANITY_API_VERSION,
  useCdn: SANITY_USE_CDN,
  perspective: 'published',
});
