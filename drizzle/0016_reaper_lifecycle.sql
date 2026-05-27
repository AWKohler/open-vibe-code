-- Reaper lifecycle columns on projects.
-- See src/db/schema.ts and src/lib/reaper/policy.ts.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "sandbox_template" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "last_sandbox_activity_at" TIMESTAMP;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "became_reapable_at" TIMESTAMP;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "reap_stage" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "last_reap_warning_sent_at" TIMESTAMP;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "convex_calls_last_30d" BIGINT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "convex_calls_checked_at" TIMESTAMP;

-- Index the reaper's scan: it sweeps by stage + idle clock among free-tier owners.
CREATE INDEX IF NOT EXISTS "projects_reap_stage_idx" ON "projects"("reap_stage");
CREATE INDEX IF NOT EXISTS "projects_became_reapable_at_idx" ON "projects"("became_reapable_at");
