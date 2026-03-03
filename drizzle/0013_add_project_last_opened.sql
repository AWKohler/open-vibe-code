ALTER TABLE "projects" ADD COLUMN "last_opened" timestamp;
UPDATE "projects" SET "last_opened" = COALESCE("updated_at", "created_at", now()) WHERE "last_opened" IS NULL;
ALTER TABLE "projects" ALTER COLUMN "last_opened" SET DEFAULT now();
ALTER TABLE "projects" ALTER COLUMN "last_opened" SET NOT NULL;
