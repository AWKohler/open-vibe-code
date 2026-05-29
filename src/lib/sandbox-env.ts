/**
 * Frontend env-var materialization for sandboxed-web projects.
 *
 * Source of truth: the `project_env_vars` table (frontend/Vite vars only).
 * The sandbox `/vercel/sandbox/.env` file is a *derived artifact* — we
 * regenerate it wholesale from the DB at three moments:
 *   1. every save in the workspace Env panel,
 *   2. dev-server start (`startSandboxDevServer`),
 *   3. production build (`publish` route).
 *
 * "DB wins": this overwrites `.env` entirely. The one var we always inject is
 * the platform-enforced Convex URL (`VITE_CONVEX_URL`, or `EXPO_PUBLIC_CONVEX_URL`
 * on mobile/multiplatform), so the frontend can always reach its backend even
 * if the user never typed it.
 *
 * Backend (Convex) env vars are NOT handled here — the Convex deployment is
 * their source of truth (see `convex-env.ts`).
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, projectEnvVars } from "@/db/schema";
import { writeSandboxEnvFile } from "@/lib/vercel-sandbox";

/**
 * The platform-managed frontend var that wires the Vite app to its Convex
 * backend. Mobile/Expo uses a different prefix. Returns null when the project
 * has no backend (nothing to inject).
 */
export function platformConvexEnvVar(
  project: typeof projects.$inferSelect,
): { key: string; value: string } | null {
  if (project.backendType === "none") return null;
  const effectiveConvexUrl = project.userConvexUrl || project.convexDeployUrl;
  if (!effectiveConvexUrl) return null;
  const key =
    project.platform === "mobile" || project.platform === "multiplatform"
      ? "EXPO_PUBLIC_CONVEX_URL"
      : "VITE_CONVEX_URL";
  return { key, value: effectiveConvexUrl };
}

/**
 * Build the full frontend env map (DB rows + the injected platform var).
 * The platform var always wins over any user row with the same key.
 */
export async function buildFrontendEnvMap(
  projectId: string,
): Promise<Record<string, string>> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return {};

  const env: Record<string, string> = {};

  const userVars = await db
    .select()
    .from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, projectId));
  for (const row of userVars) {
    if (row.key) env[row.key] = row.value ?? "";
  }

  const platformVar = platformConvexEnvVar(project);
  if (platformVar) env[platformVar.key] = platformVar.value;

  return env;
}

/**
 * Regenerate `/vercel/sandbox/.env` from the DB. Safe to call repeatedly.
 * Throws if the sandbox write fails so callers can decide whether it's fatal
 * (dev-server start) or best-effort (panel save).
 */
export async function materializeFrontendEnv(projectId: string): Promise<void> {
  const env = await buildFrontendEnvMap(projectId);
  await writeSandboxEnvFile(projectId, env);
}
