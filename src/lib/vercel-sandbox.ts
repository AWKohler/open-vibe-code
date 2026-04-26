import { APIError, Sandbox } from "@vercel/sandbox";

const DEFAULT_RUNTIME = "node22";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

function assertSandboxAuth(): void {
  const hasOidcToken = Boolean(process.env.VERCEL_OIDC_TOKEN);
  const hasAccessTokenAuth =
    Boolean(process.env.VERCEL_TOKEN) &&
    Boolean(process.env.VERCEL_PROJECT_ID) &&
    Boolean(process.env.VERCEL_TEAM_ID);

  if (!hasOidcToken && !hasAccessTokenAuth) {
    throw new Error(
      "Missing Vercel Sandbox credentials. Run `vercel link` and `vercel env pull`, or set VERCEL_TOKEN, VERCEL_PROJECT_ID, and VERCEL_TEAM_ID.",
    );
  }
}

export function getPersistentSandboxName(projectId: string): string {
  return `botflow-project-${projectId}`;
}

export async function getOrCreatePersistentSandbox(projectId: string) {
  assertSandboxAuth();

  const name = getPersistentSandboxName(projectId);

  try {
    // beta SDK: Sandbox.get takes { name }; auto-resumes on next command if stopped
    return await Sandbox.get({ name });
  } catch (error) {
    if (error instanceof APIError) {
      // Log the full response body to help debug
      try {
        const body = await error.response.text();
        console.error(`Sandbox.get 400/404 body: ${body}`);
      } catch { /* ignore */ }
      if (error.response.status !== 404 && error.response.status !== 400) {
        throw error;
      }
    } else {
      throw error;
    }
  }

  try {
    return await Sandbox.create({
      name,
      runtime: DEFAULT_RUNTIME,
      timeout: DEFAULT_TIMEOUT_MS,
      ports: [5173, 3000, 4321, 8080],
      env: {
        BOTFLOW_PROJECT_ID: projectId,
        BOTFLOW_RUNTIME: "persistent",
      },
    });
  } catch (error) {
    if (error instanceof APIError) {
      try {
        const body = await error.response.text();
        console.error(`Sandbox.create error body: ${body}`);
        throw new Error(`Sandbox.create failed (${error.response.status}): ${body}`);
      } catch (inner) {
        if (inner instanceof Error && inner.message.startsWith("Sandbox.create failed")) throw inner;
      }
    }
    throw error;
  }
}

// Re-create sandbox with ports registered, migrating files from the old one
export async function recreateSandboxWithPorts(projectId: string) {
  assertSandboxAuth();
  const name = getPersistentSandboxName(projectId);

  // Get the existing sandbox and read all files
  let fileBackup: Array<{ path: string; content: Buffer }> = [];
  try {
    const existing = await Sandbox.get({ name });
    const findResult = await existing.runCommand("find", [
      "/vercel/sandbox",
      "-type", "f",
      "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/.git/*",
    ]);
    const paths = (await findResult.stdout()).trim().split("\n").filter(Boolean);

    for (const p of paths) {
      const buf = await existing.readFileToBuffer({ path: p });
      if (buf) fileBackup.push({ path: p, content: buf });
    }

    await existing.delete();
  } catch {
    // Old sandbox may already be gone — proceed to create
  }

  const fresh = await Sandbox.create({
    name,
    runtime: DEFAULT_RUNTIME,
    timeout: DEFAULT_TIMEOUT_MS,
    ports: [5173, 3000, 4321, 8080],
    env: {
      BOTFLOW_PROJECT_ID: projectId,
      BOTFLOW_RUNTIME: "persistent",
    },
  });

  // Restore files
  if (fileBackup.length > 0) {
    await fresh.mkDir("/vercel/sandbox");
    for (const file of fileBackup) {
      const dir = file.path.substring(0, file.path.lastIndexOf("/"));
      if (dir) await fresh.mkDir(dir).catch(() => {});
      await fresh.writeFiles([{ path: file.path, content: file.content }]);
    }
  }

  return fresh;
}

// Seed a fresh sandbox with a Vite + React starter if /vercel/sandbox is empty
export async function seedSandboxIfEmpty(projectId: string): Promise<boolean> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);

  const check = await sandbox.runCommand("sh", [
    "-c",
    "ls /vercel/sandbox/package.json 2>/dev/null && echo EXISTS || echo EMPTY",
  ]);
  const out = (await check.stdout()).trim();
  if (out.includes("EXISTS")) return false; // already seeded

  // Clone a minimal Vite + React template
  await sandbox.runCommand("sh", ["-c",
    "cd /vercel && npm create vite@latest sandbox -- --template react-ts && cd sandbox && pnpm install",
  ]);
  return true;
}

export type PersistentSandboxSmokeTest = {
  sandboxName: string;
  runtime: string | undefined;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runPersistentSandboxSmokeTest(
  projectId: string,
): Promise<PersistentSandboxSmokeTest> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const result = await sandbox.runCommand("node", [
    "-e",
    [
      "const payload = {",
      `  projectId: ${JSON.stringify(projectId)},`,
      "  runtime: process.version,",
      "  cwd: process.cwd(),",
      "};",
      "console.log(JSON.stringify(payload));",
    ].join("\n"),
  ]);

  return {
    sandboxName: sandbox.name,
    runtime: sandbox.runtime,
    exitCode: result.exitCode,
    stdout: await result.stdout(),
    stderr: await result.stderr(),
  };
}
