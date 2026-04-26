import { APIError, Sandbox } from "@vercel/sandbox";

const DEFAULT_RUNTIME = "node22";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

type AccessTokenParams = {
  token: string;
  teamId: string;
  projectId: string;
};

/**
 * Returns explicit auth params when VERCEL_TOKEN/TEAM/PROJECT are set.
 * When undefined, the SDK falls back to VERCEL_OIDC_TOKEN (auto-injected on Vercel).
 */
function getAccessTokenParams(): AccessTokenParams | undefined {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  return undefined;
}

function assertSandboxAuth(): void {
  const hasOidcToken = Boolean(process.env.VERCEL_OIDC_TOKEN);
  const hasAccessTokenAuth =
    Boolean(process.env.VERCEL_TOKEN) &&
    Boolean(process.env.VERCEL_PROJECT_ID) &&
    Boolean(process.env.VERCEL_TEAM_ID);

  // In a deployed Vercel function the OIDC token is injected via request header —
  // we can't check for it here at startup, so only throw when we have no static creds.
  if (!hasOidcToken && !hasAccessTokenAuth) {
    console.warn(
      "No static Vercel credentials found. Will rely on runtime OIDC injection. " +
      "If this fails, set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.",
    );
  }
}

export function getPersistentSandboxName(projectId: string): string {
  // Keep names short: prefix (8 chars) + first 8 chars of project ID
  return `bfp-${projectId.replace(/-/g, "").slice(0, 20)}`;
}

const SANDBOX_CREATE_PARAMS = (projectId: string) => ({
  runtime: DEFAULT_RUNTIME,
  timeout: DEFAULT_TIMEOUT_MS,
  snapshotExpiration: DEFAULT_SNAPSHOT_EXPIRATION_MS,
  ports: [5173, 3000, 4321, 8080],
  env: {
    BOTFLOW_PROJECT_ID: projectId,
    BOTFLOW_RUNTIME: "persistent",
  },
  ...getAccessTokenParams(),
});

export async function getOrCreatePersistentSandbox(projectId: string) {
  assertSandboxAuth();

  const name = getPersistentSandboxName(projectId);
  const auth = getAccessTokenParams();

  try {
    return await Sandbox.get({ name, ...(auth ?? {}) });
  } catch (error) {
    if (error instanceof APIError) {
      try {
        const body = await error.response.text();
        console.error(`Sandbox.get failed (${error.response.status}): ${body}`);
      } catch { /* ignore */ }
      // 404 = not found, 400 = name-based lookup not supported on this instance
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
      ...SANDBOX_CREATE_PARAMS(projectId),
    });
  } catch (error) {
    if (error instanceof APIError) {
      try {
        const body = await error.response.text();
        const msg = `Sandbox.create failed (${error.response.status}): ${body}`;
        console.error(msg);
        throw new Error(msg);
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
  const auth = getAccessTokenParams();

  // Back up all user files from the existing sandbox
  const fileBackup: Array<{ path: string; content: Buffer }> = [];
  try {
    const existing = await Sandbox.get({ name, ...(auth ?? {}) });
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
    ...SANDBOX_CREATE_PARAMS(projectId),
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
  if (out.includes("EXISTS")) return false;

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
