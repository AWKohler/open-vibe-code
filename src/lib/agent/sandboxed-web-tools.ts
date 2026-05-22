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
import { getPersistentTools } from "./persistent-tools";
import { deployConvexFromSandbox } from "@/lib/sandbox-convex-deploy";
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

export function getSandboxedWebTools(params: {
  projectId: string;
  hasBackend: boolean;
  appBaseUrl: string;
  authHeaders?: Record<string, string>;
  convexUrl?: string;
}) {
  const { projectId, hasBackend, appBaseUrl, authHeaders, convexUrl } = params;
  const baseTools = getPersistentTools(projectId);
  const workspaceTools = getWorkspaceControlTools(projectId);

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
    } as const;
  }

  return {
    ...baseTools,
    ...workspaceTools,
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
        const json = await res.json().catch(() => ({ ok: false, error: "Invalid response from setup-auth endpoint." }));
        return json;
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
