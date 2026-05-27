/**
 * Translator: NDJSON events from the bridge script → AI SDK UIMessageChunk
 * stream, written to a `UIMessageStreamWriter`.
 *
 * The bridge emits SDK messages from `@anthropic-ai/claude-agent-sdk` wrapped
 * in `{ type: "sdk_message", message }`. We unwrap and translate so the
 * existing AgentPanel — which expects AI SDK protocol — renders identically
 * to the regular /api/agent flow.
 *
 * Tool names are normalized to lowercase native ("Read" → "read", "Bash" →
 * "bash", etc.) per the design decision; this keeps the UI labels visually
 * consistent with the rest of the app.
 */
import type { UIMessageChunk, UIMessageStreamWriter } from "ai";

/* ----------------------------- bridge events ----------------------------- */

export type BridgeEvent =
  | { type: "ready" }
  | { type: "session_started"; sessionId: string }
  | { type: "sdk_message"; message: SDKMessage }
  | { type: "tool_request"; reqId: number; tool: string; input: unknown }
  | {
      type: "usage";
      source: "assistant" | "result";
      tokens: number;
      breakdown: {
        input: number;
        output: number;
        cacheCreate: number;
        cacheRead: number;
      };
    }
  | { type: "compact_boundary"; trigger: "manual" | "auto"; preTokens: number }
  | { type: "compacting" }
  | { type: "end_turn" }
  | { type: "error"; error: string };

/** A best-effort shape for `SDKMessage` from @anthropic-ai/claude-agent-sdk.
 *  We don't depend on the SDK directly in our Next.js bundle, so we model
 *  only the fields we actually read. */
interface SDKMessage {
  type?: string; // "assistant" | "user" | "result" | "system" | ...
  subtype?: string;
  session_id?: string;
  message?: {
    role?: "assistant" | "user";
    content?: ContentBlock[];
    id?: string;
  };
  // Result message:
  result?: string;
  is_error?: boolean;
  usage?: unknown;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: "thinking"; thinking: string }
  | { type: string; [k: string]: unknown }; // unknown future block types

/* ----------------------------- name normalization ----------------------------- */

/**
 * Map Claude Code's PascalCase tool names to lowercase. Anything we don't
 * recognize passes through unchanged (already lowercase, MCP tools, etc.).
 */
export function normalizeToolName(name: string): string {
  switch (name) {
    case "Read":
    case "Edit":
    case "Bash":
    case "Write":
    case "Grep":
    case "Glob":
    case "Task":
    case "WebFetch":
    case "WebSearch":
    case "MultiEdit":
    case "NotebookEdit":
    case "TodoWrite":
    case "BashOutput":
    case "KillShell":
      return name.toLowerCase();
    default:
      return name;
  }
}

/* --------------------------- translator state --------------------------- */

interface State {
  writer: UIMessageStreamWriter;
  /** True after we've emitted the first `start` chunk. */
  started: boolean;
  /** True once a `finish` chunk has been emitted (via end_turn / error / end()).
   *  Used to suppress duplicate finishes — a second `finish` in the stream
   *  causes AI SDK's useChat to split the assistant turn into multiple
   *  bubbles, which is exactly the "three greetings to one hello" bug. */
  finished: boolean;
  /** Set of text content-block ids we've already opened. */
  openTextIds: Set<string>;
  /** Set of tool-call ids we've already opened. */
  openToolIds: Set<string>;
  /** Tool name (normalized) for each tool-call id, so we can emit it on close. */
  toolNamesById: Map<string, string>;
  /** Raw inputs for each tool-call id so we can include them on tool-input-available. */
  toolInputsById: Map<string, unknown>;
}

