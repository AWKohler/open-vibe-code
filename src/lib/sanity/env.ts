export const SANITY_PROJECT_ID =
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? 'ac254mwy';

export const SANITY_DATASET =
  process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production';

export const SANITY_API_VERSION =
  process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-12-01';

export const SANITY_USE_CDN = process.env.NODE_ENV === 'production';

export const SANITY_REVALIDATE_SECRET =
  process.env.SANITY_REVALIDATE_SECRET ?? '';
