-- Create chat_images table for storing UploadThing references for chat image attachments
CREATE TABLE IF NOT EXISTS "chat_images" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "upload_thing_url" TEXT NOT NULL,
  "upload_thing_key" TEXT NOT NULL,
  "filename" TEXT,
  "size" INTEGER,
  "media_type" TEXT,
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS "chat_images_project_id_idx" ON "chat_images"("project_id");

-- Migrate kimi model data
UPDATE "projects" SET "model" = 'kimi-k2.5' WHERE "model" = 'kimi-k2-thinking-turbo';
