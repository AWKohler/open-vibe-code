import { streamText, tool, convertToModelMessages, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createFireworks } from "@ai-sdk/fireworks";
import { z } from "zod";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";

import { SYSTEM_PROMPT_WEB, SYSTEM_PROMPT_MOBILE } from "@/lib/agent/prompts";
import { MODEL_CONFIGS, resolveModelId, type ModelId } from "@/lib/agent/models";
import { agentLog, generateRequestId, setRequestId } from "@/lib/agent/logger";
import { classifyError, formatErrorResponse } from "@/lib/agent/errors";
import { withRetry } from "@/lib/agent/retry";
import {
  estimateTokens,
  estimateMessagesTokens,
  needsCompaction,
  compactMessages,
} from "@/lib/agent/compaction";
import { getUserCredentials, setUserCredentials } from "@/lib/user-credentials";
import { getUserTierAndLimits, MODEL_TIER_REQUIREMENT, tierMeetsRequirement } from "@/lib/tier";
import {
  getDailyAgentTurns,
  incrementDailyAgentTurns,
  getMonthlyTokenUsage,
  recordTokenUsage,
} from "@/lib/usage";
import { limitReachedResponse } from "@/lib/plan-response";

// Allow long-running streamed responses on Vercel
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ============================================================================
// Tool definitions (shared across all providers)
// ============================================================================

function getTools() {
  return {
    listFiles: tool({
      description:
        "List files and folders. Set recursive=true to walk subdirectories. " +
        "Use project-relative paths starting with / (e.g. '/' for root, '/src' for src folder).",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path starting with /, e.g. '/' or '/src'"),
        recursive: z.boolean().optional().default(false),
      }),
    }),
    writeFile: tool({
      description:
        "Write content to a file. This tool COMPLETELY REPLACES the file's contents with the new content you provide. " +
        "Creates the file if it doesn't exist, or COMPLETELY OVERWRITES it if it does (replacing all existing content). " +
        "Use this tool to: (1) create new files, (2) completely rewrite/replace a file's entire contents. " +
        "For small/partial edits to existing files, use applyDiff instead. " +
        "Use project-relative paths starting with / (e.g. '/src/App.tsx').",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Project-relative file path starting with /, e.g. '/src/components/Button.tsx'"),
        content: z
          .string()
          .describe("The content to write to the file"),
      }),
    }),
    readFile: tool({
      description: "Read a single file as UTF-8. Use project-relative paths starting with / (e.g. '/src/main.tsx').",
      inputSchema: z.object({
        path: z.string().describe("Project-relative file path starting with /, e.g. '/src/App.tsx'"),
      }),
    }),
    applyDiff: tool({
      description:
        "Apply SEARCH/REPLACE blocks to a file using fuzzy matching (85% similarity). " +
        "The system uses Levenshtein distance matching and handles whitespace/unicode normalization. " +
        "If a block fails, returns detailed error with best match found and similarity percentage. " +
        "Use project-relative paths starting with / (e.g. '/vite.config.ts').",
      inputSchema: z.object({
        path: z.string().describe("Project-relative file path starting with /, e.g. '/src/App.tsx'"),
        diff: z
          .string()
          .describe(
            "One or more SEARCH/REPLACE blocks. Format: <<<<<<< SEARCH\\n[content]\\n=======\\n[replacement]\\n>>>>>>> REPLACE",
          ),
      }),
    }),
    searchFiles: tool({
      description:
        "Recursive text search starting at path. query may be regex. " +
        "Use project-relative paths starting with / (e.g. '/src').",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path starting with /, e.g. '/' or '/src'"),
        query: z.string().describe("Search pattern (can be regex)"),
      }),
    }),
    executeCommand: tool({
      description: "Run a command in the WebContainer (e.g. pnpm, node).",
      inputSchema: z.object({
        command: z.string(),
        args: z.array(z.string()).default([]),
      }),
    }),
    getDevServerLog: tool({
      description:
        "Return the dev server log. Pass linesBack to control how many tail lines to return (from bottom).",
      inputSchema: z.object({
        linesBack: z
          .number()
          .int()
          .positive()
          .default(200)
          .describe("Number of lines from the end of the log"),
      }),
    }),
    getBrowserLog: tool({
      description:
        "Return the browser console log from the preview iframe. This includes console.log/warn/error calls, runtime errors, and HMR events. Pass linesBack to control how many tail lines to return (from bottom).",
      inputSchema: z.object({
        linesBack: z
          .number()
          .int()
          .positive()
          .default(200)
          .describe("Number of lines from the end of the log"),
      }),
    }),
    startDevServer: tool({
      description:
        "Start the dev server (idempotent). If already running, it will not start another instance and will inform you.",
      inputSchema: z.object({}),
    }),
    stopDevServer: tool({
      description:
        "Stop the dev server if running. If none, returns a message indicating so.",
      inputSchema: z.object({}),
    }),
    refreshPreview: tool({
      description:
        "Refresh the open preview window (same as clicking refresh). Fails with a message if dev server is not running or refresh not possible.",
      inputSchema: z.object({}),
    }),
    convexDeploy: tool({
      description:
        "Deploy Convex backend changes to production. This zips the convex folder and supporting files (package.json, lock files, tsconfig.json) and sends them to the Convex deployment service. " +
        "The deployment runs npm install and convex deploy, streaming the output. " +
        "This is a synchronous operation that waits for deployment completion (may take several minutes). " +
        "Only use this after making changes to Convex functions, schemas, or cron jobs in the /convex folder.",
      inputSchema: z.object({}),
    }),
    endTurn: tool({
      description:
        "Call this tool when you have completed the user's request. You MUST call this when you are done with your task.",
      inputSchema: z.object({
        summary: z
          .string()
          .describe("A brief summary of what you accomplished"),
      }),
    }),
  } as const;
}

