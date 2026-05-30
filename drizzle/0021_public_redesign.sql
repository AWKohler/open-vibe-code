-- Public/showcase redesign: a project can only be public if it is deployed.
-- Add the source-bundle columns and the transient fork-seed pointer.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "public_source_url" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "public_source_key" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "seed_bundle_url" text;

-- Reset all existing public projects to private (the public model changed;
-- they must be re-published via the deploy popover to appear in Explore again).
-- Slugs and Cloudflare deployments are intentionally preserved.
UPDATE "projects" SET "is_public" = false WHERE "is_public" = true;
