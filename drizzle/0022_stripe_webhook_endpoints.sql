CREATE TABLE IF NOT EXISTS "stripe_webhook_endpoints" (
	"mode" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"secret" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
