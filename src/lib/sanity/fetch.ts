import { sanityClient } from './client';

export const SANITY_TAG_POSTS = 'sanity:posts';

type FetchOptions<TParams> = {
  query: string;
  params?: TParams;
  tags?: string[];
  revalidate?: number | false;
};

export async function sanityFetch<TResult, TParams = Record<string, unknown>>({
  query,
  params,
  tags = [SANITY_TAG_POSTS],
  revalidate = 60,
}: FetchOptions<TParams>): Promise<TResult> {
  return sanityClient.fetch<TResult>(query, params ?? {}, {
    next: {
      revalidate: revalidate === false ? undefined : revalidate,
      tags,
    },
  });
}