// Rough estimate of tools token overhead (computed once)
const TOOLS_TOKEN_ESTIMATE = 800;

// ============================================================================
// Provider creation helpers
// ============================================================================

function createAnthropicOAuthProvider(oauthToken: string) {
  const TOOL_PREFIX = "mcp_";

  return createAnthropic({
    apiKey: "oauth-placeholder",
    fetch: async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const requestHeaders = new Headers();
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => requestHeaders.set(key, value));
        } else if (Array.isArray(init.headers)) {
          for (const [key, value] of init.headers) {
            if (value !== undefined) requestHeaders.set(key, String(value));
          }
        } else {
          for (const [key, value] of Object.entries(init.headers)) {
            if (value !== undefined) requestHeaders.set(key, String(value));
          }
        }
      }

      requestHeaders.set("authorization", `Bearer ${oauthToken}`);
      requestHeaders.delete("x-api-key");

      const existingBeta = requestHeaders.get("anthropic-beta") || "";
      const betaList = existingBeta.split(",").map(b => b.trim()).filter(Boolean);
      const requiredBetas = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];
      const mergedBetas = [...new Set([...requiredBetas, ...betaList])].join(",");
      requestHeaders.set("anthropic-beta", mergedBetas);
      requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");

      let body = init?.body;
      if (body && typeof body === "string") {
        try {
          const parsed = JSON.parse(body);
          if (parsed.tools && Array.isArray(parsed.tools)) {
            parsed.tools = parsed.tools.map((t: Record<string, unknown>) => ({
              ...t,
              name: t.name ? `${TOOL_PREFIX}${t.name}` : t.name,
            }));
          }
          if (parsed.messages && Array.isArray(parsed.messages)) {
            parsed.messages = parsed.messages.map((msg: Record<string, unknown>) => {
              if (msg.content && Array.isArray(msg.content)) {
                msg.content = msg.content.map((block: Record<string, unknown>) => {
                  if (block.type === "tool_use" && block.name) {
                    return { ...block, name: `${TOOL_PREFIX}${block.name}` };
                  }
                  return block;
                });
              }
              return msg;
            });
          }
          body = JSON.stringify(parsed);
        } catch {
          // ignore parse errors
        }
      }

      let finalInput: RequestInfo | URL = requestInput;
      try {
        const url = requestInput instanceof URL
          ? new URL(requestInput.toString())
          : new URL(typeof requestInput === "string" ? requestInput : (requestInput as Request).url);
        if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
          url.searchParams.set("beta", "true");
          finalInput = requestInput instanceof Request
            ? new Request(url.toString(), requestInput)
            : url;
        }
      } catch {
        // ignore URL parse errors
      }

      const response = await fetch(finalInput, {
        ...init,
        body,
        headers: requestHeaders,
      });

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            let text = decoder.decode(value, { stream: true });
            text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
            controller.enqueue(encoder.encode(text));
          },
        });

        return new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      return response;
    },
  });
}

