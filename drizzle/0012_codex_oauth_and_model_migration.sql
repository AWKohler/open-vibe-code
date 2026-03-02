-- Add Codex OAuth columns
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "codex_oauth_access_token" text;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "codex_oauth_refresh_token" text;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "codex_oauth_expires_at" bigint;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "codex_oauth_account_id" text;
-- Migrate model default and existing data
ALTER TABLE "projects" ALTER COLUMN "model" SET DEFAULT 'gpt-5.3-codex';
UPDATE "projects" SET "model" = 'gpt-5.3-codex' WHERE "model" = 'gpt-5.2';
