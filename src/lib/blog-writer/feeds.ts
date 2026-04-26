/**
 * Minimal RSS reader for the blog writer cron. Parses TechCrunch + VentureBeat
 * feeds via regex to avoid pulling in an XML dep.
 */

export interface FeedItem {
  source: string;
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

const FEEDS: { name: string; url: string }[] = [
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  { name: 'VentureBeat', url: 'https://feeds.feedburner.com/venturebeat/SZYF' },
];

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

function pickTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return m[1];
}

function unwrapCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchOne(name: string, url: string): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BotflowBlogWriter/1.0' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${name} (${res.status})`);
  }
  const xml = await res.text();
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(ITEM_RE)) {
    const block = m[1];
    const title = stripHtml(unwrapCdata(pickTag(block, 'title')));
    const link = stripHtml(unwrapCdata(pickTag(block, 'link')));
    const description = stripHtml(unwrapCdata(pickTag(block, 'description'))).slice(0, 600);
    const pubDate = stripHtml(unwrapCdata(pickTag(block, 'pubDate'))) || undefined;
    if (title && link) items.push({ source: name, title, link, description, pubDate });
  }
  return items;
}

export async function fetchNewsFeed(opts?: { perFeed?: number }): Promise<FeedItem[]> {
  const perFeed = opts?.perFeed ?? 12;
  const results = await Promise.allSettled(
    FEEDS.map((f) => fetchOne(f.name, f.url).then((items) => items.slice(0, perFeed))),
  );
  const flat: FeedItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') flat.push(...r.value);
    else console.error('[blog-writer] feed fetch failed:', r.reason);
  }
  if (flat.length === 0) {
    throw new Error('No items returned from any news feed');
  }
  return flat;
}

export function formatFeedForPrompt(items: FeedItem[]): string {
  return items
    .map((it, i) => {
      const date = it.pubDate ? ` (${it.pubDate})` : '';
      return `${i + 1}. [${it.source}] ${it.title}${date}\n   ${it.link}\n   ${it.description}`;
    })
    .join('\n\n');
}
