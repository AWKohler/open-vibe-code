/**
 * /api/agent/claude-code
 *
 * The Claude Code agent path. Drives an actual `claude` subprocess inside the
 * user's Vercel Sandbox via @anthropic-ai/claude-agent-sdk. The user's
 * Anthropic OAuth tokens (or BYOK API key) are written into the sandbox at
 * ~/.claude/.credentials.json — Anthropic only ever sees traffic from a real
 * Claude Code process, never from us directly.
 *
 * The browser-side AgentPanel posts here when shouldUseClaudeCode() returns
 * true. When activation conditions fail (no creds, wrong platform, flag off),
 * we return 412 Precondition Failed with a `fallback: true` body so the client
 * can transparently retry against /api/agent.
 */
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getUserCredentials } from "@/lib/user-credentials";
import { getFreshAnthropicAccessToken } from "@/lib/anthropic-oauth";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { resolveModelId, MODEL_CONFIGS, isAnthropicModel } from "@/lib/agent/models";
import { isSandboxPlatform } from "@/lib/project-platform";

import { isClaudeCodeFlagEnabled } from "@/lib/agent/claude-code/feature-flag";
import { resolveBackends } from "@/lib/agent/backend-resolution";
import {
  ensureClaudeInstalled,
  writeClaudeCredentials,
  writeBridgeScript,
  resolveSandboxPaths,
} from "@/lib/agent/claude-code/setup";
import { buildClaudeCodeAppendPrompt } from "@/lib/agent/claude-code/system-prompt";
import {
  getClaudeCodeSessionId,
  setClaudeCodeSessionId,
} from "@/lib/agent/claude-code/session-store";
import { createTranslator, type BridgeEvent } from "@/lib/agent/claude-code/translator";
import { mintToolToken, revokeToolToken } from "@/lib/agent/claude-code/tool-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RequestBody {
  messages: UIMessage[];
  projectId?: string;
  platform?: string;
}

