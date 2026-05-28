-- Modal-driven Stripe Connect requests, modelled after oauth_provider_requests.
-- The agent's initializeStripePayments tool creates one of these; the workspace
-- UI polls and renders a modal; the OAuth callback flips status='completed'
-- once Stripe redirects back.

CREATE TABLE IF NOT EXISTS "stripe_connect_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,                       -- 'test' | 'live'
  "state" TEXT NOT NULL,                      -- the stripe_oauth_states.state used
  "authorize_url" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'completed' | 'dismissed'
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS "stripe_connect_requests_project_id_idx"
  ON "stripe_connect_requests"("project_id");

-- The callback looks up by state to flip status when OAuth completes.
CREATE INDEX IF NOT EXISTS "stripe_connect_requests_state_idx"
  ON "stripe_connect_requests"("state");
