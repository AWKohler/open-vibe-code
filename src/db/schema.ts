import { pgTable, uuid, timestamp, text, jsonb, integer, bigint, uniqueIndex, index, boolean } from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  userId: text('user_id').notNull(), // Clerk user id
  platform: text('platform').notNull().default('web'), // 'web' | 'mobile'
  // Preferred model for this project: 'gpt-5.3-codex' | 'claude-sonnet-4.6' | 'claude-haiku-4.5' | 'claude-opus-4.6' | 'kimi-k2-thinking-turbo' | 'fireworks-minimax-m2p5'
  model: text('model').notNull().default('gpt-5.3-codex'),
  // Snapshot URLs for project thumbnails and HTML captures
  thumbnailUrl: text('thumbnail_url'),
  htmlSnapshotUrl: text('html_snapshot_url'),
  // UploadThing file keys for deletion (format: "fileKey" from uploadthing)
  thumbnailKey: text('thumbnail_key'),
  htmlSnapshotKey: text('html_snapshot_key'),
  // Convex backend integration (for web projects)
  convexProjectId: text('convex_project_id'),       // Convex platform project ID
  convexDeploymentId: text('convex_deployment_id'), // Deployment name (e.g., "happy-otter-123")
  convexDeployUrl: text('convex_deploy_url'),       // VITE_CONVEX_URL value
  convexDeployKey: text('convex_deploy_key'),       // Deploy key for pushing functions
  // GitHub repository integration
  githubRepoOwner: text('github_repo_owner'),         // GitHub username or org
  githubRepoName: text('github_repo_name'),           // Repository name
  githubDefaultBranch: text('github_default_branch').default('main'), // Default branch
  githubLastPushedSha: text('github_last_pushed_sha'), // Last commit SHA pushed to GitHub
  // Cloudflare Pages deployment
  cloudflareProjectName: text('cloudflare_project_name'),
  cloudflareDeploymentUrl: text('cloudflare_deployment_url'),
  lastOpened: timestamp('last_opened').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  // Soft delete — null means active. Set for Pro/Max users on delete; Free = immediate hard delete.
  deletedAt: timestamp('deleted_at'),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

// Chat session per project (one active session per project)
export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Store all messages as JSON to preserve all parts (tool-calls, data, etc.)
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    // Original message id from the client/useChat to dedupe
    messageId: text('message_id').notNull(),
    role: text('role').notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    sessionMessageUnique: uniqueIndex('chat_messages_session_message_unique').on(t.sessionId, t.messageId),
  })
);

export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

// Per-user API key storage (BYOK)
export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(), // Clerk user id
  openaiApiKey: text('openai_api_key'),
  anthropicApiKey: text('anthropic_api_key'),
  moonshotApiKey: text('moonshot_api_key'),
  fireworksApiKey: text('fireworks_api_key'),
  // Claude Code OAuth (takes priority over anthropicApiKey for Anthropic models)
  claudeOAuthAccessToken: text('claude_oauth_access_token'),
  claudeOAuthRefreshToken: text('claude_oauth_refresh_token'),
  claudeOAuthExpiresAt: bigint('claude_oauth_expires_at', { mode: 'number' }), // Unix ms
  // ChatGPT Codex OAuth
  codexOAuthAccessToken: text('codex_oauth_access_token'),
  codexOAuthRefreshToken: text('codex_oauth_refresh_token'),
  codexOAuthExpiresAt: bigint('codex_oauth_expires_at', { mode: 'number' }),
  codexOAuthAccountId: text('codex_oauth_account_id'),
  // GitHub OAuth
  githubAccessToken: text('github_access_token'),
  githubUsername: text('github_username'),
  githubAvatarUrl: text('github_avatar_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userUnique: uniqueIndex('user_settings_user_unique').on(t.userId),
}));

export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;

// Cloud backup tables for project files
export const projectFiles = pgTable('project_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  content: text('content').notNull(),
  hash: text('hash').notNull(),
  size: integer('size').notNull(),
  mimeType: text('mime_type'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectPathUnique: uniqueIndex('project_files_project_path_unique').on(t.projectId, t.path),
  projectIdIdx: index('project_files_project_id_idx').on(t.projectId),
  hashIdx: index('project_files_hash_idx').on(t.hash),
}));

export type ProjectFile = typeof projectFiles.$inferSelect;
export type NewProjectFile = typeof projectFiles.$inferInsert;

