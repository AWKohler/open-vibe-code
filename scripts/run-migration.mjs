// Run a raw-SQL migration against the Neon database.
// Usage: node scripts/run-migration.mjs src/db/migrations/<file>.sql
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-migration.mjs <path-to-sql>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sqlText = readFileSync(resolve(file), 'utf-8');
const sql = neon(url);

// Split on `;` at line ends, ignoring empty/comment-only lines
const statements = sqlText
  .split(/;\s*(?:\r?\n|$)/)
  .map(s => s.trim())
  .filter(s => s && !s.split('\n').every(l => l.trim().startsWith('--') || !l.trim()));

console.log(`Running ${statements.length} statements from ${file}...`);
for (const [i, stmt] of statements.entries()) {
  const preview = stmt.split('\n')[0].slice(0, 80);
  process.stdout.write(`  [${i + 1}/${statements.length}] ${preview}... `);
  try {
    await sql.query(stmt);
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    console.error(err);
    process.exit(1);
  }
}
console.log('Migration complete.');
