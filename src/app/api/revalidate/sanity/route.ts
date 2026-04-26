import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { SANITY_TAG_POSTS } from '@/lib/sanity/fetch';
import { SANITY_REVALIDATE_SECRET } from '@/lib/sanity/env';

type SanityWebhookBody = {
  _type?: string;
  slug?: { current?: string } | null;
};

function isAuthorized(req: Request): boolean {
  if (!SANITY_REVALIDATE_SECRET) return false;
  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${SANITY_REVALIDATE_SECRET}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get('secret') === SANITY_REVALIDATE_SECRET;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: SanityWebhookBody = {};
  try {
    body = (await req.json()) as SanityWebhookBody;
  } catch {
    // tolerate empty bodies — fall back to broad invalidation
  }

  revalidateTag(SANITY_TAG_POSTS);
  revalidatePath('/blog');
  revalidatePath('/sitemap.xml');
  revalidatePath('/blog/rss.xml');

  if (body?.slug?.current) {
    revalidatePath(`/blog/${body.slug.current}`);
  }

  return NextResponse.json({ ok: true, revalidated: true, body });
}
