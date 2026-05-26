/**
 * Server-side tool surface for the sandboxed-web platform.
 *
 * Layered on top of the persistent-tools (bash/read/write/edit/applyDiff/glob/
 * grep/listFiles/endTurn) with two extra groups:
 *
 *  1. Workspace control (always available, regardless of backend):
 *       startDevServer, stopDevServer, isDevServerRunning,
 *       getDevServerLog, getBrowserLog, refreshPreview.
 *     These let the agent verify what's actually running — they're how the
 *     model goes from "edits files and hopes" to "edits files and verifies."
 *     All execute server-side via `lib/workspace-control.ts`.
 *
 *  2. `convexDeploy` (only when hasBackend) — zips /convex + support files
 *     from the sandbox and posts to the Convex deploy worker.
 *
 * For projects with `backendType === 'none'` we additionally:
 *  - omit `convexDeploy` so the model can't call it.
 *  - wrap `write` and `bash` to refuse writes / installs that would create
 *    a `/convex` folder or pull Convex packages.
 */
import { tool } from "ai";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { getPersistentTools } from "./persistent-tools";
import { deployConvexFromSandbox } from "@/lib/sandbox-convex-deploy";
import { refreshAuthSiteUrl } from "@/lib/convex-auth-setup";
import { getDb } from "@/db";
import { projects, oauthProviderRequests } from "@/db/schema";
import { getUserCredentials } from "@/lib/user-credentials";
import {
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
import {
  getSandboxBrowserLog,
  getSandboxDevServerLog,
  isSandboxDevServerRunning,
  requestSandboxPreviewRefresh,
  startSandboxDevServer,
  stopSandboxDevServer,
} from "@/lib/workspace-control";

const CONVEX_BLOCK_REASON =
  "This project was created with the **No Backend** option. Writing to /convex/ is not allowed because there is no Convex deployment to deploy to. " +
  "If the user needs a database/auth, tell them this project is frontend-only and they'll need to create a new project with a backend.";

const CONVEX_INSTALL_BLOCK_REASON =
  "This project was created with the **No Backend** option. Installing `convex` or `@convex-dev/*` packages is not allowed — the project has no Convex deployment.";

function isConvexPath(p: string | undefined | null): boolean {
  if (!p) return false;
  const normalized = p.startsWith("/") ? p : `/${p}`;
  return normalized === "/convex" || normalized.startsWith("/convex/");
}

function isConvexInstallCommand(command: string): boolean {
  // Match `pnpm add convex`, `npm install @convex-dev/foo`, `yarn add convex@1.0`, etc.
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|i)\b[^&|;]*\b(?:convex(?:@|\s|$)|@convex-dev\/)/i.test(command);
}

/**
 * Build the workspace-control tool group. Same six tools regardless of backend
 * type — they operate on the dev server inside the sandbox and the browser
 * preview, neither of which knows or cares about Convex.
 */
