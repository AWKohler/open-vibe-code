import { APIError, Sandbox } from "@vercel/sandbox";

const DEFAULT_RUNTIME = "node22";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_ROOT = "/vercel/sandbox";

// Common dev-server ports we want to expose. Vercel sandboxes can expose up to 4.
// NOTE: port 8080 is reserved by the Vercel Sandbox system and will be
// rejected with `reserved_port`. Don't add it back without testing.
//  3000 — Next.js / CRA / generic Node
//  5173 — Vite dev server
//  4173 — Vite preview
//  8000 — alternate (Django/Express/Python)
const SANDBOX_PORTS: number[] = [3000, 5173, 4173, 8000];

const TEMPLATE_REPOS = {
  swift: "https://github.com/AWKohler/swift-template.git",
  viteConvex: "https://github.com/AWKohler/vite_convex_template.git",
  vite: "https://github.com/AWKohler/vite_template.git",
} as const;

export type SandboxTemplate = keyof typeof TEMPLATE_REPOS;

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

export function getSandboxName(projectId: string): string {
  return `botflow-project-${projectId}`;
}

export async function getOrCreatePersistentSandbox(projectId: string) {
  assertSandboxAuth();

  const name = getSandboxName(projectId);

  try {
    return await Sandbox.get({ name });
  } catch (error) {
    if (error instanceof APIError) {
      try {
        const body = await error.response.text();
        console.error(`Sandbox.get failed (${error.response.status}): ${body}`);
      } catch { /* ignore */ }
      if (error.response.status !== 404 && error.response.status !== 400) {
        throw error;
      }
    } else {
      throw error;
    }
  }

  // First-time creation: declare the ports we'll forward so `sandbox.domain(port)`
  // works for the live preview.
  try {
    return await Sandbox.create({
      name,
      runtime: DEFAULT_RUNTIME,
      timeout: DEFAULT_TIMEOUT_MS,
      ports: SANDBOX_PORTS,
    });
  } catch (error) {
    // The SDK already consumed the response body and stored it on
    // `error.text` / `error.json`. `error.response.text()` returns empty
    // because the body is already read.
    if (error instanceof APIError) {
      const errAny = error as unknown as { text?: string; json?: unknown };
      const bodyText =
        errAny.text || (errAny.json ? JSON.stringify(errAny.json) : "");
      console.error(
        `Sandbox.create failed (${error.response.status}) for project ${projectId}:\n` +
          `  body: ${bodyText || "<empty>"}\n` +
          `  payload: ${JSON.stringify({
            name,
            runtime: DEFAULT_RUNTIME,
            timeout: DEFAULT_TIMEOUT_MS,
            ports: SANDBOX_PORTS,
          })}`,
      );
      throw new Error(
        `Failed to create sandbox (${error.response.status}): ${bodyText || error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Seed a fresh sandbox with the appropriate template if /vercel/sandbox is empty.
 * Returns true if seeded, false if files already existed.
 *
 * Template selection:
 *   - swift     → swift-template (Swift / iOS app scaffold)
 *   - viteConvex → vite_convex_template (Vite + React + Convex web app)
 *   - vite      → vite_template (Vite + React web app, no backend)
 */
export async function seedSandboxIfEmpty(
  projectId: string,
  template: SandboxTemplate = "swift",
): Promise<boolean> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);

  const check = await sandbox.runCommand("sh", [
    "-c",
    `ls -A ${SANDBOX_ROOT} 2>/dev/null | grep -v '^node_modules$' | grep -v '^\\.git$' | head -1 || true`,
  ]);
  const out = (await check.stdout()).trim();
  if (out) return false;

  const repoUrl = TEMPLATE_REPOS[template];
  const tmpDir = `/tmp/${template}-template`;

  const seed = await sandbox.runCommand("sh", [
    "-c",
    [
      "set -e",
      `rm -rf ${tmpDir}`,
      `git clone --depth=1 ${repoUrl} ${tmpDir}`,
      `cp -a ${tmpDir}/. ${SANDBOX_ROOT}/`,
      `rm -rf ${SANDBOX_ROOT}/.git`,
      `rm -rf ${tmpDir}`,
    ].join(" && "),
  ]);

  if (seed.exitCode !== 0) {
    const stderr = await seed.stderr();
    throw new Error(`Failed to seed ${template} template: ${stderr || `exit ${seed.exitCode}`}`);
  }

  return true;
}

/**
 * Write a `.env` file at the sandbox root from a record of key/value pairs.
 * Used at seed time so Vite picks up VITE_CONVEX_URL etc. on first dev server start.
 * Overwrites any existing .env.
 */
export async function writeSandboxEnvFile(
  projectId: string,
  envVars: Record<string, string>,
): Promise<void> {
  const lines = Object.entries(envVars)
    .filter(([k, v]) => k && typeof v === "string")
    .map(([k, v]) => `${k}=${v}`);
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  await sandbox.writeFiles([{
    path: `${SANDBOX_ROOT}/.env`,
    content: Buffer.from(lines.join("\n") + (lines.length ? "\n" : ""), "utf-8"),
  }]);
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

// ────────────────────────────────────────────────────────────────────────────
// Helpers used by the persistent agent (server-side tool execution)
// ────────────────────────────────────────────────────────────────────────────

function toAbsPath(projectRelative: string): string {
  // Accept "/foo/bar" or "foo/bar"; always returns an absolute /vercel/sandbox path
  const trimmed = projectRelative.startsWith("/")
    ? projectRelative.slice(1)
    : projectRelative;
  return trimmed ? `${SANDBOX_ROOT}/${trimmed}` : SANDBOX_ROOT;
}

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function sandboxRun(
  projectId: string,
  cmd: string,
  args: string[] = [],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const command = await sandbox.runCommand({
    cmd,
    args,
    cwd: opts.cwd ?? SANDBOX_ROOT,
    detached: true,
  });
  const result = await command.wait();
  return {
    exitCode: result.exitCode,
    stdout: await result.stdout(),
    stderr: await result.stderr(),
  };
}

export async function sandboxBash(
  projectId: string,
  script: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return sandboxRun(projectId, "bash", ["-lc", script], opts);
}

export async function sandboxReadFile(
  projectId: string,
  projectRelativePath: string,
): Promise<{ content: string; binary: boolean } | null> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const buf = await sandbox.readFileToBuffer({ path: toAbsPath(projectRelativePath) });
  if (!buf) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { content, binary: false };
  } catch {
    return { content: Buffer.from(buf).toString("base64"), binary: true };
  }
}

export async function sandboxWriteFile(
  projectId: string,
  projectRelativePath: string,
  content: string,
): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const abs = toAbsPath(projectRelativePath);
  const dir = abs.substring(0, abs.lastIndexOf("/"));
  if (dir && dir !== SANDBOX_ROOT) {
    // mkDir from the SDK throws APIError 400 if the dir already exists, so
    // shell out to `mkdir -p` instead — idempotent and recursive.
    await sandbox.runCommand("mkdir", ["-p", dir]);
  }
  await sandbox.writeFiles([{
    path: abs,
    content: Buffer.from(content, "utf-8"),
  }]);
}

export async function sandboxListFiles(
  projectId: string,
  projectRelativePath: string,
  recursive: boolean,
): Promise<Array<{ path: string; type: "file" | "folder" }>> {
  const abs = toAbsPath(projectRelativePath);
  const findArgs = recursive
    ? [abs, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-name", ".DS_Store", "-printf", "%y %p\n"]
    : [abs, "-mindepth", "1", "-maxdepth", "1", "-not", "-name", "node_modules", "-not", "-name", ".git", "-not", "-name", ".DS_Store", "-printf", "%y %p\n"];

  const { stdout } = await sandboxRun(projectId, "find", findArgs);

  const entries: Array<{ path: string; type: "file" | "folder" }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx < 0) continue;
    const kind = trimmed.slice(0, spaceIdx);
    const rawPath = trimmed.slice(spaceIdx + 1);
    const projPath = rawPath.replace(SANDBOX_ROOT, "") || "/";
    if (projPath === "/" || projPath === "") continue;
    entries.push({ path: projPath, type: kind === "d" ? "folder" : "file" });
  }
  return entries;
}

// Recursive grep using ripgrep when available, falling back to grep -r.
export async function sandboxGrep(
  projectId: string,
  pattern: string,
  opts: { path?: string; glob?: string; caseInsensitive?: boolean; maxResults?: number } = {},
): Promise<Array<{ file: string; line: number; text: string }>> {
  const searchPath = toAbsPath(opts.path ?? "/");
  const max = opts.maxResults ?? 200;
  const flags = ["--no-heading", "--line-number", "--color=never"];
  if (opts.caseInsensitive) flags.push("-i");
  if (opts.glob) flags.push("--glob", opts.glob);
  flags.push("--max-count", "20");
  flags.push("-e", pattern, searchPath);

  let stdout = "";
  const rg = await sandboxRun(projectId, "rg", flags);
  if (rg.exitCode === 0 || rg.exitCode === 1) {
    stdout = rg.stdout;
  } else {
    // ripgrep not available — fall back to grep -rn
    const grepFlags = ["-rn", "--exclude-dir=node_modules", "--exclude-dir=.git"];
    if (opts.caseInsensitive) grepFlags.push("-i");
    if (opts.glob) grepFlags.push(`--include=${opts.glob}`);
    grepFlags.push("-e", pattern, searchPath);
    const grep = await sandboxRun(projectId, "grep", grepFlags);
    stdout = grep.stdout;
  }

  const results: Array<{ file: string; line: number; text: string }> = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    // Format: <file>:<line>:<text>
    const first = raw.indexOf(":");
    if (first < 0) continue;
    const second = raw.indexOf(":", first + 1);
    if (second < 0) continue;
    const file = raw.slice(0, first).replace(SANDBOX_ROOT, "");
    const line = parseInt(raw.slice(first + 1, second), 10);
    const text = raw.slice(second + 1);
    if (Number.isNaN(line)) continue;
    results.push({ file, line, text });
    if (results.length >= max) break;
  }
  return results;
}

/**
 * Tar (gzipped) the project's source tree from the persistent sandbox and
 * return it as a Buffer. Used by the Swift preview pipeline to ship the project
 * to a Mac for xcodebuild.
 *
 * Excludes build artefacts, .git, user-specific Xcode metadata, and node_modules.
 * The tar is written to a temp path inside the sandbox first, then read back.
 */
export async function tarSandboxProject(projectId: string): Promise<Buffer> {
  // Pipe tar's gzipped output through base64 and read it on stdout. This
  // bypasses readFileToBuffer entirely (which has been flaky for tarballs
  // outside /vercel/sandbox and sometimes returns null even for valid paths).
  // GNU tar exits 1 ("some files differ") when a file is touched mid-archive;
  // base64 sees the bytes regardless, and `|| [ $? -eq 1 ]` after pipefail
  // accepts that warning.
  const excludes = [
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=.build",
    "--exclude=build",
    "--exclude=*.xcodeproj/xcuserdata",
    "--exclude=*.xcodeproj/project.xcworkspace/xcuserdata",
    "--exclude=DerivedData",
    "--exclude=.DS_Store",
  ];
  // -w 0 disables base64 line wrapping so the entire payload is one chunk.
  const cmd = [
    "set -o pipefail",
    `tar czf - ${excludes.join(" ")} -C ${SANDBOX_ROOT} . 2>/dev/null | base64 -w 0`,
    'rc=$?',
    // Accept tar's "file changed" warning (pipefail surfaces it as rc=1)
    '[ $rc -eq 0 ] || [ $rc -eq 1 ]',
  ].join(" ; ");
  const res = await sandboxBash(projectId, cmd, { timeoutMs: 120_000 });
  if (res.exitCode !== 0) {
    throw new Error(`tar failed (${res.exitCode}): ${res.stderr || res.stdout || "(no output)"}`);
  }
  const b64 = res.stdout.trim();
  if (!b64) {
    throw new Error("tar produced empty output");
  }
  return Buffer.from(b64, "base64");
}

// Glob using `find` with -name patterns. For simple glob syntax: *.swift, **/*.ts
export async function sandboxGlob(
  projectId: string,
  pattern: string,
  opts: { path?: string; maxResults?: number } = {},
): Promise<string[]> {
  const searchPath = toAbsPath(opts.path ?? "/");
  const max = opts.maxResults ?? 500;

  // Use bash globstar so ** works; print matches null-terminated to handle spaces.
  const script = [
    "set -e",
    "shopt -s globstar nullglob dotglob",
    `cd ${searchPath}`,
    `for f in ${pattern}; do`,
    `  case "$f" in`,
    `    */node_modules/*|node_modules/*|*/.git/*|.git/*) continue ;;`,
    `  esac`,
    `  printf '%s\\n' "$f"`,
    `done`,
  ].join("\n");

  const { stdout } = await sandboxRun(projectId, "bash", ["-c", script]);
  const lines = stdout.split("\n").filter(Boolean);
  return lines.slice(0, max).map(p => {
    const abs = p.startsWith("/") ? p : `${searchPath}/${p}`;
    return abs.replace(SANDBOX_ROOT, "") || "/";
  });
}
