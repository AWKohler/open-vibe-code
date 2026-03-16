-- Add user-managed Convex fields to projects table
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS user_convex_url TEXT,
  ADD COLUMN IF NOT EXISTS user_convex_deploy_key TEXT,
  ADD COLUMN IF NOT EXISTS backend_type TEXT NOT NULL DEFAULT 'platform';

-- Add Convex OAuth fields to user_settings table
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS convex_oauth_access_token TEXT,
  ADD COLUMN IF NOT EXISTS convex_oauth_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS convex_oauth_expires_at BIGINT;
