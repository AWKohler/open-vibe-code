/**
 * Server-side tool surface for the sandboxed-web platform.
 *
 * Reuses the persistent-tools (bash/read/write/edit/applyDiff/glob/grep/listFiles/endTurn)
 * and adds:
 *  - `convexDeploy` — zips /convex + support files from the sandbox and posts to
 *    the existing Fly worker via /api/projects/:id/convex/deploy.
 *
 * For projects with `backendType === 'none'` we:
 *  - omit `convexDeploy` so the model can't call it.
 *  - wrap `write` and `bash` to refuse writes / installs that would create a
 *    `/convex` folder or pull Convex packages. This is a hard guard so a
 *    stubborn model can't bypass the prompt instructions.
 */
import { tool } from "ai";
import { z } from "zod";
import { getPersistentTools } from "./persistent-tools";
import { deployConvexFromSandbox } from "@/lib/sandbox-convex-deploy";

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

export function getSandboxedWebTools(params: {
  projectId: string;
  hasBackend: boolean;
  appBaseUrl: string;
  authHeaders?: Record<string, string>;
  convexUrl?: string;
}) {
  const { projectId, hasBackend, appBaseUrl, authHeaders, convexUrl } = params;
  const baseTools = getPersistentTools(projectId);

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
    } as const;
  }

  return {
    ...baseTools,
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
