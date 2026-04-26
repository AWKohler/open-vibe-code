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
    // 404 = doesn't exist yet; 400 can also indicate not found in some SDK versions
    if (
      !(error instanceof APIError) ||
      (error.response.status !== 404 && error.response.status !== 400)
    ) {
      throw error;
    }
  }

  // New sandbox — expose common dev ports for preview
  return Sandbox.create({
    name,
    runtime: DEFAULT_RUNTIME,
    timeout: DEFAULT_TIMEOUT_MS,
    snapshotExpiration: DEFAULT_SNAPSHOT_EXPIRATION_MS,
    ports: [5173, 3000, 4321, 8080],
    env: {
      BOTFLOW_PROJECT_ID: projectId,
      BOTFLOW_RUNTIME: "persistent",
    },
  });
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