function getWorkspaceControlTools(projectId: string) {
  return {
    startDevServer: tool({
      description:
        "Start the project's Vite dev server inside the sandbox. Idempotent — if already running, the previous instance is killed and a fresh one is started. " +
        "The user's preview pane updates automatically once the server is reachable; you don't need to communicate any URL. " +
        "May take up to ~45s the first time (npm install).",
      inputSchema: z.object({}),
      async execute() {
        const result = await startSandboxDevServer(projectId, {
          port: 5173,
          installFirst: true,
        });
        if (result.ok) {
          // Keep SITE_URL in sync with the current sandbox domain so Convex
          // Auth magic links always point at the right frontend. Fire-and-forget
          // — a stale SITE_URL only affects magic links, not password auth.
          if (result.previewUrl) {
            void refreshAuthSiteUrl(projectId, result.previewUrl).catch((err) => {
              console.warn("[startDevServer] SITE_URL refresh non-fatal:", err);
            });
          }
          // Terse message — the URL is intentionally withheld. The user's
          // workspace polls for state and shows the preview automatically;
          // there's no reason for the model to mention or leak the URL.
          return {
            ok: true,
            message: "Dev server started. The preview is now visible to the user.",
          };
        }
        return {
          ok: false,
          message: result.message,
          ...(result.log ? { log: result.log.slice(-2000) } : {}),
        };
      },
    }),
    stopDevServer: tool({
      description:
        "Stop the running dev server (kills the vite process). Idempotent; if nothing is running, reports that. The user's preview pane will go to a 'stopped' state automatically.",
      inputSchema: z.object({}),
      async execute() {
        const result = await stopSandboxDevServer(projectId);
        return {
          ok: result.ok,
          message: result.ok
            ? (result.alreadyStopped
                ? "Dev server was not running."
                : "Dev server stopped.")
            : result.message,
          alreadyStopped: Boolean(result.alreadyStopped),
        };
      },
    }),
    isDevServerRunning: tool({
      description:
        "Check whether the dev server is currently running. Cheap (~50ms). Use this before reading logs or refreshing the preview if you're not sure.",
      inputSchema: z.object({}),
      async execute() {
        const result = await isSandboxDevServerRunning(projectId);
        return {
          ok: result.ok,
          running: result.running,
          message: result.message,
        };
      },
    }),
    getDevServerLog: tool({
      description:
        "Tail the dev server's stdout/stderr (vite output: HMR events, build errors, warnings). Pass linesBack to control how many tail lines to return.",
      inputSchema: z.object({
        linesBack: z.number().int().positive().default(200)
          .describe("Number of lines from the end of the log"),
      }),
      async execute({ linesBack }) {
        const result = await getSandboxDevServerLog(projectId, linesBack);
        return {
          ok: result.ok,
          message: result.message,
          ...(result.log ? { log: result.log } : {}),
        };
      },
    }),
    getBrowserLog: tool({
      description:
        "Read the user's BROWSER console log from the running preview. This includes console.log/warn/error calls, runtime JavaScript errors, React errors, and Vite HMR events from inside the iframe. " +
        "Indispensable for diagnosing why a feature isn't working — the dev server log won't show client-side errors. " +
        "Returns the most recent entries with timestamps and level icons.",
      inputSchema: z.object({
        linesBack: z.number().int().positive().default(200)
          .describe("Number of recent entries to return"),
      }),
      async execute({ linesBack }) {
        const result = await getSandboxBrowserLog(projectId, linesBack);
        return {
          ok: result.ok,
          message: result.message,
          ...(result.log ? { log: result.log } : {}),
        };
      },
    }),
    refreshPreview: tool({
      description:
        "Force the preview iframe in the user's workspace to reload. Useful after changes that Vite HMR can't pick up (vite.config edits, route additions in some setups). The user's browser refreshes within ~2 seconds.",
      inputSchema: z.object({}),
      async execute() {
        const result = await requestSandboxPreviewRefresh(projectId);
        return {
          ok: result.ok,
          message: result.message,
        };
      },
    }),
  } as const;
}

/**
 * Git tools — only registered when the project has a GitHub repository
 * linked. Caller (getSandboxedWebTools) checks `proj.githubRepoOwner` and
 * passes the resolved metadata so the tools don't have to re-query per call.
 *
 * The autonomy-mode hint in each tool's description is what tells the agent
 * "commit yourself" vs. "wait for the user." The descriptions are static —
 * adjusting them per-project would require dynamic system-prompt-like
 * content; the autonomy hint here is part of the per-request tool list so
 * caching of the system prompt is preserved.
 */
