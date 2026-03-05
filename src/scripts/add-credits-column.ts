/**
 * One-time migration: add credits column to usage_records table.
 * Run: npx tsx src/scripts/add-credits-column.ts
 */

import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({ path: '.env.local' });

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log('Adding credits column to usage_records...');
  await sql`
    ALTER TABLE usage_records
    ADD COLUMN IF NOT EXISTS credits bigint NOT NULL DEFAULT 0
  `;
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