function fallback(reason: string): Response {
  // 412 + a structured body. The client AgentPanel inspects status === 412
  // and retries against /api/agent.
  return new Response(JSON.stringify({ fallback: true, reason }), {
    status: 412,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Pull the user's most recent text from a UIMessage array. */
function extractUserPrompt(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts ?? [];
    const texts: string[] = [];
    for (const p of parts) {
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    }
    if (texts.length === 0) continue;
    return texts.join("\n");
  }
  return null;
}

export async function POST(req: Request) {
  if (!isClaudeCodeFlagEnabled()) {
    return fallback("flag_disabled");
  }

  const { userId } = await auth();
  if (!userId) return jsonError(401, "Unauthorized");

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const { messages, projectId, platform } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError(400, "messages array required");
  }
  if (!projectId) {
    return jsonError(400, "projectId required");
  }
  if (!platform || !isSandboxPlatform(platform)) {
    return fallback("non_sandbox_platform");
  }

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) {
    return jsonError(404, "Project not found");
  }

  const selectedModel = resolveModelId(project.model);
  if (!isAnthropicModel(selectedModel)) {
    return fallback("non_anthropic_model");
  }

  const creds = await getUserCredentials(userId);
  // Validate that Claude Code is actually allowed for this user + model +
  // platform combination. We re-check at request time even though the project's
  // persisted agent_backend should have been set to a valid value when the
  // user picked it — creds can change between turns (e.g. user disconnects
  // Claude OAuth from settings).
  const resolution = resolveBackends({
    model: selectedModel,
    platform,
    creds: {
      hasClaudeOAuth: Boolean(creds.claudeOAuthAccessToken),
      hasAnthropicKey: Boolean(creds.anthropicApiKey),
    },
  });
  if (!resolution.available.includes("claude-code")) {
    return fallback(resolution.reason);
  }
  // Also validate that the project's persisted backend is claude-code. If the
  // user somehow hits this route while project.agent_backend === 'botflow',
  // bounce them — the Botflow route should handle this turn.
  if (project.agentBackend !== "claude-code") {
    return fallback("project_backend_mismatch");
  }

  const prompt = extractUserPrompt(messages);
  if (!prompt) {
    return jsonError(400, "No user text in last message");
  }

  // Refresh the OAuth token if near expiry, else use the existing one. If both
  // OAuth refresh and OAuth presence fail, fall back to the BYOK API key.
  const oauthToken = await getFreshAnthropicAccessToken(
    {
      claudeOAuthAccessToken: creds.claudeOAuthAccessToken,
      claudeOAuthRefreshToken: creds.claudeOAuthRefreshToken,
      claudeOAuthExpiresAt: creds.claudeOAuthExpiresAt,
    },
    userId,
  );

  if (!oauthToken && !creds.anthropicApiKey) {
    return fallback("no_anthropic_credentials");
  }

  // ── Sandbox setup (idempotent, fast on warm boots) ───────────────────────
  const installResult = await ensureClaudeInstalled(projectId);
  if (!installResult.ok) {
    return jsonError(500, installResult.error);
  }

  await writeClaudeCredentials(projectId, {
    accessToken: oauthToken,
    refreshToken: creds.claudeOAuthRefreshToken,
    expiresAt: creds.claudeOAuthExpiresAt,
    apiKey: creds.anthropicApiKey,
  });

  await writeBridgeScript(projectId);

  // ── Build the bridge config and drop it as a file in the sandbox ─────────
  const sessionId = await getClaudeCodeSessionId(projectId);
  const hasBackend = project.backendType !== "none";

  const appendSystemPrompt = buildClaudeCodeAppendPrompt({
    platform: platform as "sandboxed-web" | "swift",
    hasBackend,
    hasConvexEnv: hasBackend && Boolean(project.userConvexUrl || project.convexDeployUrl),
  });

  // Tools whose execution stays on our server (the bridge calls back via
  // /api/internal/claude-code-tool). Workspace control tools (dev server
  // lifecycle + browser/dev logs) are always available on sandboxed-web —
  // they don't depend on backend type. `convex_deploy` is gated on hasBackend
  // because its deploy key must never enter the sandbox env.
  const customTools: string[] = [];
  if (platform === "sandboxed-web") {
    customTools.push(
      "startDevServer",
      "stopDevServer",
      "isDevServerRunning",
      "getDevServerLog",
      "getBrowserLog",
      "refreshPreview",
    );
    if (hasBackend) {
      customTools.push("convex_deploy");
    }
  }

  const bridgeConfig = {
    prompt,
    ...(sessionId ? { sessionId } : {}),
    model: MODEL_CONFIGS[selectedModel].apiModelId,
    cwd: "/vercel/sandbox",
    appendSystemPrompt,
    ...(customTools.length ? { customTools } : {}),
  };

  const turnId = Math.random().toString(36).slice(2, 10);
  const configPath = `/tmp/.botflow-claude-config-${turnId}.json`;

  const sandbox = await getOrCreatePersistentSandbox(projectId);
  await sandbox.writeFiles([
    {
      path: configPath,
      content: Buffer.from(JSON.stringify(bridgeConfig), "utf-8"),
    },
  ]);

  // Mint a per-turn bearer token so the bridge can call back to our internal
  // tool endpoint without holding a Clerk session.
  const toolToken = customTools.length
    ? await mintToolToken({ userId, projectId })
    : null;

  // ── Spawn the bridge ────────────────────────────────────────────────────
  const bridgeEnv: Record<string, string> = {
    BOTFLOW_CONFIG_PATH: configPath,
  };
  if (toolToken) {
    bridgeEnv.BOTFLOW_API_BASE = new URL(req.url).origin;
    bridgeEnv.BOTFLOW_TOOL_TOKEN = toolToken;
  }
  if (oauthToken) {
    // When OAuth is available, claude reads it from ~/.claude/.credentials.json
    // (already written above). We deliberately do NOT set ANTHROPIC_API_KEY in
    // that case — having it set takes precedence over the credentials file.
  } else if (creds.anthropicApiKey) {
    bridgeEnv.ANTHROPIC_API_KEY = creds.anthropicApiKey;
  }

  const paths = await resolveSandboxPaths(projectId);
  const cmd = await sandbox.runCommand({
    cmd: "node",
    args: [paths.bridgePath],
    cwd: "/vercel/sandbox",
    env: bridgeEnv,
    detached: true,
  });

  // ── Stream stdout NDJSON → AI SDK UIMessageStream ───────────────────────
  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      const translator = createTranslator(writer);
      let buffer = "";
      let lastSessionIdSeen: string | null = null;
      let endedNormally = false;

      try {
        for await (const log of cmd.logs()) {
          if (log.stream !== "stdout") continue;
          buffer += log.data;
          // Split on newline; keep the trailing partial line in buffer.
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            let event: BridgeEvent;
            try {
              event = JSON.parse(line) as BridgeEvent;
            } catch {
              // Treat unparseable lines as stderr-like noise; surface as an
              // error chunk and continue.
              writer.write({ type: "error", errorText: `Unparseable bridge output: ${line.slice(0, 200)}` } satisfies UIMessageChunk);
              continue;
            }
            if (event.type === "session_started") {
              lastSessionIdSeen = event.sessionId;
            }
            translator.push(event);
            if (event.type === "end_turn") {
              endedNormally = true;
              break;
            }
            if (event.type === "error") {
              break;
            }
          }
          if (endedNormally) break;
        }
      } catch (err) {
        translator.push({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        translator.end();
        if (lastSessionIdSeen) {
          // Persist the session id so the next turn resumes.
          try {
            await setClaudeCodeSessionId(projectId, lastSessionIdSeen);
          } catch {
            // Non-fatal.
          }
        }
        // Best-effort: revoke the tool-callback token + delete the config file.
        if (toolToken) {
          revokeToolToken(toolToken).catch(() => {});
        }
        sandbox
          .runCommand({ cmd: "sh", args: ["-c", `rm -f ${configPath}`] })
          .catch(() => {});
      }
    },
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return createUIMessageStreamResponse({ stream });
}