export function createTranslator(writer: UIMessageStreamWriter): {
  push: (event: BridgeEvent) => void;
  end: () => void;
} {
  const state: State = {
    writer,
    started: false,
    finished: false,
    openTextIds: new Set(),
    openToolIds: new Set(),
    toolNamesById: new Map(),
    toolInputsById: new Map(),
  };

  function emitFinish(reason: "stop" | "error") {
    if (state.finished) return;
    state.finished = true;
    emit({ type: "finish-step" });
    emit({ type: "finish", finishReason: reason });
  }

  function ensureStarted() {
    if (state.started) return;
    state.started = true;
    writer.write({ type: "start" });
    writer.write({ type: "start-step" });
  }

  function emit(chunk: UIMessageChunk) {
    writer.write(chunk);
  }

  function handleAssistant(message: SDKMessage["message"]) {
    const blocks = message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "text") {
        const textBlock = block as { type: "text"; text: string };
        const id = `t-${state.openTextIds.size}-${Date.now()}`;
        state.openTextIds.add(id);
        emit({ type: "text-start", id });
        if (textBlock.text) {
          emit({ type: "text-delta", id, delta: textBlock.text });
        }
        emit({ type: "text-end", id });
        state.openTextIds.delete(id);
      } else if (block.type === "tool_use") {
        const toolBlock = block as {
          type: "tool_use";
          id: string;
          name: string;
          input: unknown;
        };
        const toolCallId = toolBlock.id;
        const toolName = normalizeToolName(toolBlock.name);
        state.openToolIds.add(toolCallId);
        state.toolNamesById.set(toolCallId, toolName);
        state.toolInputsById.set(toolCallId, toolBlock.input);

        emit({ type: "tool-input-start", toolCallId, toolName });
        emit({
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: toolBlock.input ?? {},
        });
      } else if (block.type === "thinking") {
        // Thinking tokens — surface as reasoning so the UI can display them
        // if it wants. Our current AgentPanel doesn't render reasoning
        // separately, so this is a no-op for now but future-proof.
        const id = `r-${Date.now()}`;
        const thinkingBlock = block as { type: "thinking"; thinking: string };
        emit({ type: "reasoning-start", id });
        if (thinkingBlock.thinking) {
          emit({ type: "reasoning-delta", id, delta: thinkingBlock.thinking });
        }
        emit({ type: "reasoning-end", id });
      }
    }
  }

  function handleUserMessage(message: SDKMessage["message"]) {
    // The SDK echoes tool_result blocks as user messages. We translate each
    // into a tool-output-available chunk so the UI shows the result attached
    // to its originating tool call.
    const blocks = message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const trBlock = block as {
          type: "tool_result";
          tool_use_id: string;
          content: unknown;
          is_error?: boolean;
        };
        const toolCallId = trBlock.tool_use_id;
        if (trBlock.is_error) {
          const errorText = stringifyContent(trBlock.content);
          emit({ type: "tool-output-error", toolCallId, errorText });
        } else {
          emit({
            type: "tool-output-available",
            toolCallId,
            output: trBlock.content ?? "",
          });
        }
        state.openToolIds.delete(toolCallId);
      }
    }
  }

  function push(event: BridgeEvent) {
    ensureStarted();
    switch (event.type) {
      case "session_started":
        // Stored by the route; not surfaced to the UI.
        break;
      case "sdk_message": {
        const m = event.message;
        if (!m) return;
        const t = m.type;
        if (t === "assistant") {
          handleAssistant(m.message);
        } else if (t === "user") {
          handleUserMessage(m.message);
        } else if (t === "result") {
          // Final result — we'll emit finish on end_turn.
          if (m.is_error && m.result) {
            emit({ type: "error", errorText: m.result });
          }
        }
        // "system", "stream_event", etc. → ignored for now.
        break;
      }
      case "tool_request":
        // Host RPC — not surfaced to the UI directly. The route handles it
        // and the response flows back through SDK messages.
        break;
      case "usage":
        // Forward the SDK's real token usage as a custom data part. The
        // AgentPanel reads these to drive the context-usage bar; everything
        // else ignores them.
        emit({
          type: "data-claude-code-usage",
          data: {
            source: event.source,
            tokens: event.tokens,
            breakdown: event.breakdown,
          },
          transient: true,
        } as UIMessageChunk);
        break;
      case "compact_boundary":
        // Auto- or user-initiated compaction. The next assistant usage will
        // be much smaller; the UI marks the boundary and resets the bar.
        emit({
          type: "data-claude-code-compact-boundary",
          data: {
            trigger: event.trigger,
            preTokens: event.preTokens,
            at: Date.now(),
          },
          transient: true,
        } as UIMessageChunk);
        break;
      case "compacting":
        // Transient status — the UI can show a "compacting…" hint while it
        // happens. Optional; ignored if the UI doesn't render it.
        emit({
          type: "data-claude-code-status",
          data: { status: "compacting" },
          transient: true,
        } as UIMessageChunk);
        break;
      case "end_turn":
        // Synthesize an endTurn tool call so the existing UI's end-of-turn
        // detection (which looks for a tool named "endTurn") fires. We pass a
        // stable id so re-renders don't dup it.
        emit({
          type: "tool-input-available",
          toolCallId: "claude-code-end-turn",
          toolName: "endTurn",
          input: { summary: "Done." },
        });
        emit({
          type: "tool-output-available",
          toolCallId: "claude-code-end-turn",
          output: "Done.",
        });
        emitFinish("stop");
        break;
      case "error":
        emit({ type: "error", errorText: event.error });
        emitFinish("error");
        break;
      case "ready":
        break;
    }
  }

  function end() {
    // Close any still-open text/tool blocks so the client doesn't hang on
    // dangling streams.
    for (const id of state.openTextIds) {
      try { emit({ type: "text-end", id }); } catch { /* ignore */ }
    }
    state.openTextIds.clear();
    state.openToolIds.clear();
    if (state.started) {
      // Backstop finish — no-ops if end_turn / error already emitted one.
      // A duplicate `finish` chunk causes useChat to split the turn into
      // multiple bubbles, so we MUST guard against double-emitting it.
      try { emitFinish("stop"); } catch { /* ignore */ }
    }
  }

  return { push, end };
}

/** Best-effort string-form for tool result content (which can be string,
 *  array of blocks, or arbitrary JSON). */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) {
          return String((c as { text: unknown }).text);
        }
        return JSON.stringify(c);
      })
      .join("");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
