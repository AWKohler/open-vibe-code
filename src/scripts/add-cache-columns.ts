/**
 * One-time migration: add cached_tokens_read and cached_tokens_write columns to usage_records.
 * Run: npx tsx src/scripts/add-cache-columns.ts
 */

import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({ path: '.env.local' });

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log('Adding cache token columns to usage_records...');
  await sql`
    ALTER TABLE usage_records
    ADD COLUMN IF NOT EXISTS cached_tokens_read bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cached_tokens_write bigint NOT NULL DEFAULT 0
  `;
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
