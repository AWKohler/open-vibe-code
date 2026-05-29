-- Make Kimi K2.6 the default model for new projects.
-- (App inserts always specify a model explicitly, so this only affects rows
--  inserted without one; kept in sync with schema.ts for correctness.)
ALTER TABLE "projects" ALTER COLUMN "model" SET DEFAULT 'fireworks-kimi-k2p6';
