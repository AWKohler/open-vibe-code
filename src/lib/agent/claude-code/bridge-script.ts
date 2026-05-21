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

export const BRIDGE_SCRIPT_VERSION = "4";

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
        async () => {
          try {
            const result = await callHostTool("convex_deploy", {});
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
        },
        { annotations: { destructiveHint: true } },
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
          mcpServers: {
            botflow: { type: "sdk", name: "botflow", instance: mcpServer },
          },
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

  try {
    for await (const message of query({ prompt, options })) {
      if (message && message.session_id && message.session_id !== lastSessionId) {
        lastSessionId = message.session_id;
        emit({ type: "session_started", sessionId: message.session_id });
      }
      emit({ type: "sdk_message", message });
    }
    emit({ type: "end_turn" });
    process.exit(0);
  } catch (err) {
    emit({ type: "error", error: err && err.message ? err.message : String(err) });
    process.exit(1);
  }
}

main();
`;