async function refreshAnthropicOAuthToken(
  creds: { claudeOAuthRefreshToken?: string | null },
  userId: string
): Promise<string | null> {
  if (!creds.claudeOAuthRefreshToken) return null;

  try {
    const refreshRes = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        refresh_token: creds.claudeOAuthRefreshToken,
      }),
    });

    if (!refreshRes.ok) return null;

    const refreshed = await refreshRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const newExpiresAt = refreshed.expires_in
      ? Date.now() + refreshed.expires_in * 1000 - 5 * 60 * 1000
      : null;

    await setUserCredentials(userId, {
      claudeOAuthAccessToken: refreshed.access_token,
      claudeOAuthRefreshToken: refreshed.refresh_token ?? creds.claudeOAuthRefreshToken,
      claudeOAuthExpiresAt: newExpiresAt,
    });

    return refreshed.access_token;
  } catch {
    return null;
  }
}

async function refreshCodexOAuthToken(
  creds: { codexOAuthRefreshToken?: string | null },
  userId: string
): Promise<string | null> {
  if (!creds.codexOAuthRefreshToken) return null;

  try {
    const refreshRes = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.codexOAuthRefreshToken,
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      }).toString(),
    });

    if (!refreshRes.ok) return null;

    const refreshed = await refreshRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const newExpiresAt = refreshed.expires_in
      ? Date.now() + refreshed.expires_in * 1000 - 5 * 60 * 1000
      : null;

    await setUserCredentials(userId, {
      codexOAuthAccessToken: refreshed.access_token,
      codexOAuthRefreshToken: refreshed.refresh_token ?? creds.codexOAuthRefreshToken,
      codexOAuthExpiresAt: newExpiresAt,
    });

    return refreshed.access_token;
  } catch {
    return null;
  }
}

// ============================================================================
// Determine if this request is using a server-side key (paid tier) vs BYOK/OAuth
// ============================================================================

/** Server key models: models the app pays for on behalf of paid users */
const SERVER_KEY_MODELS = new Set<ModelId>([
  'fireworks-minimax-m2p5', // free tier
  'claude-haiku-4.5',        // pro
  'fireworks-glm-5',         // pro
  'claude-sonnet-4.6',       // max
  'claude-opus-4.6',         // max
]);

function isServerKeyModel(model: ModelId): boolean {
  return SERVER_KEY_MODELS.has(model);
}

// ============================================================================
// Main POST handler
// ============================================================================

