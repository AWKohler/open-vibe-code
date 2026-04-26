import { getAllPosts } from '@/lib/sanity/posts';

export const revalidate = 3600;

const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://botflow.io';

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRfc822(date?: string | null): string {
  const d = date ? new Date(date) : new Date();
  return d.toUTCString();
}

export async function GET() {
  const posts = await getAllPosts();
  const lastBuild = posts[0]?.updatedAt ?? posts[0]?.publishedAt;

  const items = posts
    .map((post) => {
      const url = `${SITE_URL}/blog/${post.slug}`;
      return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${toRfc822(post.publishedAt)}</pubDate>
      ${post.author?.name ? `<dc:creator>${escapeXml(post.author.name)}</dc:creator>` : ''}
      ${post.excerpt ? `<description>${escapeXml(post.excerpt)}</description>` : ''}
      ${post.categories
        ?.map((c) => `<category>${escapeXml(c.title)}</category>`)
        .join('') ?? ''}
    </item>`;
    })
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Botflow Blog</title>
    <link>${SITE_URL}/blog</link>
    <description>Engineering notes, product updates, and field guides on building full-stack apps in the browser with AI.</description>
    <language>en-us</language>
    <lastBuildDate>${toRfc822(lastBuild)}</lastBuildDate>
    <atom:link href="${SITE_URL}/blog/rss.xml" rel="self" type="application/rss+xml" />
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
