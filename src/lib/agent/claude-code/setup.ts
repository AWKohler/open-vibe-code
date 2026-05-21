/**
 * Sandbox setup for the Claude Code agent path.
 *
 * Idempotent helpers that run on every agent turn (cheap when already done):
 *  - resolveSandboxPaths — runs `echo $HOME` once per process to learn the
 *    sandbox user's home dir. Cached per project so we only pay this on
 *    cold boots of the Next.js function.
 *  - ensureClaudeInstalled — installs the official `claude` CLI globally
 *    (sudo) + the Agent SDK in $HOME/.botflow/ (no sudo).
 *  - writeClaudeCredentials — drops the user's OAuth tokens / API key into
 *    $HOME/.claude/.credentials.json so the local claude binary authenticates
 *    against the user's plan.
 *  - writeBridgeScript — drops the small Node bridge at $HOME/.botflow/.
 *
 * Each helper is a fast no-op when its work is already done — we only pay
 * the cost on first boot or after a sandbox restart.
 */
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import {
  BRIDGE_SCRIPT_SOURCE,
  BRIDGE_SCRIPT_VERSION,
} from "./bridge-script";

export interface SandboxPaths {
  /** The sandbox user's home directory (e.g. /home/vercel or /root). */
  home: string;
  /** Our scratch dir for the bridge script + Agent SDK install. */
  bridgeDir: string;
  /** Absolute path to the bridge script. */
  bridgePath: string;
  /** Where claude reads ~/.claude. */
  claudeHome: string;
  /** Absolute path to the credentials file claude reads on startup. */
  credentialsPath: string;
  /** Marker file the install step touches when complete. */
  installMarker: string;
  /** Version marker file we write after dropping the bridge script. */
  bridgeVersionMarker: string;
}

// In-process cache: each Next.js function instance caches HOME per project.
// Vercel doesn't pin instances to projects, so a cold start re-discovers HOME
// (one extra runCommand). Redis is overkill for a sub-50ms shell call.
const pathsCache = new Map<string, SandboxPaths>();

async function discoverHome(projectId: string): Promise<string> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const cmd = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", "echo $HOME"],
  });
  const home = (await cmd.stdout()).trim();
  if (!home || !home.startsWith("/")) {
    throw new Error(
      `Failed to resolve sandbox $HOME (got: ${JSON.stringify(home)}). Sandbox may not be ready.`,
    );
  }
  return home;
}

export async function resolveSandboxPaths(projectId: string): Promise<SandboxPaths> {
  const cached = pathsCache.get(projectId);
  if (cached) return cached;

  const home = await discoverHome(projectId);
  const bridgeDir = `${home}/.botflow`;
  const claudeHome = `${home}/.claude`;
  const paths: SandboxPaths = {
    home,
    bridgeDir,
    bridgePath: `${bridgeDir}/claude-bridge.mjs`,
    claudeHome,
    credentialsPath: `${claudeHome}/.credentials.json`,
    installMarker: `${bridgeDir}/.claude-installed`,
    bridgeVersionMarker: `${bridgeDir}/.claude-bridge.version`,
  };
  pathsCache.set(projectId, paths);
  return paths;
}

/**
 * Install `claude` (global, via sudo) and `@anthropic-ai/claude-agent-sdk`
 * (local in ~/.botflow, no sudo) in the sandbox. Idempotent: checks marker
 * file + binary presence + SDK directory before doing real work.
 *
 * Returns { ok: true } when ready, { ok: false, error } when install failed.
 */