export async function POST(req: Request) {
  const requestId = generateRequestId();
  setRequestId(requestId);
  const startTime = Date.now();

  try {
    const { userId } = await auth();
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const {
      messages,
      projectId,
      platform,
    }: { messages: unknown; projectId?: string; platform?: "web" | "mobile" } =
      await req.json();

    const db = getDb();

    // Determine selected model for project and ensure ownership
    let selectedModel: ModelId = "gpt-5.3-codex";
    if (projectId) {
      const [proj] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!proj || proj.userId !== userId) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      selectedModel = resolveModelId(proj.model);
    }

    // Load credentials from Clerk (Redis-cached)
    const creds = await getUserCredentials(userId);

    const modelConfig = MODEL_CONFIGS[selectedModel];
    const systemPrompt = platform === "mobile" ? SYSTEM_PROMPT_MOBILE : SYSTEM_PROMPT_WEB;
    const tools = getTools();

    // ── Tier enforcement for server-key models ──────────────────────────────
    if (isServerKeyModel(selectedModel)) {
      const limits = await getUserTierAndLimits(userId);
      const requiredTier = MODEL_TIER_REQUIREMENT[selectedModel] ?? 'free';

      // Check if user's tier supports this model on server keys
      if (!tierMeetsRequirement(limits.tier, requiredTier)) {
        return limitReachedResponse({
          limitType: 'agent_turns_daily', // reuse — signals upgrade needed
          current: 0,
          limit: 0,
          tier: limits.tier,
          model: selectedModel,
        });
      }

      // Check daily agent turn limit
      if (limits.maxAgentTurnsPerDay > 0) {
        const turnsUsed = await getDailyAgentTurns(userId);
        if (turnsUsed >= limits.maxAgentTurnsPerDay) {
          return limitReachedResponse({
            limitType: 'agent_turns_daily',
            current: turnsUsed,
            limit: limits.maxAgentTurnsPerDay,
            tier: limits.tier,
          });
        }
      }

      // Check monthly token budget
      const budget = limits.tokenBudgets[selectedModel];
      if (budget !== undefined && budget > 0) {
        const usage = await getMonthlyTokenUsage(userId, selectedModel);
        if (usage.total >= budget) {
          return limitReachedResponse({
            limitType: 'token_budget',
            current: usage.total,
            limit: budget,
            tier: limits.tier,
            model: selectedModel,
          });
        }
      }

      // Increment turn counter immediately (before stream so we don't miss counts on abort)
      if (limits.maxAgentTurnsPerDay > 0) {
        await incrementDailyAgentTurns(userId);
      }
    }

    // ── Convert UIMessages to ModelMessages ─────────────────────────────────
    let resolvedMessages = await convertToModelMessages(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages as any,
      { tools },
    );
    const systemTokens = estimateTokens(systemPrompt);
    const messagesTokens = estimateMessagesTokens(resolvedMessages);
    const totalEstimatedTokens = systemTokens + messagesTokens + TOOLS_TOKEN_ESTIMATE;

    if (needsCompaction(systemTokens, messagesTokens, TOOLS_TOKEN_ESTIMATE, selectedModel)) {
      agentLog.info("context_compaction_triggered", {
        totalTokens: totalEstimatedTokens,
        maxTokens: modelConfig.maxContextTokens,
        model: selectedModel,
      });
      const { compacted } = compactMessages(resolvedMessages);
      resolvedMessages = compacted;
    }

    // Strip file/image parts for models that don't support vision
    if (!modelConfig.supportsImages) {
      for (const msg of resolvedMessages) {
        if (Array.isArray(msg.content)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (msg as any).content = (msg.content as Array<{ type: string }>).filter(part => part.type !== 'file');
        }
      }
    }

    agentLog.apiCall({
      model: selectedModel,
      tokenCount: totalEstimatedTokens,
      messageCount: resolvedMessages.length,
    });

    // ── Common response headers ──────────────────────────────────────────────
    const responseHeaders = {
      "x-request-id": requestId,
      "x-model": selectedModel,
      "x-token-estimate": String(totalEstimatedTokens),
      "x-max-tokens": String(modelConfig.maxContextTokens),
    };

    // ── Build the model provider and stream ──────────────────────────────────
    const streamCall = async () => {

      // ── onFinish: record actual token usage (ai-sdk v6: inputTokens / outputTokens) ──
      const onFinish = async (event: { usage: { inputTokens?: number; outputTokens?: number } }) => {
        const tokensIn = event.usage.inputTokens ?? 0;
        const tokensOut = event.usage.outputTokens ?? 0;
        if (isServerKeyModel(selectedModel) && (tokensIn > 0 || tokensOut > 0)) {
          await recordTokenUsage(userId, selectedModel, tokensIn, tokensOut).catch(() => {
            // Non-fatal — don't fail the request over a usage write
          });
        }
        const durationMs = Date.now() - startTime;
        agentLog.apiComplete({ model: selectedModel, durationMs });
      };

      if (selectedModel === "gpt-5.3-codex") {
        // Path A: Codex OAuth (priority)
        if (creds.codexOAuthAccessToken) {
          let accessToken = creds.codexOAuthAccessToken;
          const expiresAt = creds.codexOAuthExpiresAt;
          const isExpired = expiresAt !== null && expiresAt !== undefined && Date.now() >= expiresAt;

          if (isExpired) {
            accessToken = await refreshCodexOAuthToken(creds, userId) ?? "";
          }

          if (accessToken) {
            const accountId = creds.codexOAuthAccountId;
            const openai = createOpenAI({
              apiKey: "codex-oauth-placeholder",
              fetch: async (requestInput: RequestInfo | URL, init?: RequestInit) => {
                const requestHeaders = new Headers();
                if (init?.headers) {
                  if (init.headers instanceof Headers) {
                    init.headers.forEach((value, key) => requestHeaders.set(key, value));
                  } else if (Array.isArray(init.headers)) {
                    for (const [key, value] of init.headers) {
                      if (value !== undefined) requestHeaders.set(key, String(value));
                    }
                  } else {
                    for (const [key, value] of Object.entries(init.headers)) {
                      if (value !== undefined) requestHeaders.set(key, String(value));
                    }
                  }
                }

                requestHeaders.set("authorization", `Bearer ${accessToken}`);
                if (accountId) {
                  requestHeaders.set("ChatGPT-Account-Id", accountId);
                }

                let finalInput: RequestInfo | URL = requestInput;
                try {
                  const url = requestInput instanceof URL
                    ? new URL(requestInput.toString())
                    : new URL(typeof requestInput === "string" ? requestInput : (requestInput as Request).url);
                  if (url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")) {
                    finalInput = "https://chatgpt.com/backend-api/codex/responses";
                  }
                } catch {
                  // ignore URL parse errors
                }

                return fetch(finalInput, {
                  ...init,
                  headers: requestHeaders,
                });
              },
            });

            const result = streamText({
              model: openai.responses(modelConfig.apiModelId),
              system: systemPrompt,
              messages: resolvedMessages,
              tools,
              onFinish,
            });
            return result.toUIMessageStreamResponse({ headers: responseHeaders });
          }
        }

        // Path B: OpenAI API key fallback
        const apiKey = creds.openaiApiKey;
        if (!apiKey) {
          return new Response(
            JSON.stringify({ error: "Missing OpenAI credentials. Connect ChatGPT Codex or add an OpenAI API key in Settings.", errorType: "auth" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const openai = createOpenAI({ apiKey });
        const result = streamText({
          model: openai(modelConfig.apiModelId),
          system: systemPrompt,
          messages: resolvedMessages,
          tools,
          onFinish,
        });
        return result.toUIMessageStreamResponse({ headers: responseHeaders });
      }

      if (selectedModel === "kimi-k2.5") {
        const apiKey = creds.moonshotApiKey;
        if (!apiKey) {
          return new Response(
            JSON.stringify({ error: "Missing Moonshot API key", errorType: "auth" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const moonshot = createOpenAI({
          apiKey,
          baseURL: "https://api.moonshot.ai/v1",
        });
        const result = streamText({
          model: moonshot("kimi-k2.5"),
          system: systemPrompt,
          messages: resolvedMessages,
          tools,
          onFinish,
        });
        return result.toUIMessageStreamResponse({ headers: responseHeaders });
      }

      if (selectedModel === "fireworks-minimax-m2p5" || selectedModel === "fireworks-glm-5") {
        // Check for server-side Fireworks key first (for server-key models)
        const serverFireworksKey = process.env.FIREWORKS_API_KEY;
        const apiKey = isServerKeyModel(selectedModel) && serverFireworksKey
          ? serverFireworksKey
          : creds.fireworksApiKey;

        if (!apiKey) {
          return new Response(
            JSON.stringify({ error: "Missing Fireworks API key", errorType: "auth" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const fireworks = createFireworks({ apiKey });
        const result = streamText({
          model: fireworks(modelConfig.apiModelId),
          system: systemPrompt,
          messages: resolvedMessages,
          tools,
          onFinish,
        });
        return result.toUIMessageStreamResponse({ headers: responseHeaders });
      }

      // ── Anthropic models ──────────────────────────────────────────────────
      // Priority: OAuth token > server-side API key (for server-key models) > BYOK API key
      let anthropicToken: string | null = null;

      if (creds.claudeOAuthAccessToken) {
        const expiresAt = creds.claudeOAuthExpiresAt;
        const isExpired = expiresAt !== null && expiresAt !== undefined && Date.now() >= expiresAt;

        if (!isExpired) {
          anthropicToken = creds.claudeOAuthAccessToken;
        } else {
          anthropicToken = await refreshAnthropicOAuthToken(creds, userId);
        }
      }

      if (!anthropicToken) {
        // Check server-side Anthropic key for paid tier models
        const serverAnthropicKey = process.env.ANTHROPIC_API_KEY;
        if (isServerKeyModel(selectedModel) && serverAnthropicKey) {
          const anthropic = createAnthropic({ apiKey: serverAnthropicKey });
          const result = streamText({
            model: anthropic(modelConfig.apiModelId),
            system: systemPrompt,
            messages: resolvedMessages,
            tools,
            onFinish,
          });
          return result.toUIMessageStreamResponse({ headers: responseHeaders });
        }

        // Fall back to BYOK key
        if (creds.anthropicApiKey) {
          const anthropic = createAnthropic({ apiKey: creds.anthropicApiKey });
          const result = streamText({
            model: anthropic(modelConfig.apiModelId),
            system: systemPrompt,
            messages: resolvedMessages,
            tools,
            onFinish,
          });
          return result.toUIMessageStreamResponse({ headers: responseHeaders });
        }

        return new Response(
          JSON.stringify({
            error: "Missing Anthropic credentials. Add an API key or connect via Claude Code OAuth in Settings.",
            errorType: "auth",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Use OAuth token with custom fetch
      const anthropic = createAnthropicOAuthProvider(anthropicToken);
      const result = streamText({
        model: anthropic(modelConfig.apiModelId),
        system: systemPrompt,
        messages: resolvedMessages,
        tools,
        onFinish,
      });
      return result.toUIMessageStreamResponse({ headers: responseHeaders });
    };

    // ── Execute with retry logic ─────────────────────────────────────────────
    const response = await withRetry(streamCall, {
      maxRetries: 2,
      signal: req.signal,
    });

    return response;
  } catch (err) {
    const durationMs = Date.now() - startTime;

    if (err instanceof DOMException && err.name === "AbortError") {
      agentLog.info("request_aborted", { durationMs });
      return new Response(null, { status: 499 });
    }

    const classified = classifyError(err);
    agentLog.error("agent_api_error", {
      errorType: classified.type,
      error: classified.message,
      durationMs,
    });

    if (classified.type === "context_overflow") {
      return new Response(
        JSON.stringify({
          ...formatErrorResponse(classified),
          error: "Context too large. Please try sending a shorter message or start a new conversation.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const statusMap: Record<string, number> = {
      rate_limit: 429,
      auth: 401,
      context_overflow: 400,
      network: 502,
      provider_error: 502,
      unknown: 500,
    };

    return new Response(
      JSON.stringify(formatErrorResponse(classified)),
      {
        status: statusMap[classified.type] || 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
