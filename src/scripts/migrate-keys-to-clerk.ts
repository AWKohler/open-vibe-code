/**
 * One-time migration script: move sensitive credentials from Neon userSettings
 * to Clerk privateMetadata.
 *
 * Run with: npx tsx src/scripts/migrate-keys-to-clerk.ts
 *
 * Safe to run multiple times — skips users already migrated (has data in Clerk).
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';
import { createClerkClient } from '@clerk/backend';

const SENSITIVE_FIELDS = [ // eslint-disable-line @typescript-eslint/no-unused-vars
  'openai_api_key',
  'anthropic_api_key',
  'moonshot_api_key',
  'fireworks_api_key',
  'claude_oauth_access_token',
  'claude_oauth_refresh_token',
  'claude_oauth_expires_at',
  'codex_oauth_access_token',
  'codex_oauth_refresh_token',
  'codex_oauth_expires_at',
  'codex_oauth_account_id',
  'github_access_token',
  'github_username',
  'github_avatar_url',
] as const;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;

  if (!dbUrl) throw new Error('DATABASE_URL not set');
  if (!clerkSecretKey) throw new Error('CLERK_SECRET_KEY not set');

  const sql = neon(dbUrl);
  const clerk = createClerkClient({ secretKey: clerkSecretKey });

  // Fetch all rows from userSettings
  const rows = await sql`SELECT * FROM user_settings ORDER BY created_at ASC`;
  console.log(`Found ${rows.length} user_settings rows to process`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const userId = row.user_id as string;

    try {
      // Check if already migrated (Clerk has any of the sensitive fields)
      const user = await clerk.users.getUser(userId);
      const meta = (user.privateMetadata ?? {}) as Record<string, unknown>;

      const alreadyMigrated =
        meta.openaiApiKey !== undefined ||
        meta.anthropicApiKey !== undefined ||
        meta.claudeOAuthAccessToken !== undefined ||
        meta.codexOAuthAccessToken !== undefined ||
        meta.githubAccessToken !== undefined;

      if (alreadyMigrated) {
        console.log(`  [skip] ${userId} — already has Clerk credentials`);
        skipped++;
        continue;
      }

      // Build the privateMetadata update
      const updates: Record<string, unknown> = { ...meta };
      let hasAny = false;

      if (row.openai_api_key) { updates.openaiApiKey = row.openai_api_key; hasAny = true; }
      if (row.anthropic_api_key) { updates.anthropicApiKey = row.anthropic_api_key; hasAny = true; }
      if (row.moonshot_api_key) { updates.moonshotApiKey = row.moonshot_api_key; hasAny = true; }
      if (row.fireworks_api_key) { updates.fireworksApiKey = row.fireworks_api_key; hasAny = true; }
      if (row.claude_oauth_access_token) { updates.claudeOAuthAccessToken = row.claude_oauth_access_token; hasAny = true; }
      if (row.claude_oauth_refresh_token) { updates.claudeOAuthRefreshToken = row.claude_oauth_refresh_token; hasAny = true; }
      if (row.claude_oauth_expires_at !== null) { updates.claudeOAuthExpiresAt = Number(row.claude_oauth_expires_at); hasAny = true; }
      if (row.codex_oauth_access_token) { updates.codexOAuthAccessToken = row.codex_oauth_access_token; hasAny = true; }
      if (row.codex_oauth_refresh_token) { updates.codexOAuthRefreshToken = row.codex_oauth_refresh_token; hasAny = true; }
      if (row.codex_oauth_expires_at !== null) { updates.codexOAuthExpiresAt = Number(row.codex_oauth_expires_at); hasAny = true; }
      if (row.codex_oauth_account_id) { updates.codexOAuthAccountId = row.codex_oauth_account_id; hasAny = true; }
      if (row.github_access_token) { updates.githubAccessToken = row.github_access_token; hasAny = true; }
      if (row.github_username) { updates.githubUsername = row.github_username; hasAny = true; }
      if (row.github_avatar_url) { updates.githubAvatarUrl = row.github_avatar_url; hasAny = true; }

      if (!hasAny) {
        console.log(`  [skip] ${userId} — no sensitive data to migrate`);
        skipped++;
        continue;
      }

      await clerk.users.updateUserMetadata(userId, { privateMetadata: updates });
      console.log(`  [migrated] ${userId}`);
      migrated++;

      // Small delay to avoid Clerk rate limits
      await new Promise(r => setTimeout(r, 200));

    } catch (e) {
      console.error(`  [error] ${userId}:`, e instanceof Error ? e.message : e);
      errors++;
    }
  }

  console.log(`\nMigration complete: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);

  if (errors > 0) {
    console.log('Re-run the script to retry failed users.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
