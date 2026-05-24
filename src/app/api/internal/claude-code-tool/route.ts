/**
 * /api/internal/claude-code-tool
 *
 * Internal callback endpoint for the Claude Code bridge running inside a
 * sandbox. Authenticated via a short-lived bearer token (NOT Clerk) so the
 * sandbox can call back without holding a Clerk session.
 *
 * The whole point of this endpoint is that platform-managed secrets (e.g.
 * the Convex platform deploy key) must NEVER enter the sandbox env. The
 * bridge POSTs a tool name + input here; we look up the credentials
 * server-side and run the tool under the user's context. Result is returned
 * in the response body, where the bridge passes it back to Claude Code as
 * the MCP tool's result.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatQuestions, projects } from "@/db/schema";
import { resolveToolToken } from "@/lib/agent/claude-code/tool-token";
import {
  buildConvexDeployZip,
  writeGeneratedConvexFiles,
  type DeployResult,
} from "@/lib/sandbox-convex-deploy";
import { setupConvexAuth, refreshAuthSiteUrl } from "@/lib/convex-auth-setup";
import { getUserCredentials } from "@/lib/user-credentials";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import {
  getSandboxBrowserLog,
  getSandboxDevServerLog,
  isSandboxDevServerRunning,
  requestSandboxPreviewRefresh,
  startSandboxDevServer,
  stopSandboxDevServer,
} from "@/lib/workspace-control";
import {
  abortMerge,
  commitAll,
  getCurrentBranch,
  getDiff,
  getStatus,
  hasGitDir,
  pullBranch,
  pushBranch,
  resolveWithContent,
  resolveWithSide,
} from "@/lib/sandbox-git";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FLY_WORKER_URL = process.env.FLY_WORKER_URL;
const WORKER_AUTH_TOKEN =
  process.env.FLY_WORKER_AUTH_TOKEN ?? process.env.WORKER_AUTH_TOKEN ?? "";

interface RequestBody {
  tool: string;
  input?: Record<string, unknown>;
}

export async function POST(req: Request) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return NextResponse.json({ ok: false, error: "Missing bearer token" }, { status: 401 });
  }
  const binding = await resolveToolToken(match[1]);
  if (!binding) {
    return NextResponse.json({ ok: false, error: "Invalid or expired tool token" }, { status: 401 });
  }

  // ── Parse ────────────────────────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const { tool } = body;
  if (!tool || typeof tool !== "string") {
    return NextResponse.json({ ok: false, error: "tool field is required" }, { status: 400 });
  }

  // ── Project lookup + ownership re-check ─────────────────────────────────
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, binding.projectId));
  if (!project || project.userId !== binding.userId) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────
  switch (tool) {
    case "convex_deploy": {
      if (project.backendType === "none") {
        return NextResponse.json({
          ok: false,
          content: "This project was created with the No Backend option — there's nothing to deploy.",
        });
      }
      const deployKey = (project.userConvexDeployKey || project.convexDeployKey || "").trim();
      if (!deployKey) {
        return NextResponse.json({
          ok: false,
          content: "No Convex deploy key is available for this project. Reconnect Convex from Settings.",
        });
      }

      if (!FLY_WORKER_URL) {
        return NextResponse.json({
          ok: false,
          content: "Convex deploy worker is not configured on the server (FLY_WORKER_URL missing).",
        });
      }

      // Build the zip from the project's sandbox FS.
      let zipBlob = await buildConvexDeployZip(binding.projectId);
      if (!zipBlob) {
        // Sandbox may have expired and been re-created empty. Try auto-seeding.
        try {
          const { seedSandboxIfEmpty, writeSandboxEnvFile } = await import("@/lib/vercel-sandbox");
          const seeded = await seedSandboxIfEmpty(binding.projectId, "viteConvex");
          if (seeded) {
            const convexUrl = project.userConvexUrl || project.convexDeployUrl;
            if (convexUrl) {
              await writeSandboxEnvFile(binding.projectId, { VITE_CONVEX_URL: convexUrl }).catch(() => undefined);
            }
            zipBlob = await buildConvexDeployZip(binding.projectId);
          }
        } catch (reseedErr) {
          console.warn("[claude-code-tool] auto-reseed failed:", reseedErr);
        }
      }
      if (!zipBlob) {
        return NextResponse.json({
          ok: false,
          content: "No /convex folder found in this project — nothing to deploy.",
        });
      }

      // Hand off to the same Fly worker the WebContainer flow uses.
      let workerResponse: Response;
      try {
        workerResponse = await fetch(FLY_WORKER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WORKER_AUTH_TOKEN}`,
            "X-Convex-Deploy-Key": deployKey,
          },
          body: zipBlob,
        });
      } catch (fetchError) {
        return NextResponse.json({
          ok: false,
          content: `Deployment service unreachable: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
        });
      }

      let workerJson: {
        success?: boolean;
        logs?: string;
        error?: string;
        generatedFiles?: { path: string; content: string }[];
      };
      try {
        workerJson = await workerResponse.json();
      } catch {
        return NextResponse.json({
          ok: false,
          content: `Deployment service returned an unexpected response (status ${workerResponse.status}).`,
        });
      }

      if (!workerResponse.ok || !workerJson.success) {
        return NextResponse.json({
          ok: false,
          content: `Convex deploy failed.\n${workerJson.error ?? ""}\n${workerJson.logs ?? ""}`.trim(),
        });
      }

      // Sync the generated types back into the sandbox so the agent's next
      // read/grep sees fresh `_generated/api.d.ts` etc.
      if (workerJson.generatedFiles && workerJson.generatedFiles.length > 0) {
        await writeGeneratedConvexFiles(binding.projectId, workerJson.generatedFiles);
      }

      const result: DeployResult = {
        ok: true,
        output: workerJson.logs ?? "",
        generatedFiles: workerJson.generatedFiles ?? [],
      };

      return NextResponse.json({
        ok: true,
        content: `Convex deployment completed.\n\n${result.output}`.trim(),
        generatedFilesCount: result.generatedFiles?.length ?? 0,
      });
    }
    // ── Workspace control: dev server lifecycle + browser/dev logs ──────
    // All six tools call into the same server-side primitives the Botflow
    // sandboxed-web agent uses, so the two agent paths stay in lockstep.
    case "startDevServer": {
      const result = await startSandboxDevServer(binding.projectId, {
        port: 5173,
        installFirst: true,
      });
      if (result.ok && result.previewUrl) {
        // Keep SITE_URL in sync — fire-and-forget, non-fatal.
        void refreshAuthSiteUrl(binding.projectId, result.previewUrl).catch(() => {});
      }
      // Terse content — URL intentionally withheld. The user's workspace
      // polls preview-state and surfaces the preview automatically.
      const content = result.ok
        ? "Dev server started. The preview is now visible to the user."
        : (result.log ? `${result.message}\n\nLast log:\n${result.log.slice(-2000)}` : result.message);
      return NextResponse.json({ ok: result.ok, content });
    }

    case "stopDevServer": {
      const result = await stopSandboxDevServer(binding.projectId);
      return NextResponse.json({
        ok: result.ok,
        content: result.ok
          ? (result.alreadyStopped ? "Dev server was not running." : "Dev server stopped.")
          : result.message,
        alreadyStopped: Boolean(result.alreadyStopped),
      });
    }

    case "isDevServerRunning": {
      const result = await isSandboxDevServerRunning(binding.projectId);
      return NextResponse.json({
        ok: result.ok,
        content: result.message,
        running: result.running,
      });
    }

    case "getDevServerLog": {
      const linesBack = typeof body.input?.linesBack === "number" ? body.input.linesBack : 200;
      const result = await getSandboxDevServerLog(binding.projectId, linesBack);
      return NextResponse.json({
        ok: result.ok,
        content: result.log ?? result.message,
      });
    }

    case "getBrowserLog": {
      const linesBack = typeof body.input?.linesBack === "number" ? body.input.linesBack : 200;
      const result = await getSandboxBrowserLog(binding.projectId, linesBack);
      return NextResponse.json({
        ok: result.ok,
        content: result.log ?? result.message,
      });
    }

    case "refreshPreview": {
      const result = await requestSandboxPreviewRefresh(binding.projectId);
      return NextResponse.json({
        ok: result.ok,
        content: result.message,
      });
    }

    case "setup_auth": {
      if (project.backendType === "none") {
        return NextResponse.json({
          ok: false,
          content: "This project has no backend — Convex Auth is not available.",
        });
      }
      if (project.platform !== "sandboxed-web") {
        return NextResponse.json({
          ok: false,
          content: "setupAuth is only available for sandboxed-web projects.",
        });
      }

      // Resolve SITE_URL from the sandbox's stable preview domain
      let siteUrl = "https://placeholder.example.com";
      try {
        const sandbox = await getOrCreatePersistentSandbox(binding.projectId);
        siteUrl = sandbox.domain(5173);
      } catch {
        // Non-fatal — placeholder is acceptable
      }

      let userConvexOAuthToken: string | null = null;
      if (project.backendType === "user") {
        const creds = await getUserCredentials(binding.userId);
        userConvexOAuthToken = creds.convexOAuthAccessToken;
        if (!userConvexOAuthToken) {
          return NextResponse.json({
            ok: false,
            content:
              "Your Convex account is not connected. Please reconnect it in Settings → Connections before setting up auth.",
          });
        }
      }

      let authResult;
      try {
        authResult = await setupConvexAuth(binding.projectId, { siteUrl, userConvexOAuthToken });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[claude-code-tool/setup_auth] threw:", err);
        return NextResponse.json({ ok: false, content: `setupAuth failed: ${message}` });
      }
      if (!authResult.ok) {
        return NextResponse.json({ ok: false, content: authResult.error });
      }

      return NextResponse.json({
        ok: true,
        content: authResult.context,
        files: authResult.files,
        packagesToInstall: authResult.packagesToInstall,
      });
    }

    case "setup_oauth_provider": {
      if (!project.authConfigured) {
        return NextResponse.json({
          ok: false,
          content: "Auth must be set up before adding OAuth providers. Call setup_auth first.",
        });
      }
      if (project.backendType === "none") {
        return NextResponse.json({
          ok: false,
          content: "This project has no backend — OAuth providers are not available.",
        });
      }

      // We re-use the REST API endpoints rather than duplicating the DB logic.
      // The internal tool token doesn't carry a Clerk session, so we call the
      // Next.js API with a synthetic request that includes the user's context
      // via a server-side URL call. Instead, we duplicate the minimal logic here.
      const { getDb: getDbLocal } = await import("@/db");
      const { oauthProviderRequests: oauthTable } = await import("@/db/schema");
      const { eq: eqLocal, and: andLocal, desc: descLocal } = await import("drizzle-orm");

      const dbLocal = getDbLocal();

      const inputProvider = (body.input?.provider as string | undefined) ?? "google";
      if (inputProvider !== "google") {
        return NextResponse.json({
          ok: false,
          content: `Unsupported OAuth provider: ${inputProvider}. Only 'google' is supported.`,
        });
      }

      const deployUrl = project.userConvexUrl ?? project.convexDeployUrl ?? null;
      const convexSiteUrl = deployUrl
        ? deployUrl.replace(".convex.cloud", ".convex.site")
        : null;

      // Cancel stale pending requests
      await dbLocal
        .update(oauthTable)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(
          andLocal(
            eqLocal(oauthTable.projectId, project.id),
            eqLocal(oauthTable.status, "pending"),
          ),
        );

      // Create new request
      const [oauthRecord] = await dbLocal
        .insert(oauthTable)
        .values({
          projectId: project.id,
          userId: binding.userId,
          provider: inputProvider,
          status: "pending",
          convexSiteUrl,
        })
        .returning();

      const requestId = oauthRecord.id;

      // Poll for up to 5 minutes for the user to complete the modal
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 3000));

        const [statusRow] = await dbLocal
          .select({ status: oauthTable.status })
          .from(oauthTable)
          .where(
            andLocal(
              eqLocal(oauthTable.id, requestId),
              eqLocal(oauthTable.projectId, project.id),
            ),
          )
          .limit(1);

        if (!statusRow) break; // Shouldn't happen — bail gracefully

        if (statusRow.status === "completed") {
          return NextResponse.json({
            ok: true,
            content: `=== GOOGLE OAUTH CREDENTIALS SAVED ===

AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are now set on your Convex deployment.

REQUIRED NEXT STEPS:

1. Update convex/auth.ts — add the Google provider:

   import { convexAuth } from "@convex-dev/auth/server";
   import { Password } from "@convex-dev/auth/providers/Password";
   import Google from "@auth/core/providers/google";

   export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
     providers: [Password, Google],
   });

2. Run convex_deploy to push the updated auth config.

3. Add a Google sign-in button to the UI:

   const { signIn } = useAuthActions();
   <button onClick={() => void signIn("google")}>Sign in with Google</button>

   Clicking the button redirects to Google's consent screen.
   On return, Convex Auth creates or merges the user account automatically.`,
          });
        }

        if (statusRow.status === "dismissed") {
          return NextResponse.json({
            ok: false,
            content:
              "User dismissed the Google OAuth modal without saving credentials. " +
              "Do not retry automatically. Continue with other work.",
          });
        }
        // status === 'pending' — keep polling
      }

      return NextResponse.json({
        ok: false,
        content:
          "Timed out waiting for Google OAuth credentials (5 minutes). " +
          "Call setup_oauth_provider again when the user is ready.",
      });
    }

    case "ask_question": {
      // Mirror of the Botflow askQuestion execute: insert a chat_questions
      // row keyed by a synthetic tool_call_id, poll for an answer, return.
      const inputQuestions = body.input?.questions;
      if (!Array.isArray(inputQuestions) || inputQuestions.length === 0) {
        return NextResponse.json({
          ok: false,
          content: "askQuestion requires a non-empty questions array.",
        });
      }

      const toolCallId = `claude-${randomUUID()}`;
      const dbLocal = getDb();
      await dbLocal.insert(chatQuestions).values({
        projectId: binding.projectId,
        userId: binding.userId,
        segmentId: project.currentSegmentId,
        toolCallId,
        questions: inputQuestions as unknown as object,
        status: "pending",
      });

      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        const [row] = await dbLocal
          .select({ status: chatQuestions.status, answer: chatQuestions.answer })
          .from(chatQuestions)
          .where(
            and(
              eq(chatQuestions.toolCallId, toolCallId),
              eq(chatQuestions.projectId, binding.projectId),
            ),
          )
          .limit(1);
        if (!row) break;
        if (row.status === "answered") {
          const ans = row.answer as
            | { selectedIds?: string[]; selectedLabels?: string[]; text?: string | null }
            | null;
          const labels = ans?.selectedLabels ?? [];
          const summary = labels.length > 0
            ? `User picked: ${labels.join(", ")}${ans?.text ? ` (with custom note: "${ans.text}")` : ""}`
            : (ans?.text ?? "Answered");
          return NextResponse.json({
            ok: true,
            content: summary,
            answered: true,
            selectedIds: ans?.selectedIds ?? [],
            selectedLabels: labels,
            customText: ans?.text ?? null,
          });
        }
        if (row.status === "dismissed") {
          return NextResponse.json({
            ok: true,
            content: "User dismissed the question without picking an option. Do not retry; continue with whatever default is reasonable.",
            answered: false,
            dismissed: true,
          });
        }
      }

      await dbLocal
        .update(chatQuestions)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(
          and(
            eq(chatQuestions.toolCallId, toolCallId),
            eq(chatQuestions.projectId, binding.projectId),
          ),
        )
        .catch(() => undefined);
      return NextResponse.json({
        ok: true,
        content: "Question timed out (5 minutes) without an answer. Continue with a reasonable default.",
        answered: false,
        timedOut: true,
      });
    }

    // ── Git tools — gated server-side by the project having a linked repo ──
    case "git_status": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({
          ok: false,
          content: "This project has no GitHub repository linked.",
        });
      }
      if (!(await hasGitDir(binding.projectId))) {
        return NextResponse.json({
          ok: false,
          content: "Sandbox has no .git directory. Ask the user to re-link the repository.",
        });
      }
      const res = await getStatus(binding.projectId);
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      return NextResponse.json({ ok: true, content: JSON.stringify(res.status) });
    }

    case "git_diff": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const path = typeof body.input?.path === "string" ? body.input.path : undefined;
      const staged = body.input?.staged === true;
      const res = await getDiff(binding.projectId, { path, staged });
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      return NextResponse.json({ ok: true, content: res.diff ?? "(no changes)" });
    }

    case "git_commit": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const message = typeof body.input?.message === "string" ? body.input.message.trim() : "";
      if (!message) {
        return NextResponse.json({ ok: false, content: "Commit message is required." });
      }
      const res = await commitAll(binding.projectId, message);
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      if (res.nothingToCommit) {
        return NextResponse.json({ ok: true, content: "No changes to commit." });
      }
      return NextResponse.json({ ok: true, content: `Committed as ${res.sha}.` });
    }

    case "git_push": {
      if (!project.githubRepoOwner || !project.githubRepoName) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const creds = await getUserCredentials(binding.userId);
      if (!creds.githubAccessToken) {
        return NextResponse.json({ ok: false, content: "GitHub not connected." });
      }
      const cur = await getCurrentBranch(binding.projectId);
      const branch = cur.ok && cur.branch ? cur.branch : (project.githubDefaultBranch ?? "main");
      const force = body.input?.force === true;
      const res = await pushBranch(binding.projectId, {
        token: creds.githubAccessToken,
        owner: project.githubRepoOwner,
        name: project.githubRepoName,
        branch,
        force,
      });
      if (!res.ok) {
        const note = res.code === "non-fast-forward"
          ? " Call git_pull first, resolve any conflicts, then retry git_push."
          : "";
        return NextResponse.json({ ok: false, content: `${res.message}${note}` });
      }
      return NextResponse.json({ ok: true, content: `Pushed ${res.newSha} to ${branch}.` });
    }

    case "git_pull": {
      if (!project.githubRepoOwner || !project.githubRepoName) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const creds = await getUserCredentials(binding.userId);
      if (!creds.githubAccessToken) {
        return NextResponse.json({ ok: false, content: "GitHub not connected." });
      }
      const cur = await getCurrentBranch(binding.projectId);
      const branch = cur.ok && cur.branch ? cur.branch : (project.githubDefaultBranch ?? "main");
      const res = await pullBranch(binding.projectId, {
        token: creds.githubAccessToken,
        owner: project.githubRepoOwner,
        name: project.githubRepoName,
        branch,
      });
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      if (res.clean) return NextResponse.json({ ok: true, content: "Up to date / fast-forwarded." });
      return NextResponse.json({
        ok: true,
        content: `Merge conflicts to resolve in:\n${res.conflicts.join("\n")}\n\nResolve each with git_resolve_conflict, then call git_commit with a merge message.`,
        conflicts: res.conflicts,
      });
    }

    case "git_resolve_conflict": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const path = typeof body.input?.path === "string" ? body.input.path : "";
      if (!path) return NextResponse.json({ ok: false, content: "path is required." });
      const side = body.input?.side;
      const content = body.input?.content;
      if (side === "ours" || side === "theirs") {
        const res = await resolveWithSide(binding.projectId, path, side);
        if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
        return NextResponse.json({ ok: true, content: `Resolved ${path} with ${side}.` });
      }
      if (typeof content === "string") {
        const res = await resolveWithContent(binding.projectId, path, content);
        if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
        return NextResponse.json({ ok: true, content: `Resolved ${path} with custom merge.` });
      }
      return NextResponse.json({
        ok: false,
        content: "Provide either side=ours|theirs or content=<merged text>.",
      });
    }

    case "git_abort_merge": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const res = await abortMerge(binding.projectId);
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      return NextResponse.json({ ok: true, content: "Merge aborted; working tree restored." });
    }

    case "open_pull_request": {
      if (!project.githubRepoOwner || !project.githubRepoName) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const creds = await getUserCredentials(binding.userId);
      if (!creds.githubAccessToken) {
        return NextResponse.json({ ok: false, content: "GitHub not connected." });
      }
      const title = typeof body.input?.title === "string" ? body.input.title.trim() : "";
      if (!title) return NextResponse.json({ ok: false, content: "title is required." });
      const cur = await getCurrentBranch(binding.projectId);
      const head = (typeof body.input?.headBranch === "string" && body.input.headBranch.trim())
        || (cur.ok && cur.branch ? cur.branch : (project.githubDefaultBranch ?? "main"));
      const base = (typeof body.input?.baseBranch === "string" && body.input.baseBranch.trim())
        || (project.githubDefaultBranch ?? "main");
      if (head === base) {
        return NextResponse.json({
          ok: false,
          content: "PR head and base are the same branch. Create a feature branch first.",
        });
      }
      const ghRes = await fetch(
        `https://api.github.com/repos/${project.githubRepoOwner}/${project.githubRepoName}/pulls`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.githubAccessToken}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title,
            body: body.input?.body ?? undefined,
            head,
            base,
            draft: body.input?.draft === true,
          }),
        },
      );
      if (ghRes.ok) {
        const pr = await ghRes.json() as { html_url: string; number: number };
        return NextResponse.json({
          ok: true,
          content: `Opened PR #${pr.number}: ${pr.html_url}`,
          url: pr.html_url,
          number: pr.number,
        });
      }
      if (ghRes.status === 422) {
        const listRes = await fetch(
          `https://api.github.com/repos/${project.githubRepoOwner}/${project.githubRepoName}/pulls?head=${encodeURIComponent(`${project.githubRepoOwner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
          {
            headers: {
              Authorization: `Bearer ${creds.githubAccessToken}`,
              Accept: "application/vnd.github.v3+json",
            },
          },
        );
        if (listRes.ok) {
          const list = await listRes.json() as Array<{ html_url: string; number: number }>;
          if (list.length > 0) {
            return NextResponse.json({
              ok: true,
              content: `A PR for this branch already exists: ${list[0].html_url}`,
              url: list[0].html_url,
              number: list[0].number,
              alreadyExists: true,
            });
          }
        }
      }
      const err = (await ghRes.json().catch(() => ({}))) as { message?: string };
      return NextResponse.json({ ok: false, content: err.message ?? `GitHub ${ghRes.status}` });
    }

    case "set_git_autonomy": {
      const mode = body.input?.mode;
      if (mode !== "autonomous" && mode !== "manual" && mode !== "ask-each-time") {
        return NextResponse.json({
          ok: false,
          content: "mode must be 'autonomous', 'manual', or 'ask-each-time'.",
        });
      }
      const db = getDb();
      await db
        .update(projects)
        .set({ gitAutonomy: mode, updatedAt: new Date() })
        .where(eq(projects.id, binding.projectId));
      return NextResponse.json({ ok: true, content: `Git autonomy set to ${mode}.` });
    }

    default:
      return NextResponse.json(
        { ok: false, error: `Unknown tool: ${tool}` },
        { status: 400 },
      );
  }
}
