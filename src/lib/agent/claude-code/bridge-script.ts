/**
 * Source of the bridge script that runs inside the Vercel Sandbox.
 *
 * Exported as a string so we can write it to disk in the sandbox at setup
 * time — no template-repo changes, no CDN dependency. The script reads a JSON
 * config from stdin, drives @anthropic-ai/claude-agent-sdk, and streams events
 * back to stdout as NDJSON.
 *
 * Bump BRIDGE_SCRIPT_VERSION whenever the script source changes so the setup
 * helper knows to rewrite it on the next agent turn.
 */

export const BRIDGE_SCRIPT_VERSION = "12";

export const BRIDGE_SCRIPT_SOURCE = `#!/usr/bin/env node
/* eslint-disable */
/**
 * Botflow Claude Code bridge.
 *
 * Reads config from a JSON file (path in BOTFLOW_CONFIG_PATH), drives
 * @anthropic-ai/claude-agent-sdk's query(), streams events to stdout as NDJSON.
 *
 * Custom MCP tools (convex_deploy etc.) call back to our Next.js server via
 * HTTPS using a short-lived bearer token (BOTFLOW_TOOL_TOKEN). This keeps
 * sensitive credentials (e.g. platform-managed Convex deploy keys) on the
 * server — they never enter the sandbox env.
 *
 * Config shape:
 *   {
 *     prompt: string,
 *     sessionId?: string,
 *     model?: string,
 *     cwd?: string,
 *     appendSystemPrompt?: string,
 *     customTools?: string[],         // names of MCP tools to enable
 *   }
 *
 * Env vars (set by the host):
 *   BOTFLOW_CONFIG_PATH   — path to the config JSON file (required)
 *   BOTFLOW_API_BASE      — origin for our internal callback API (https://...)
 *   BOTFLOW_TOOL_TOKEN    — bearer token validated by the callback endpoint
 *
 * stdout NDJSON events:
 *   { type: "ready" }
 *   { type: "session_started", sessionId }
 *   { type: "sdk_message", message }
 *   { type: "usage", tokens, breakdown }     — real token counts from the SDK
 *   { type: "compact_boundary", trigger, preTokens }   — auto/manual compaction
 *   { type: "compacting" }                   — status message: SDK is compacting
 *   { type: "end_turn" }
 *   { type: "error", error }
 */

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { z } from "zod";

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

// ---------------------------------------------------------------------------
// Host callback for tools whose execution must stay on the server side.
//
// Bridge → POST {BOTFLOW_API_BASE}/api/internal/claude-code-tool
//   Authorization: Bearer {BOTFLOW_TOOL_TOKEN}
//   Body: { tool: string, input: object }
// Server runs the tool with its own credentials, returns
//   { ok: boolean, content: string | object }.
// ---------------------------------------------------------------------------
async function callHostTool(toolName, input) {
  const base = process.env.BOTFLOW_API_BASE;
  const token = process.env.BOTFLOW_TOOL_TOKEN;
  if (!base || !token) {
    throw new Error("Host callback not configured (BOTFLOW_API_BASE / BOTFLOW_TOOL_TOKEN missing)");
  }
  const response = await fetch(base + "/api/internal/claude-code-tool", {
    method: "POST",
    headers: {
      "authorization": "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tool: toolName, input: input ?? {} }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error("Host tool call failed (HTTP " + response.status + "): " + text);
  }
  return response.json();
}

// Helper: wrap a host-tool callback into the MCP CallToolResult shape.
// Every custom tool we register has the same shape, so factoring this out
// keeps the registrations short and uniform.
function makeHostToolHandler(toolName) {
  return async (args) => {
    try {
      const result = await callHostTool(toolName, args || {});
      const text = typeof result === "string"
        ? result
        : (result && result.content)
          ? (typeof result.content === "string" ? result.content : JSON.stringify(result.content))
          : JSON.stringify(result);
      const isError = result && result.ok === false;
      return {
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err && err.message ? err.message : String(err) }],
        isError: true,
      };
    }
  };
}

function buildCustomTools(customTools) {
  if (!Array.isArray(customTools) || customTools.length === 0) return [];
  const tools = [];

  if (customTools.includes("convex_deploy")) {
    tools.push(
      tool(
        "convex_deploy",
        "Deploy the project's /convex folder to its Convex deployment. " +
        "Call this AFTER editing files under /convex/ — changes are not live until deployed. " +
        "Takes no arguments; the project's deploy key is resolved server-side.",
        {},
        makeHostToolHandler("convex_deploy"),
        { annotations: { destructiveHint: true } },
      ),
    );
  }

  if (customTools.includes("initialize_stripe_payments")) {
    tools.push(
      tool(
        "initialize_stripe_payments",
        "Set up Stripe payments for this project. Call when the user asks to add checkout, subscriptions, billing, a paywall, or any payment flow. " +
        "Silently provisions a Stripe Express test account (no popup, no KYC) and reveals the Stripe tab in the workspace. " +
        "Requires Pro/Max — returns status='tier-blocked' for Free users; relay that message. " +
        "Requires a backend — returns status='backend-blocked' on No-Backend projects. " +
        "Idempotent: if already set up, returns status='already-enabled' immediately.",
        {},
        makeHostToolHandler("initialize_stripe_payments"),
      ),
    );
  }

  // ── Workspace control: dev server lifecycle + browser/dev logs ────────
  if (customTools.includes("startDevServer")) {
    tools.push(
      tool(
        "startDevServer",
        "Start the project's Vite dev server inside the sandbox. Idempotent — restarts cleanly if already running. Returns the public preview URL once reachable.",
        {},
        makeHostToolHandler("startDevServer"),
      ),
    );
  }

  if (customTools.includes("stopDevServer")) {
    tools.push(
      tool(
        "stopDevServer",
        "Stop the running dev server (kills the vite process). Idempotent.",
        {},
        makeHostToolHandler("stopDevServer"),
      ),
    );
  }

  if (customTools.includes("isDevServerRunning")) {
    tools.push(
      tool(
        "isDevServerRunning",
        "Check whether the dev server is currently running. Cheap (~50ms). Use before reading logs or refreshing the preview if you're not sure.",
        {},
        makeHostToolHandler("isDevServerRunning"),
      ),
    );
  }

  if (customTools.includes("getDevServerLog")) {
    tools.push(
      tool(
        "getDevServerLog",
        "Tail the dev server stdout/stderr (vite output: HMR events, build errors, warnings).",
        { linesBack: z.number().int().positive().optional() },
        makeHostToolHandler("getDevServerLog"),
      ),
    );
  }

  if (customTools.includes("getBrowserLog")) {
    tools.push(
      tool(
        "getBrowserLog",
        "Read the BROWSER console log from the running preview iframe — console.log/warn/error, runtime JS errors, React errors, Vite HMR events. Indispensable for diagnosing why a feature isn't working in the user's preview.",
        { linesBack: z.number().int().positive().optional() },
        makeHostToolHandler("getBrowserLog"),
      ),
    );
  }

  if (customTools.includes("refreshPreview")) {
    tools.push(
      tool(
        "refreshPreview",
        "Force the preview iframe in the user's workspace to hard-reload. Useful after changes that Vite HMR cannot pick up.",
        {},
        makeHostToolHandler("refreshPreview"),
      ),
    );
  }

  if (customTools.includes("ask_question")) {
    tools.push(
      tool(
        "ask_question",
        "Ask the user a multiple-choice question inline in the chat. Use when you genuinely need a decision and continuing without it would be guessing. Each question needs: id (slug), question (prompt), options (each with id, label, optional description). Optional: header, multiSelect (default false), allowCustom + customPlaceholder for free-form input. Blocks up to 5 minutes; returns { answered: false } on dismiss/timeout — proceed without that input.",
        {
          questions: z.array(z.object({
            id: z.string(),
            header: z.string().optional(),
            question: z.string(),
            options: z.array(z.object({
              id: z.string(),
              label: z.string(),
              description: z.string().optional(),
            })),
            multiSelect: z.boolean().optional(),
            allowCustom: z.boolean().optional(),
            customPlaceholder: z.string().optional(),
          })),
        },
        makeHostToolHandler("ask_question"),
      ),
    );
  }

  // ── Git tools (Phase D — only registered when project has a GitHub repo) ──
  // The host route gates these on project.githubRepoOwner; we still need to
  // advertise them to Claude Code when the route includes them in customTools.
  if (customTools.includes("git_status")) {
    tools.push(
      tool(
        "git_status",
        "Show the working-tree status: current branch, ahead/behind counts, and lists of added/modified/deleted/untracked/conflicted files.",
        {},
        makeHostToolHandler("git_status"),
      ),
    );
  }
  if (customTools.includes("git_diff")) {
    tools.push(
      tool(
        "git_diff",
        "Show the unified diff of working-tree changes. Optionally limit to a single path or show only staged changes.",
        {
          path: z.string().optional(),
          staged: z.boolean().optional(),
        },
        makeHostToolHandler("git_diff"),
      ),
    );
  }
  if (customTools.includes("git_commit")) {
    tools.push(
      tool(
        "git_commit",
        "Stage all working-tree changes and create a local commit. Does NOT push to GitHub — call git_push for that. Skipped silently if there's nothing to commit.",
        { message: z.string() },
        makeHostToolHandler("git_commit"),
      ),
    );
  }
  if (customTools.includes("git_push")) {
    tools.push(
      tool(
        "git_push",
        "Push the current branch to GitHub. Returns code=\\\"non-fast-forward\\\" when the remote has diverged — call git_pull first in that case. Use force=true only after the user explicitly approves overwriting remote.",
        { force: z.boolean().optional() },
        makeHostToolHandler("git_push"),
      ),
    );
  }
  if (customTools.includes("git_pull")) {
    tools.push(
      tool(
        "git_pull",
        "Fetch and merge the current branch from GitHub. Returns { clean: true } on fast-forward or { clean: false, conflicts: [paths] } when conflicts need resolving — use git_resolve_conflict for each.",
        {},
        makeHostToolHandler("git_pull"),
      ),
    );
  }
  if (customTools.includes("git_resolve_conflict")) {
    tools.push(
      tool(
        "git_resolve_conflict",
        "Resolve a merge conflict for a single file. Pass side='ours' or side='theirs' to use one wholesale, or pass content to write a custom merge. Afterwards call git_commit (with a merge message) to finalize once all conflicts are resolved.",
        {
          path: z.string(),
          side: z.enum(["ours", "theirs"]).optional(),
          content: z.string().optional(),
        },
        makeHostToolHandler("git_resolve_conflict"),
      ),
    );
  }
  if (customTools.includes("open_pull_request")) {
    tools.push(
      tool(
        "open_pull_request",
        "Open a pull request from the current branch to the linked default branch (or a custom base). Push your changes first. Returns alreadyExists=true if a matching PR is already open.",
        {
          title: z.string(),
          body: z.string().optional(),
          baseBranch: z.string().optional(),
          headBranch: z.string().optional(),
          draft: z.boolean().optional(),
        },
        makeHostToolHandler("open_pull_request"),
      ),
    );
  }

  if (customTools.includes("set_git_autonomy")) {
    tools.push(
      tool(
        "set_git_autonomy",
        "Record the user's chosen git-autonomy mode for this project. Call this exactly once after asking the autonomy question, with the value the user picked.",
        {
          mode: z.enum(["autonomous", "manual", "ask-each-time"]),
        },
        makeHostToolHandler("set_git_autonomy"),
      ),
    );
  }

  return tools;
}

async function main() {
  const configPath = process.env.BOTFLOW_CONFIG_PATH;
  if (!configPath) {
    emit({ type: "error", error: "BOTFLOW_CONFIG_PATH env var is required" });
    process.exit(1);
  }

  let config;
  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (err) {
    emit({ type: "error", error: "Failed to read config file: " + (err && err.message ? err.message : String(err)) });
    process.exit(1);
  }

  emit({ type: "ready" });

  const { prompt, sessionId, model, cwd, appendSystemPrompt, customTools } = config;

  const tools = buildCustomTools(customTools);
  const mcpServer = tools.length > 0 ? createSdkMcpServer({ name: "botflow", tools }) : null;

  const options = {
    ...(sessionId ? { resume: sessionId } : {}),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(appendSystemPrompt
      ? {
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: appendSystemPrompt,
          },
        }
      : {}),
    ...(mcpServer
      ? {
          // v0.3+ shape: the server instance is the value directly. The old
          // { type: "sdk", name, instance } wrapper was for pre-release
          // versions; passing it now causes connectSdkMcpServer to throw
          // "X.connect is not a function" because the SDK calls .connect()
          // on the wrapper object instead of the server.
          mcpServers: {
            botflow: mcpServer,
          },
          // Auto-approve our own MCP tools. permissionMode: bypassPermissions
          // also covers them, but listing explicitly here is more surgical and
          // matches the SDK's recommended pattern.
          allowedTools: [
            "mcp__botflow__*",
          ],
        }
      : {}),
    // Auto-accept all tool calls. We're running in an isolated per-project
    // sandbox where the user explicitly opted into Claude Code by selecting
    // a Claude model — there's no human to approve individual writes, and
    // the action stream surfaced in the Botflow UI is the user-visible audit
    // trail. Equivalent to claude --dangerously-skip-permissions.
    permissionMode: "bypassPermissions",
    env: { ...process.env },
    includePartialMessages: false,
  };

  let lastSessionId = null;

  // ---------------------------------------------------------------------------
  // Token usage + compaction tracking.
  //
  // SDKAssistantMessage.message.usage and SDKResultMessage.usage both carry
  // Anthropic-shape totals: input_tokens, output_tokens, cache_creation_input_tokens,
  // cache_read_input_tokens. The "context size" sent on a turn is
  // input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
  //
  // SDKCompactBoundaryMessage marks where Claude auto-compacted (or where the
  // user ran /compact). After the boundary the next assistant message's usage
  // will reflect a much smaller context — the bar should drop accordingly.
  // ---------------------------------------------------------------------------
  function extractUsage(u) {
    if (!u || typeof u !== "object") return null;
    const input = Number(u.input_tokens || 0);
    const output = Number(u.output_tokens || 0);
    const cacheCreate = Number(u.cache_creation_input_tokens || 0);
    const cacheRead = Number(u.cache_read_input_tokens || 0);
    const contextTokens = input + cacheCreate + cacheRead;
    return {
      tokens: contextTokens,
      breakdown: {
        input,
        output,
        cacheCreate,
        cacheRead,
      },
    };
  }

  try {
    for await (const message of query({ prompt, options })) {
      if (message && message.session_id && message.session_id !== lastSessionId) {
        lastSessionId = message.session_id;
        emit({ type: "session_started", sessionId: message.session_id });
      }
      emit({ type: "sdk_message", message });

      // Pull real token usage out of assistant/result messages so the UI can
      // drive its context-usage bar from authoritative numbers.
      if (message && message.type === "assistant" && message.message && message.message.usage) {
        const u = extractUsage(message.message.usage);
        if (u) emit({ type: "usage", source: "assistant", ...u });
      } else if (message && message.type === "result" && message.usage) {
        const u = extractUsage(message.usage);
        if (u) emit({ type: "usage", source: "result", ...u });
      }

      // Surface compaction so the UI can render a "context compacted" divider
      // and reset its bar basis. The next assistant usage will already reflect
      // the post-compaction context.
      if (message && message.type === "system" && message.subtype === "compact_boundary") {
        const meta = message.compact_metadata || {};
        emit({
          type: "compact_boundary",
          trigger: meta.trigger || "auto",
          preTokens: Number(meta.pre_tokens || 0),
        });
      } else if (message && message.type === "system" && message.subtype === "status" && message.status === "compacting") {
        emit({ type: "compacting" });
      }
    }
    emit({ type: "end_turn" });
    process.exit(0);
  } catch (err) {
    // Include the constructor name and a trimmed stack so a minified or
    // cryptic message (e.g. "Q.connect is not a function") still tells us
    // which library/file threw. Falls back to plain message if the error
    // lacks structure. NB: this code runs inside the SANDBOX as plain JS,
    // not in the TS template — every \${...} here is escaped because the
    // bridge file is itself a TS template literal.
    const name = (err && err.constructor && err.constructor.name) || "Error";
    const message = (err && err.message) || String(err);
    const stack = (err && err.stack) ? String(err.stack).split("\\n").slice(0, 6).join("\\n") : "";
    const summary = stack ? \`\${name}: \${message}\\n\${stack}\` : \`\${name}: \${message}\`;
    emit({ type: "error", error: summary });
    process.exit(1);
  }
}

main();
`;