function getGitTools(opts: {
  projectId: string;
  ownerName: { owner: string; name: string };
  branch: string;
  userId: string;
  autonomy: "autonomous" | "manual" | "ask-each-time" | null;
}) {
  const { projectId, ownerName, branch, userId, autonomy } = opts;

  const autonomyHint =
    autonomy === "autonomous"
      ? "AUTONOMY: After making meaningful changes you MUST call gitCommit AND THEN gitPush — both, in that order. gitCommit only writes a local commit; it does NOT contact GitHub. Never tell the user something is 'pushed' or 'saved to GitHub' until gitPush has returned successfully. Brief commit messages, no need to ask the user."
      : autonomy === "manual"
        ? "AUTONOMY: Do NOT call gitCommit or gitPush on your own. The user pushes from the panel; you only edit files."
        : autonomy === "ask-each-time"
          ? "AUTONOMY: Before calling gitCommit, use askQuestion to confirm the commit with the user."
          : "AUTONOMY: The user has just linked GitHub; ask them via askQuestion how they want commits handled, then call setGitAutonomy with their pick. Until then, do NOT call gitCommit yourself.";

  async function ensureLinked(): Promise<{ ok: false; error: string } | null> {
    if (!(await hasGitDir(projectId))) {
      return { ok: false, error: "Sandbox has no .git directory — ask the user to re-link the repo." };
    }
    return null;
  }

  return {
    gitStatus: tool({
      description:
        "Show the git working-tree status — branch, ahead/behind counts, added/modified/deleted/untracked/conflicted files. Cheap; call freely before commit/push to understand what will be saved. " +
        autonomyHint,
      inputSchema: z.object({}),
      async execute() {
        const guard = await ensureLinked();
        if (guard) return JSON.stringify(guard);
        const res = await getStatus(projectId);
        if (!res.ok) return JSON.stringify({ ok: false, error: res.message });
        return JSON.stringify({ ok: true, status: res.status });
      },
    }),

    gitDiff: tool({
      description:
        "Show the unified diff of working-tree changes. Use sparingly — diffs can be long. Pass `path` to narrow to one file; pass `staged: true` for index-vs-HEAD.",
      inputSchema: z.object({
        path: z.string().optional(),
        staged: z.boolean().optional(),
      }),
      async execute({ path, staged }) {
        const guard = await ensureLinked();
        if (guard) return JSON.stringify(guard);
        const res = await getDiff(projectId, { path, staged });
        if (!res.ok) return JSON.stringify({ ok: false, error: res.message });
        // Trim if huge.
        const diff = res.diff ?? "";
        return JSON.stringify({
          ok: true,
          diff: diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n…(truncated)` : diff,
        });
      },
    }),

    gitCommit: tool({
      description:
        "Stage all changes (git add -A) and create a local commit with the given message. Does NOT push. Returns nothingToCommit=true when the working tree is clean. " +
        autonomyHint,
      inputSchema: z.object({
        message: z.string().describe("Short, present-tense commit message — e.g. 'Add login form'."),
      }),
      async execute({ message }) {
        const guard = await ensureLinked();
        if (guard) return JSON.stringify(guard);
        const res = await commitAll(projectId, message);
        if (!res.ok) return JSON.stringify({ ok: false, error: res.message });
        return JSON.stringify({
          ok: true,
          sha: res.sha ?? null,
          nothingToCommit: Boolean(res.nothingToCommit),
        });
      },
    }),

    gitPush: tool({
      description:
        "Push the current branch to GitHub. On non-fast-forward (remote has new commits), returns code='non-fast-forward' — call gitPull first, resolve any conflicts, then retry. Use force=true only after the user explicitly approves overwriting remote. " +
        autonomyHint,
      inputSchema: z.object({
        force: z.boolean().optional(),
      }),
      async execute({ force }) {
        const guard = await ensureLinked();
        if (guard) return JSON.stringify(guard);
        const creds = await getUserCredentials(userId);
        if (!creds.githubAccessToken) {
          return JSON.stringify({ ok: false, error: "GitHub token missing — reconnect from Settings." });
        }
        const cur = await getCurrentBranch(projectId);
        const useBranch = cur.ok && cur.branch ? cur.branch : branch;
        const res = await pushBranch(projectId, {
          token: creds.githubAccessToken,
          owner: ownerName.owner,
          name: ownerName.name,
          branch: useBranch,
          force: force === true,
        });
        if (!res.ok) {
          return JSON.stringify({
            ok: false,
            error: res.message,
            code: res.code ?? null,
            hint: res.code === "non-fast-forward"
              ? "Call gitPull first; resolve conflicts via gitResolveConflict; then retry gitPush."
              : undefined,
          });
        }
        // Mirror lastPushedSha for the Phase F PR-open flow.
        if (res.newSha) {
          const db = getDb();
          await db
            .update(projects)
            .set({ githubLastPushedSha: res.newSha, updatedAt: new Date() })
            .where(eq(projects.id, projectId));
        }
        return JSON.stringify({ ok: true, newSha: res.newSha ?? null, branch: useBranch });
      },
    }),

    gitPull: tool({
      description:
        "Fetch and merge the current branch from GitHub. Returns { clean: true } on a clean fast-forward, or { clean: false, conflicts: [paths] } when files conflict. For each conflicted path, call gitResolveConflict to write a resolution. Once all are resolved, call gitCommit with a merge message.",
      inputSchema: z.object({}),
      async execute() {
        const guard = await ensureLinked();
        if (guard) return JSON.stringify(guard);
        const creds = await getUserCredentials(userId);
        if (!creds.githubAccessToken) {
          return JSON.stringify({ ok: false, error: "GitHub token missing — reconnect from Settings." });
        }
        const cur = await getCurrentBranch(projectId);
        const useBranch = cur.ok && cur.branch ? cur.branch : branch;
        const res = await pullBranch(projectId, {
          token: creds.githubAccessToken,
          owner: ownerName.owner,
          name: ownerName.name,
          branch: useBranch,
        });
        if (!res.ok) return JSON.stringify({ ok: false, error: res.message });
        if (res.clean) return JSON.stringify({ ok: true, clean: true });
        return JSON.stringify({ ok: true, clean: false, conflicts: res.conflicts });
      },
    }),

    gitResolveConflict: tool({
      description:
        "Resolve a merge conflict for one file. Pass side='ours' to keep the local version, side='theirs' to keep the remote version, or content=<merged text> to write a custom merge that combines both sides. The file is staged automatically; the merge isn't finalized until you call gitCommit with a merge message after all conflicts are resolved.",
      inputSchema: z.object({
        path: z.string(),
        side: z.enum(["ours", "theirs"]).optional(),
        content: z.string().optional(),
      }),
      async execute({ path, side, content }) {
        const guard = await ensureLinked();
        if (guard) return JSON.stringify(guard);
        if (side === "ours" || side === "theirs") {
          const res = await resolveWithSide(projectId, path, side);
          if (!res.ok) return JSON.stringify({ ok: false, error: res.message });
          return JSON.stringify({ ok: true, resolved: path, strategy: side });
        }
        if (typeof content === "string") {
          const res = await resolveWithContent(projectId, path, content);
          if (!res.ok) return JSON.stringify({ ok: false, error: res.message });
          return JSON.stringify({ ok: true, resolved: path, strategy: "custom" });
        }
        return JSON.stringify({
          ok: false,
          error: "Provide either side='ours'|'theirs' or content=<merged text>.",
        });
      },
    }),

    setGitAutonomy: tool({
      description:
        "Record the user's chosen git-autonomy mode for this project. Call this exactly once, right after asking the autonomy question with askQuestion. Modes:\n" +
        "  • 'autonomous' — you commit and push after meaningful changes without asking.\n" +
        "  • 'manual' — you never run git tools; the user saves from the panel.\n" +
        "  • 'ask-each-time' — you ask the user with askQuestion before each commit.",
      inputSchema: z.object({
        mode: z.enum(["autonomous", "manual", "ask-each-time"]),
      }),
      async execute({ mode }) {
        const db = getDb();
        await db
          .update(projects)
          .set({ gitAutonomy: mode, updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        return JSON.stringify({ ok: true, mode });
      },
    }),

    openPullRequest: tool({
      description:
        "Open a pull request on GitHub from the current branch to the linked default branch (or a custom base). Push your changes first — PRs require the head branch to exist on the remote. If a PR already exists for the same head→base pair, returns alreadyExists=true with the existing URL.",
      inputSchema: z.object({
        title: z.string().describe("PR title — short, present-tense, e.g. 'Add login form'."),
        body: z.string().optional().describe("Markdown PR description; summary of the change."),
        baseBranch: z.string().optional().describe("Target branch (defaults to the project's linked default branch)."),
        headBranch: z.string().optional().describe("Source branch (defaults to the sandbox's current branch)."),
        draft: z.boolean().optional(),
      }),
      async execute({ title, body, baseBranch, headBranch, draft }) {
        try {
          const creds = await getUserCredentials(userId);
          if (!creds.githubAccessToken) {
            return JSON.stringify({ ok: false, error: "GitHub not connected." });
          }

          const cur = await getCurrentBranch(projectId);
          const head = (headBranch ?? "").trim()
            || (cur.ok && cur.branch ? cur.branch : branch);
          const base = (baseBranch ?? "").trim() || branch;

          if (head === base) {
            return JSON.stringify({
              ok: false,
              error: "PR head and base are the same branch. Create a feature branch first.",
              code: "same-branch",
            });
          }

          const ghRes = await fetch(
            `https://api.github.com/repos/${ownerName.owner}/${ownerName.name}/pulls`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${creds.githubAccessToken}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ title, body, head, base, draft: draft ?? false }),
            },
          );
          if (ghRes.ok) {
            const pr = await ghRes.json() as { html_url: string; number: number };
            return JSON.stringify({ ok: true, url: pr.html_url, number: pr.number });
          }
          // 422 = same PR likely exists already; locate it.
          if (ghRes.status === 422) {
            const listRes = await fetch(
              `https://api.github.com/repos/${ownerName.owner}/${ownerName.name}/pulls?head=${encodeURIComponent(`${ownerName.owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
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
                return JSON.stringify({
                  ok: true,
                  alreadyExists: true,
                  url: list[0].html_url,
                  number: list[0].number,
                });
              }
            }
          }
          const err = (await ghRes.json().catch(() => ({}))) as { message?: string };
          return JSON.stringify({ ok: false, error: err.message ?? `GitHub ${ghRes.status}` });
        } catch (e) {
          return JSON.stringify({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    }),
  } as const;
}

export function getSandboxedWebTools(params: {
  projectId: string;
  hasBackend: boolean;
  appBaseUrl: string;
  authHeaders?: Record<string, string>;
  convexUrl?: string;
  /** GitHub link metadata; when set, the git_* tools are exposed to the agent. */
  github?: {
    owner: string;
    name: string;
    branch: string;
    userId: string;
    autonomy: "autonomous" | "manual" | "ask-each-time" | null;
  };
}) {
  const { projectId, hasBackend, appBaseUrl, authHeaders, convexUrl, github } = params;
  const baseTools = getPersistentTools(projectId);
  const workspaceTools = getWorkspaceControlTools(projectId);
  const gitTools = github
    ? getGitTools({
        projectId,
        ownerName: { owner: github.owner, name: github.name },
        branch: github.branch,
        userId: github.userId,
        autonomy: github.autonomy,
      })
    : ({} as const);

  if (!hasBackend) {
    // Wrap `write` and `bash` so the model literally cannot create /convex or
    // install Convex packages, regardless of what the prompt says or doesn't say.
    const guardedWrite = tool({
      description: baseTools.write.description,
      inputSchema: baseTools.write.inputSchema,
      async execute(input, ctx) {
        const { path } = input as { path: string };
        if (isConvexPath(path)) {
          return JSON.stringify({ ok: false, error: CONVEX_BLOCK_REASON, path });
        }
        return baseTools.write.execute!(input, ctx);
      },
    });

    const guardedBash = tool({
      description: baseTools.bash.description,
      inputSchema: baseTools.bash.inputSchema,
      async execute(input, ctx) {
        const { command } = input as { command: string };
        if (isConvexInstallCommand(command)) {
          return JSON.stringify({ ok: false, error: CONVEX_INSTALL_BLOCK_REASON, command });
        }
        // Also block `mkdir convex`, `mkdir /vercel/sandbox/convex`, etc.
        if (/\bmkdir\b[^&|;]*\bconvex\b/i.test(command)) {
          return JSON.stringify({ ok: false, error: CONVEX_BLOCK_REASON, command });
        }
        return baseTools.bash.execute!(input, ctx);
      },
    });

    return {
      ...baseTools,
      write: guardedWrite,
      bash: guardedBash,
      ...workspaceTools,
      ...gitTools,
    } as const;
  }

  return {
    ...baseTools,
    ...workspaceTools,
    ...gitTools,
    setupAuth: tool({
      description:
        "Provision Convex Auth on this project. Generates RSA signing keys server-side, sets CONVEX_AUTH_PRIVATE_KEY, JWKS, and SITE_URL on the Convex deployment (you never see the keys), and returns boilerplate files to write.\n\n" +
        "Call this ONCE before writing any auth code. After calling it:\n" +
        "1. Write each file in the returned `files` array using the write tool.\n" +
        "2. Run: pnpm add @convex-dev/auth @auth/core\n" +
        "3. Run convexDeploy to push the new auth schema and functions.\n" +
        "4. Wrap the app root in <ConvexAuthProvider> and add sign-in UI.\n\n" +
        "Do NOT call convexDeploy before writing the files. Calling this tool again just rotates the signing keys.",
      inputSchema: z.object({}),
      async execute() {
        const url = `${appBaseUrl}/api/projects/${projectId}/convex/setup-auth`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeaders ?? {}),
          },
        });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          // Non-JSON response — surface the raw body so the model can see what went wrong
          return {
            ok: false,
            error: `setup-auth returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`,
          };
        }
      },
    }),
    setupOAuthProvider: tool({
      description:
        "Add a Google OAuth provider to Convex Auth on this project. " +
        "Calling this tool causes a modal to appear in the user's workspace where they paste their Google OAuth Client ID and Secret.\n\n" +
        "PREREQUISITES:\n" +
        "  • setupAuth must have been called first.\n\n" +
        "FLOW:\n" +
        "  1. This tool creates a pending request and the workspace shows a modal immediately.\n" +
        "  2. The user opens Google Cloud Console, creates an OAuth Client ID, and pastes the credentials.\n" +
        "  3. This tool blocks (polls) until the user completes or dismisses the modal (up to 5 minutes).\n" +
        "  4. On success: credentials are saved server-side. You then update convex/auth.ts and run convexDeploy.\n" +
        "  5. On dismiss: returns an error. Stop trying — do not call this again unless the user asks.\n\n" +
        "AFTER SUCCESS:\n" +
        "  1. Add Google to convex/auth.ts providers array.\n" +
        "  2. Run convexDeploy.\n" +
        "  3. Add a 'Sign in with Google' button: signIn('google')",
      inputSchema: z.object({
        provider: z.literal("google").default("google").describe("OAuth provider to add. Currently only 'google' is supported."),
      }),
      async execute({ provider }) {
        // Direct DB access — avoids the Clerk auth problem that would arise
        // from server→server fetch calls which carry no session cookies.
        const db = getDb();

        // ── Verify project has auth configured ────────────────────────────
        const [proj] = await db
          .select({
            userId: projects.userId,
            authConfigured: projects.authConfigured,
            userConvexUrl: projects.userConvexUrl,
            convexDeployUrl: projects.convexDeployUrl,
          })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);

        if (!proj) {
          return { ok: false, error: "Project not found." };
        }
        if (!proj.authConfigured) {
          return {
            ok: false,
            error:
              "Auth must be set up before adding OAuth providers. Call setupAuth first.",
          };
        }

        const deployUrl = proj.userConvexUrl ?? proj.convexDeployUrl ?? null;
        const convexSiteUrl = deployUrl
          ? deployUrl.replace(".convex.cloud", ".convex.site")
          : null;

        // ── Cancel any stale pending requests ─────────────────────────────
        await db
          .update(oauthProviderRequests)
          .set({ status: "dismissed", updatedAt: new Date() })
          .where(
            and(
              eq(oauthProviderRequests.projectId, projectId),
              eq(oauthProviderRequests.status, "pending"),
            ),
          );

        // ── Create pending request — workspace modal appears on next poll ──
        const [record] = await db
          .insert(oauthProviderRequests)
          .values({
            projectId,
            userId: proj.userId,
            provider,
            status: "pending",
            convexSiteUrl,
          })
          .returning();

        const requestId = record.id;

        // ── Poll DB directly until completed/dismissed (up to 5 min) ──────
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise<void>((r) => setTimeout(r, 3000));

          const [statusRow] = await db
            .select({ status: oauthProviderRequests.status })
            .from(oauthProviderRequests)
            .where(
              and(
                eq(oauthProviderRequests.id, requestId),
                eq(oauthProviderRequests.projectId, projectId),
              ),
            )
            .limit(1);

          if (!statusRow) break; // Record disappeared — bail

          if (statusRow.status === "completed") {
            return {
              ok: true,
              provider,
              context: `=== GOOGLE OAUTH CREDENTIALS SAVED ===

AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are now set on your Convex deployment.

REQUIRED NEXT STEPS:

1. Update convex/auth.ts — add the Google provider:

   import { convexAuth } from "@convex-dev/auth/server";
   import { Password } from "@convex-dev/auth/providers/Password";
   import Google from "@auth/core/providers/google";

   export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
     providers: [Password, Google],
   });

2. Run convexDeploy to push the updated auth config.

3. Add a Google sign-in button to the UI:

   const { signIn } = useAuthActions();
   <button onClick={() => void signIn("google")}>Sign in with Google</button>

   Clicking the button redirects to Google's consent screen.
   On return, Convex Auth creates or merges the user account automatically.
   The <Authenticated> block updates reactively — no manual navigation needed.`,
            };
          }

          if (statusRow.status === "dismissed") {
            return {
              ok: false,
              error:
                "User declined to set up Google sign-in. The modal was dismissed and no credentials were saved. " +
                "Do not retry automatically. Continue with the rest of the implementation and tell the user " +
                "they can add Google sign-in later from the workspace.",
            };
          }
          // status === 'pending' — keep polling
        }

        return {
          ok: false,
          error:
            "Timed out waiting for Google OAuth credentials (5 minutes elapsed). " +
            "The modal is no longer visible. You can call setupOAuthProvider again when ready.",
        };
      },
    }),
    convexDeploy: tool({
      description:
        "Deploy Convex backend changes. Zips the /convex folder and supporting files (package.json, lock file, tsconfig.json) from the sandbox and sends them to the deploy worker. Streams may take several minutes. " +
        "Only call this AFTER editing files in /convex (functions, schema, cron jobs) — changes are not live until deployed.",
      inputSchema: z.object({}),
      async execute() {
        const result = await deployConvexFromSandbox({
          projectId,
          appBaseUrl,
          ...(authHeaders ? { authHeaders } : {}),
          convexUrl,
        });
        if (result.ok) {
          return {
            ok: true,
            message: "Convex deployment completed successfully.",
            output: result.output ?? "",
            generatedFilesCount: result.generatedFiles?.length ?? 0,
          };
        }
        return {
          ok: false,
          message: result.error ?? "Convex deployment failed.",
          output: result.output ?? "",
        };
      },
    }),
  } as const;
}