export const projectAssets = pgTable('project_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  uploadThingUrl: text('upload_thing_url').notNull(),
  uploadThingKey: text('upload_thing_key').notNull(),
  hash: text('hash').notNull(),
  size: integer('size').notNull(),
  mimeType: text('mime_type'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectPathUnique: uniqueIndex('project_assets_project_path_unique').on(t.projectId, t.path),
  projectIdIdx: index('project_assets_project_id_idx').on(t.projectId),
}));

export type ProjectAsset = typeof projectAssets.$inferSelect;
export type NewProjectAsset = typeof projectAssets.$inferInsert;

export const projectSyncManifests = pgTable('project_sync_manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fileManifest: jsonb('file_manifest').notNull(),
  totalFiles: integer('total_files').notNull().default(0),
  totalSize: bigint('total_size', { mode: 'number' }).notNull().default(0),
  lastSyncAt: timestamp('last_sync_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectUnique: uniqueIndex('project_sync_manifests_project_unique').on(t.projectId),
  projectIdIdx: index('project_sync_manifests_project_id_idx').on(t.projectId),
}));

export type ProjectSyncManifest = typeof projectSyncManifests.$inferSelect;
export type NewProjectSyncManifest = typeof projectSyncManifests.$inferInsert;

// Project environment variables (user-defined, stored in database)
export const projectEnvVars = pgTable('project_env_vars', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),           // Variable name (e.g., "API_KEY")
  value: text('value').notNull(),       // Variable value
  isSecret: boolean('is_secret').notNull().default(false), // Flag for sensitive values (masked in UI)
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectKeyUnique: uniqueIndex('project_env_vars_project_key_unique').on(t.projectId, t.key),
  projectIdIdx: index('project_env_vars_project_id_idx').on(t.projectId),
}));

export type ProjectEnvVar = typeof projectEnvVars.$inferSelect;
export type NewProjectEnvVar = typeof projectEnvVars.$inferInsert;

// Pending git commits: committed locally, not yet pushed to GitHub
export const pendingGitCommits = pgTable('pending_git_commits', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  message: text('message').notNull(),
  // Snapshot of changed files at commit time: { path: content (text) | null (deleted) }
  filesSnapshot: jsonb('files_snapshot').notNull().$type<Record<string, string | null>>(),
  // SHA of the tree before this commit (from lastPushedSha at commit time)
  baseSha: text('base_sha'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectIdIdx: index('pending_git_commits_project_id_idx').on(t.projectId),
}));

export type PendingGitCommit = typeof pendingGitCommits.$inferSelect;
export type NewPendingGitCommit = typeof pendingGitCommits.$inferInsert;

// Chat images: files attached to chat messages, stored in UploadThing
export const chatImages = pgTable('chat_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  uploadThingUrl: text('upload_thing_url').notNull(),
  uploadThingKey: text('upload_thing_key').notNull(),
  filename: text('filename'),
  size: integer('size'),
  mediaType: text('media_type'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectIdIdx: index('chat_images_project_id_idx').on(t.projectId),
}));

export type ChatImage = typeof chatImages.$inferSelect;
export type NewChatImage = typeof chatImages.$inferInsert;

// Usage tracking for subscription tier enforcement
// One row per (userId, period, model) — upserted on every agent call completion
export const usageRecords = pgTable('usage_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  // Billing period in YYYY-MM format, e.g. "2026-03"
  period: text('period').notNull(),
  // Model id as used in MODEL_CONFIGS, e.g. "claude-haiku-4.5"
  model: text('model').notNull(),
  tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
  tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
  // Anthropic prompt cache: tokens served from cache (cheaper) and tokens written to cache
  cachedTokensRead: bigint('cached_tokens_read', { mode: 'number' }).notNull().default(0),
  cachedTokensWrite: bigint('cached_tokens_write', { mode: 'number' }).notNull().default(0),
  // Credits consumed (MiniMax-equivalent tokens) — computed from raw tokens × model multiplier
  credits: bigint('credits', { mode: 'number' }).notNull().default(0),
  // Cumulative agent turns in this period (all models combined tracked separately)
  agentTurns: integer('agent_turns').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userPeriodModelUnique: uniqueIndex('usage_records_user_period_model_unique').on(t.userId, t.period, t.model),
  userIdIdx: index('usage_records_user_id_idx').on(t.userId),
  periodIdx: index('usage_records_period_idx').on(t.period),
}));

export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;
