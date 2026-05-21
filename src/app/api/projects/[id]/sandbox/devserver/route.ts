import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEV_LOG_PATH = "/tmp/dev-server.log";

// POST: start the dev server.
//
// Lessons learned: `nohup ... &` inside a sandbox.runCommand({...}) (no
// `detached: true`) doesn't reliably daemonize — the runCommand call returns
// but the background child appears to die immediately, leaving an empty log.
// The pattern that works (used by the original swift dev-server route) is
// `detached: true` on the sandbox SDK call itself with the redirect inside
// the shell. That's what we do here.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));

  if (!project || project.userId !== userId || (project.platform !== "swift" && project.platform !== "sandboxed-web")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json() as { port?: number; installFirst?: boolean };
  const port = body.port ?? 5173;
  const installFirst = body.installFirst ?? false;

  try {
    const sandbox = await getOrCreatePersistentSandbox(project.id);

    let previewUrl: string;
    try {
      previewUrl = sandbox.domain(port);
    } catch {
      return NextResponse.json(
        { error: "no_port_route", message: `Port ${port} was not declared at sandbox creation. Allowed: 3000, 5173, 4173, 8000.` },
        { status: 409 },
      );
    }

    // Kill any prior vite/dev server.
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "pkill -f 'vite' 2>/dev/null || true; sleep 0.3; rm -f " + DEV_LOG_PATH],
      cwd: "/vercel/sandbox",
    });

    if (installFirst) {
      const installResult = await sandbox.runCommand({
        cmd: "pnpm",
        args: ["install", "--prefer-offline"],
        cwd: "/vercel/sandbox",
      });
      if (installResult.exitCode !== 0) {
        const err = await installResult.stderr();
        const out = await installResult.stdout();
        return NextResponse.json(
          { error: `pnpm install failed (exit ${installResult.exitCode})`, stderr: err.slice(-2000), stdout: out.slice(-2000) },
          { status: 500 },
        );
      }
    }

    // Verify vite actually got installed before we try to spawn it.
    const viteCheck = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "test -x /vercel/sandbox/node_modules/.bin/vite && echo OK || echo MISSING"],
      cwd: "/vercel/sandbox",
    });
    const viteStatus = (await viteCheck.stdout()).trim();
    if (viteStatus !== "OK") {
      return NextResponse.json(
        {
          error: "vite is not installed at node_modules/.bin/vite. The template may be missing it from dependencies, or pnpm install did not run.",
          hint: "Pass installFirst: true on the next request, or check the template's package.json.",
        },
        { status: 500 },
      );
    }

    // Write a wrapper Vite config that imports the user's vite.config and
    // overlays `server.allowedHosts: true`. Vite 5+ rejects requests whose
    // Host header isn't on the allowlist (DNS rebinding protection), so the
    // random `*.vercel.run` subdomain would otherwise return:
    //   "Blocked request. This host is not allowed."
    // We use `loadConfigFromFile` (public Vite API) so the user's vite.config
    // stays untouched — the agent and the user can edit it freely without
    // breaking the public preview.
    const WRAPPER_CONFIG = `import { defineConfig, mergeConfig, loadConfigFromFile } from "vite";
import path from "node:path";

export default defineConfig(async ({ command, mode }) => {
  const candidates = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];
  let userConfig = {};
  for (const file of candidates) {
    const abs = path.resolve(process.cwd(), file);
    try {
      const result = await loadConfigFromFile({ command, mode }, abs);
      if (result?.config) { userConfig = result.config; break; }
    } catch (e) {
      console.warn("[botflow] Failed to load " + file + ":", e?.message ?? e);
    }
  }
  return mergeConfig(userConfig, {
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
    },
  });
});
`;
    await sandbox.writeFiles([{
      path: "/vercel/sandbox/.botflow-vite.config.mjs",
      content: Buffer.from(WRAPPER_CONFIG, "utf-8"),
    }]);

    // Spawn vite as a detached process. detached:true is the sandbox SDK's
    // signal to background the process — runCommand returns immediately and
    // the process keeps running. We use the shell so we can redirect output
    // to a log file we can tail on failure. `--config` points at our wrapper
    // so allowedHosts always wins.
    await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        `exec ./node_modules/.bin/vite --config .botflow-vite.config.mjs --host 0.0.0.0 --port ${port} --strictPort > ${DEV_LOG_PATH} 2>&1`,
      ],
      cwd: "/vercel/sandbox",
      detached: true,
      env: { HOST: "0.0.0.0" },
    });

    // Poll the *public* Vercel-forwarded URL. This is the same URL the iframe
    // uses, so we only return success when the iframe will actually work.
    const deadline = Date.now() + 45_000;
    let lastStatus = 0;
    let lastHeaders: Record<string, string> = {};

    while (Date.now() < deadline) {
      try {
        const probe = await fetch(previewUrl, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(3_000),
        });
        lastStatus = probe.status;
        // Capture every header the proxy sends — so the client can show us
        // exactly which directive (X-Frame-Options, CSP frame-ancestors, etc.)
        // is preventing the iframe from loading.
        const captured: Record<string, string> = {};
        probe.headers.forEach((v, k) => { captured[k] = v; });
        lastHeaders = captured;
        if (probe.status < 500) {
          return NextResponse.json({ previewUrl, port, responseHeaders: captured });
        }
      } catch {
        // network/timeout — keep polling
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Stash for the timeout error path too.
    void lastHeaders;

    // Timed out — gather diagnostics. ps + log tail + package.json snippet.
    const diag = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        [
          "echo '--- log ---'",
          `tail -n 80 ${DEV_LOG_PATH} 2>/dev/null || echo '(log empty or missing)'`,
          "echo '--- ps ---'",
          "ps -ef 2>/dev/null | grep -E 'vite|node' | grep -v grep || echo '(no vite/node processes)'",
          "echo '--- listening ports ---'",
          "(ss -ltnp 2>/dev/null || netstat -ltn 2>/dev/null || echo '(no ss/netstat)') | head -20",
          "echo '--- package.json scripts/deps ---'",
          "node -e \"const p=require('/vercel/sandbox/package.json'); console.log(JSON.stringify({scripts:p.scripts,dependencies:p.dependencies,devDependencies:p.devDependencies},null,2))\" 2>/dev/null || echo '(no package.json)'",
        ].join(" && "),
      ],
      cwd: "/vercel/sandbox",
    });
    const diagOut = (await diag.stdout()).trim();

    return NextResponse.json(
      {
        error: `Dev server did not become reachable on ${previewUrl} within 45s (last upstream status: ${lastStatus}).`,
        log: diagOut.slice(-5000),
        previewUrl,
      },
      { status: 504 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start dev server" },
      { status: 500 },
    );
  }
}
