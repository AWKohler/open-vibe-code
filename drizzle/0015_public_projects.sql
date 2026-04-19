-- Add public sharing columns to projects
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "is_public" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "public_slug" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "public_description" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "star_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "forked_from_project_id" UUID;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "published_at" TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "projects_public_slug_unique" ON "projects"("public_slug");
CREATE INDEX IF NOT EXISTS "projects_is_public_idx" ON "projects"("is_public");
CREATE INDEX IF NOT EXISTS "projects_star_count_idx" ON "projects"("star_count");

-- Project stars (join table)
CREATE TABLE IF NOT EXISTS "project_stars" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_stars_project_user_unique" ON "project_stars"("project_id", "user_id");
CREATE INDEX IF NOT EXISTS "project_stars_project_id_idx" ON "project_stars"("project_id");
CREATE INDEX IF NOT EXISTS "project_stars_user_id_idx" ON "project_stars"("user_id");
