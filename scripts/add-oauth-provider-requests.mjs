/**
 * Migration: add auth_configured column to projects and create
 * oauth_provider_requests table.
 *
 * Run with:  node scripts/add-oauth-provider-requests.mjs
 */
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';

async function run() {
  // Try .env.local first, fall back to process.env
  let url = process.env.DATABASE_URL;
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/);
      if (m) { url = m[1]; break; }
    }
  } catch { /* no .env.local — use process.env */ }

  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  url = url.trim().replace(/^postgresql:\/\//, 'postgres://');
  const sql = neon(url);

  console.log('1/3  Adding auth_configured column to projects…');
  await sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS auth_configured BOOLEAN NOT NULL DEFAULT false
  `;

  console.log('2/3  Creating oauth_provider_requests table…');
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_provider_requests (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id       TEXT        NOT NULL,
      provider      TEXT        NOT NULL,
      status        TEXT        NOT NULL DEFAULT 'pending',
      convex_site_url TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log('3/3  Creating index on project_id…');
  await sql`
    CREATE INDEX IF NOT EXISTS oauth_provider_requests_project_id_idx
    ON oauth_provider_requests(project_id)
  `;

  console.log('Migration complete.');
}

run().catch((err) => { console.error(err); process.exit(1); });
