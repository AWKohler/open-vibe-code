/**
 * One-time migration: add agent backend + chat segment columns.
 *
 *   projects.agent_backend         text  default 'botflow' not null
 *   projects.current_segment_id    uuid  (the active conversation segment)
 *   chat_messages.segment_id       uuid  (which segment a message belongs to)
 *
 * Backfill: every existing project gets a single segment id minted; all its
 * chat_messages get stamped with that id, and the project's current_segment_id
 * is set to it. So existing data lands cleanly in "one big segment" per project.
 *
 * Run: npx tsx src/scripts/add-agent-backend-columns.ts
 */

import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log("Adding agent_backend + current_segment_id to projects...");
  await sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS agent_backend text NOT NULL DEFAULT 'botflow',
    ADD COLUMN IF NOT EXISTS current_segment_id uuid
  `;

  console.log("Adding segment_id to chat_messages...");
  await sql`
    ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS segment_id uuid
  `;

  // Backfill: per project, mint one segment id and stamp everything.
  // We do this in a single SQL with a CTE so existing data converges in one
  // pass — no need for app-level iteration.
  console.log("Backfilling segment ids for existing projects + messages...");
  await sql`
    WITH project_segments AS (
      SELECT p.id AS project_id, gen_random_uuid() AS segment_id
      FROM projects p
      WHERE p.current_segment_id IS NULL
    )
    UPDATE projects p
    SET current_segment_id = ps.segment_id
    FROM project_segments ps
    WHERE p.id = ps.project_id
  `;

  await sql`
    UPDATE chat_messages cm
    SET segment_id = p.current_segment_id
    FROM chat_sessions cs
    JOIN projects p ON p.id = cs.project_id
    WHERE cm.session_id = cs.id
      AND cm.segment_id IS NULL
      AND p.current_segment_id IS NOT NULL
  `;

  // Helpful index for segment-scoped queries.
  console.log("Creating index chat_messages_session_segment_idx...");
  await sql`
    CREATE INDEX IF NOT EXISTS chat_messages_session_segment_idx
      ON chat_messages (session_id, segment_id)
  `;

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
