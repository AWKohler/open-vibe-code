/**
 * One-shot: apply the 0016_reaper_lifecycle migration against DATABASE_URL.
 *
 * Each ALTER uses `ADD COLUMN IF NOT EXISTS`, so re-running is safe.
 *
 *   tsx src/scripts/apply-reaper-migration.ts
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = neon(url);

const migrationPath = resolve(process.cwd(), "drizzle/0016_reaper_lifecycle.sql");
const raw = readFileSync(migrationPath, "utf-8");

// Neon's HTTP driver doesn't support multi-statement queries; split on ;
const statements = raw
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("--"));

(async () => {
  for (const stmt of statements) {
    console.log("→", stmt.split("\n")[0].slice(0, 100));
    await sql.query(stmt);
  }
  console.log("done.");
  process.exit(0);
})().catch((e) => {
  console.error("migration failed:", e);
  process.exit(1);
});
