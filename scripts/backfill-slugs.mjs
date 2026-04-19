import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';

function kebab(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

async function run() {
  let urlFromFile;
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/);
      if (m) { urlFromFile = m[1]; break; }
    }
  } catch {}
  let url = (urlFromFile && urlFromFile.startsWith('postgres')) ? urlFromFile : process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  url = url.trim().replace(/^postgresql:\/\//, 'postgres://');
  const sql = neon(url);

  const rows = await sql`SELECT id, name FROM projects WHERE is_public = true AND public_slug IS NULL`;
  console.log(`Backfilling ${rows.length} public project(s) without a slug…`);
  for (const row of rows) {
    let candidate = `${kebab(row.name)}-${Math.random().toString(36).slice(2, 6)}`;
    for (let i = 0; i < 5; i++) {
      const existing = await sql`SELECT id FROM projects WHERE public_slug = ${candidate} LIMIT 1`;
      if (existing.length === 0) break;
      candidate = `${kebab(row.name)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    await sql`UPDATE projects SET public_slug = ${candidate}, published_at = COALESCE(published_at, NOW()) WHERE id = ${row.id}`;
    console.log(`  ✓ ${row.name} → ${candidate}`);
  }
  console.log('✅ Backfill complete.');
}

run().catch((err) => { console.error(err); process.exit(1); });
