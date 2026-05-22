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
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { resolveToolToken } from "@/lib/agent/claude-code/tool-token";
import {
  buildConvexDeployZip,
  writeGeneratedConvexFiles,
  type DeployResult,
} from "@/lib/sandbox-convex-deploy";

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
    default:
      return NextResponse.json(
        { ok: false, error: `Unknown tool: ${tool}` },
        { status: 400 },
      );
  }
}
