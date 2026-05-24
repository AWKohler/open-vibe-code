/**
 * Migration: GitHub-on-sandbox foundation.
 *
 * 1. Adds `git_autonomy` column to projects.
 * 2. Creates `chat_questions` table for the in-chat askQuestion tool handshake.
 *
 * Run with:  node scripts/add-github-sandbox.mjs
 */
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';

async function run() {
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

  console.log('1/3  Adding git_autonomy column to projects…');
  await sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS git_autonomy TEXT
  `;

  console.log('2/3  Creating chat_questions table…');
  await sql`
    CREATE TABLE IF NOT EXISTS chat_questions (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id       TEXT        NOT NULL,
      segment_id    UUID,
      tool_call_id  TEXT        NOT NULL,
      questions     JSONB       NOT NULL,
      status        TEXT        NOT NULL DEFAULT 'pending',
      answer        JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log('3/3  Creating indexes on chat_questions…');
  await sql`
    CREATE INDEX IF NOT EXISTS chat_questions_project_id_idx
    ON chat_questions(project_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS chat_questions_tool_call_id_idx
    ON chat_questions(tool_call_id)
  `;

  console.log('Migration complete.');
}

run().catch((err) => { console.error(err); process.exit(1); });
