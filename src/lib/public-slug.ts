import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Generate a unique public URL slug for a project: kebab-cased name + a random
 * 4-char suffix, retrying on the (extremely rare) collision.
 */
export async function generateUniquePublicSlug(name: string): Promise<string> {
  const db = getDb();
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  let candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.publicSlug, candidate))
      .limit(1);
    if (existing.length === 0) break;
    candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return candidate;
}
