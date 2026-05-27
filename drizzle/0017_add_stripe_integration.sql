-- Stripe Connect (Express) integration.
-- See docs in src/lib/stripe.ts and the Stripe tab in the workspace.
--
-- Model: each Botflow project = one Express connected account per mode.
-- A `test` account is created silently on `initializeStripePayments` (no
-- KYC, no user popup). A `live` account is created lazily the first time
-- the user flips the workspace toolbar to Live mode on that project; KYC
-- is fully Stripe-hosted (Express). Prefill across projects pulls from
-- user_stripe_identity so KYC is essentially "one painful first time,
-- then ~60s confirm" for the same human.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "stripe_test_account_id" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "stripe_live_account_id" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "stripe_payment_mode" TEXT NOT NULL DEFAULT 'test';
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "stripe_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "stripe_webhook_secret" TEXT;

-- The webhook router matches on event.account against both columns.
CREATE INDEX IF NOT EXISTS "projects_stripe_test_account_id_idx"
  ON "projects"("stripe_test_account_id");
CREATE INDEX IF NOT EXISTS "projects_stripe_live_account_id_idx"
  ON "projects"("stripe_live_account_id");

-- One row per Botflow user; drives prefill when creating their 2nd+ live
-- Express account so Stripe recognizes the identity and skips re-verification.
CREATE TABLE IF NOT EXISTS "user_stripe_identity" (
  "user_id" TEXT PRIMARY KEY,
  "default_email" TEXT,
  "default_country" TEXT,
  "legal_entity_type" TEXT,             -- 'individual' | 'company' | null
  "last_live_account_id" TEXT,          -- most recent acct_… in live mode
  "updated_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Idempotency / dedupe table for incoming Stripe Connect webhook events.
-- Stripe retries for 3 days; we SETNX on event.id to make the handler
-- side-effect-once. Created here so the slice ships ready for the webhook
-- phase; the table is harmless until then.
CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "event_id" TEXT PRIMARY KEY,
  "received_at" TIMESTAMP DEFAULT NOW() NOT NULL
);