export async function ensureClaudeInstalled(projectId: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveSandboxPaths(projectId);

  // Fast path: marker exists AND binary still exists AND SDK still installed.
  const check = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      `test -f ${paths.installMarker} && command -v claude >/dev/null 2>&1 && test -d ${paths.bridgeDir}/node_modules/@anthropic-ai/claude-agent-sdk && echo OK || echo MISSING`,
    ],
  });
  if ((await check.stdout()).trim() === "OK") {
    return { ok: true };
  }

  // Step 1: prepare the bridge directory in $HOME (no sudo needed).
  // We write a minimal package.json by hand instead of `npm init -y` —
  // the directory is `.botflow`, which npm rejects as a package name
  // ("Invalid name: '.botflow'"). Hardcoded name sidesteps the issue.
  const prepResult = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      [
        "set -e",
        `mkdir -p ${paths.bridgeDir}`,
        `cd ${paths.bridgeDir}`,
        `[ -f package.json ] || printf '%s\\n' '{"name":"botflow-bridge","version":"1.0.0","private":true,"type":"module"}' > package.json`,
        `npm install --no-audit --no-fund --silent @anthropic-ai/claude-agent-sdk`,
      ].join(" && "),
    ],
  });
  if (prepResult.exitCode !== 0) {
    const stderr = (await prepResult.stderr()).slice(-2000);
    return {
      ok: false,
      error: `Failed to install Agent SDK in sandbox (exit ${prepResult.exitCode}). ${stderr}`,
    };
  }

  // Step 2: global install of the claude CLI (requires sudo for /usr/local).
  const globalResult = await sandbox.runCommand({
    cmd: "npm",
    args: [
      "install",
      "-g",
      "--no-audit",
      "--no-fund",
      "--silent",
      "@anthropic-ai/claude-code",
    ],
    sudo: true,
  });
  if (globalResult.exitCode !== 0) {
    const stderr = (await globalResult.stderr()).slice(-2000);
    return {
      ok: false,
      error: `Failed to install claude CLI in sandbox (exit ${globalResult.exitCode}). ${stderr}`,
    };
  }

  // Step 3: drop the marker so the fast path triggers next time.
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `touch ${paths.installMarker}`],
  });

  return { ok: true };
}

export interface ClaudeCredentialsInput {
  /** OAuth access token (preferred). */
  accessToken?: string | null;
  /** OAuth refresh token (paired with accessToken). */
  refreshToken?: string | null;
  /** Epoch ms when the access token expires. */
  expiresAt?: number | null;
  /** BYOK fallback (used only when there's no OAuth token). */
  apiKey?: string | null;
}

/**
 * Drop the user's Anthropic credentials into the sandbox at
 * ~/.claude/.credentials.json. The `claude` binary reads this file on each
 * invocation. Format mirrors what Claude Code writes during a real desktop
 * login.
 */
export async function writeClaudeCredentials(
  projectId: string,
  input: ClaudeCredentialsInput,
): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveSandboxPaths(projectId);

  let payload: Record<string, unknown>;
  if (input.accessToken) {
    payload = {
      claudeAiOauth: {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? undefined,
        expiresAt: input.expiresAt ?? undefined,
        scopes: ["user:inference"],
        subscriptionType: undefined,
      },
    };
  } else if (input.apiKey) {
    payload = { apiKey: input.apiKey };
  } else {
    throw new Error("writeClaudeCredentials: no accessToken or apiKey provided");
  }

  // mkdir the .claude dir (no sudo — it's under $HOME) then write the file.
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${paths.claudeHome} && chmod 700 ${paths.claudeHome}`],
  });
  await sandbox.writeFiles([
    {
      path: paths.credentialsPath,
      content: Buffer.from(JSON.stringify(payload), "utf-8"),
    },
  ]);
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `chmod 600 ${paths.credentialsPath}`],
  });
}

/**
 * Write the bridge script. Idempotent — compares the in-sandbox version
 * marker to BRIDGE_SCRIPT_VERSION and skips when they match.
 */
export async function writeBridgeScript(projectId: string): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveSandboxPaths(projectId);

  const check = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      `test -f ${paths.bridgePath} && cat ${paths.bridgeVersionMarker} 2>/dev/null || true`,
    ],
  });
  const existing = (await check.stdout()).trim();
  if (existing === BRIDGE_SCRIPT_VERSION) return;

  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${paths.bridgeDir}`],
  });
  await sandbox.writeFiles([
    {
      path: paths.bridgePath,
      content: Buffer.from(BRIDGE_SCRIPT_SOURCE, "utf-8"),
    },
    {
      path: paths.bridgeVersionMarker,
      content: Buffer.from(BRIDGE_SCRIPT_VERSION, "utf-8"),
    },
  ]);
}
