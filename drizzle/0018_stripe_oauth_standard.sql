-- Stripe Connect pivot: Standard accounts via OAuth.
--
-- The `acct_…` IDs now live on user_stripe_identity (one Stripe account per
-- Botflow user, reused across all their projects). The two projects.* columns
-- added in 0017 are kept for backward compatibility but no longer written.
-- A future migration can drop them once we've confirmed no rows reference
-- them; non-destructive for now.

ALTER TABLE "user_stripe_identity"
  ADD COLUMN IF NOT EXISTS "test_account_id" TEXT,
  ADD COLUMN IF NOT EXISTS "live_account_id" TEXT,
  ADD COLUMN IF NOT EXISTS "test_publishable_key" TEXT,
  ADD COLUMN IF NOT EXISTS "live_publishable_key" TEXT,
  ADD COLUMN IF NOT EXISTS "connected_at" TIMESTAMP;

-- Stripe webhooks arrive with event.account = the connected account id.
-- We need to look up which Botflow user owns it without scanning.
CREATE INDEX IF NOT EXISTS "user_stripe_identity_test_account_id_idx"
  ON "user_stripe_identity"("test_account_id");
CREATE INDEX IF NOT EXISTS "user_stripe_identity_live_account_id_idx"
  ON "user_stripe_identity"("live_account_id");

-- OAuth state tokens (short-lived). Used to bind the code-exchange callback
-- back to the user/project that started the flow, and to prevent CSRF.
CREATE TABLE IF NOT EXISTS "stripe_oauth_states" (
  "state" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "mode" TEXT NOT NULL,                   -- 'test' | 'live'
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "expires_at" TIMESTAMP NOT NULL,        -- created_at + 15 min
  "consumed_at" TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "stripe_oauth_states_expires_at_idx"
  ON "stripe_oauth_states"("expires_at");
