'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, isToolUIPart, getToolName, type UIMessage } from 'ai';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { ChevronDown, ChevronRight, ArrowUp, X as IconX, Cog, AlertCircle, RotateCcw, Loader2, ListPlus, Check, ImagePlus } from 'lucide-react';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { WebContainerAgent, type GrepResult } from '@/lib/agent/webcontainer-agent';
import { cn } from '@/lib/utils';
import { LiveActions } from '@/components/agent/LiveActions';
import { useToast } from '@/components/ui/toast';
import type { ToolCallData } from '@/lib/agent/ui-types';
import { diffLineStats } from '@/lib/agent/diff-stats';
import { MODEL_CONFIGS, modelSupportsImages, type ModelId } from '@/lib/agent/models';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { LimitModal, parseLimitPayload, type LimitReachedPayload } from '@/components/ui/LimitModal';
import { CreditGauge } from '@/components/ui/CreditGauge';
import type { AgentErrorType } from '@/lib/agent/errors';
import { processImageForUpload } from '@/lib/image-processing';
import { ImageLightbox } from '@/components/ui/ImageLightbox';

type Props = { className?: string; projectId: string; initialPrompt?: string; platform?: 'web' | 'mobile' | 'multiplatform' };

interface PendingImage {
  id: string;
  file: File;
  localUrl: string;
  uploading: boolean;
  uploaded: boolean;
  error?: string;
  dbId?: string;
  url?: string;
  key?: string;
}

// ============================================================================
// Structured error from the API
// ============================================================================
interface StructuredError {
  message: string;
  type: AgentErrorType;
  retryAfter?: number;
}

function parseError(raw: string): StructuredError {
  try {
    const parsed = JSON.parse(raw) as { error?: string; errorType?: AgentErrorType; retryAfter?: number; message?: string };
    return {
      message: parsed.error ?? parsed.message ?? raw,
      type: (parsed.errorType as AgentErrorType) ?? 'unknown',
      retryAfter: parsed.retryAfter,
    };
  } catch {
    return { message: raw, type: 'unknown' };
  }
}

// ============================================================================
// ToolCard subcomponent
// ============================================================================
function ToolStep({ toolName, state, content }: { toolName: string; state: string; content: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const isDone = state === 'output-available';
  const isRunning = state === 'input-available' || state === 'partial-call';

  return (
    <div>
      {/* Flex row — fixed height, circle is first item so line position is exact */}
      <div className="flex items-center gap-2.5 h-7">
        {/* Circle — 14px wide, opaque bg-surface hides the line behind it */}
        <div className="shrink-0 z-10 size-[14px] rounded-full border-[1.5px] border-border bg-surface flex items-center justify-center">
          {isDone && <Check size={8} className="text-muted" />}
          {isRunning && <Loader2 size={8} className="animate-spin text-muted" />}
        </div>
        {/* Clickable label */}
        <button
          type="button"
          className="flex items-center gap-1 p-0 text-sm text-muted hover:text-fg transition-colors"
          onClick={() => setOpen(v => !v)}
        >
          <span className="font-medium">{toolName}</span>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
      </div>
      {/* Expanded content */}
      {open && <div className="pl-[26px] pb-1.5">{content}</div>}
    </div>
  );
}

// ============================================================================
// Token display formatter
// ============================================================================
function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

// ============================================================================
// Main AgentPanel
// ============================================================================
export function AgentPanel({ className, projectId, initialPrompt, platform = 'web' }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedIdsRef = useRef<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [actions, setActions] = useState<ToolCallData[]>([]);
  const lastAssistantSavedRef = useRef<{ id: string; hash: string } | null>(null);
  const [model, setModel] = useState<ModelId>('gpt-5.3-codex');
  const [hasOpenAIKey, setHasOpenAIKey] = useState<boolean | null>(null);
  const [hasAnthropicKey, setHasAnthropicKey] = useState<boolean | null>(null);
  const [hasClaudeOAuth, setHasClaudeOAuth] = useState<boolean | null>(null);
  const [hasCodexOAuth, setHasCodexOAuth] = useState<boolean | null>(null);
  const [hasMoonshotKey, setHasMoonshotKey] = useState<boolean | null>(null);
  const [hasFireworksKey, setHasFireworksKey] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [agentError, setAgentError] = useState<StructuredError | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const [limitPayload, setLimitPayload] = useState<LimitReachedPayload | null>(null);
  const [userTier, setUserTier] = useState<'free' | 'pro' | 'max'>('free');
  const { toast } = useToast();

  // --- Input state (v6: managed externally) ---
  const [input, setInput] = useState('');

  // --- Image attachment state ---
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingUploadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Lightbox state ---
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // --- Message queue ---
  const [messageQueue, setMessageQueue] = useState<string[]>([]);

  // --- endTurn detection ---
  const [endTurnCalled, setEndTurnCalled] = useState(false);
  const [showCompletionWarning, setShowCompletionWarning] = useState(false);

  // --- Credit gauge state ---
  const [creditPct, setCreditPct] = useState(0);

  const fetchCredits = useCallback(() => {
    fetch('/api/usage/credits')
      .then(r => r.ok ? r.json() : null)
      .then((d: { pct?: number; tier?: string } | null) => {
        if (d?.pct !== undefined) setCreditPct(d.pct);
        if (d?.tier === 'pro' || d?.tier === 'max') setUserTier(d.tier as 'pro' | 'max');
      })
      .catch(() => {});
  }, []);

  // --- Fetch user tier + credits for model gating ---
  useEffect(() => {
    fetchCredits();
  }, [fetchCredits]);

  // Refresh credits after each completed agent turn
  useEffect(() => {
    const handler = () => fetchCredits();
    window.addEventListener('agent-turn-finished', handler);
    return () => window.removeEventListener('agent-turn-finished', handler);
  }, [fetchCredits]);

  // --- Provider access for ModelSelector ---
  const providerAccess = useMemo(() => ({
    openai: hasCodexOAuth || hasOpenAIKey || null,
    anthropic: hasClaudeOAuth || hasAnthropicKey || null,
    fireworks: hasFireworksKey === true ? true : null,
  }), [hasCodexOAuth, hasOpenAIKey, hasClaudeOAuth, hasAnthropicKey, hasFireworksKey]);

  // --- Token tracking ---
  const [tokenEstimate, setTokenEstimate] = useState(0);
  const maxTokens = MODEL_CONFIGS[model]?.maxContextTokens ?? 128_000;

  // --- First message tracking ---
  const [hasAgentResponded, setHasAgentResponded] = useState(false);

  // --- Manual busy state (doesn't flicker between tool rounds) ---
  const [isBusy, setIsBusy] = useState(false);
  const busyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- AbortController for tool calls ---
  const toolAbortRef = useRef<AbortController | null>(null);

  // --- Stable transport ref (v6) ---
  const transportRef = useRef(new DefaultChatTransport({
    api: '/api/agent',
    body: { projectId, platform },
  }));

  const { messages, sendMessage, setMessages, addToolOutput, stop, status } = useChat({
    transport: transportRef.current,
    onFinish({ message, isAbort }) {
      // Don't clear busy on finish — let debounce handle it
      // (onFinish fires between tool rounds in multi-step, causing premature busy=false)

      if (isAbort) return;

      // Persist final assistant message
      (async () => {
        try {
          await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, message }),
          });
          savedIdsRef.current.add(message.id);
        } catch (err) {
          console.error('Failed to persist assistant message:', err);
        }
      })();

      // Emit event to trigger snapshot capture
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agent-turn-finished', { detail: { projectId } }));
      }
    },
    onError(error) {
      // Clear busy state on error
      setIsBusy(false);
      if (busyDebounceRef.current) {
        clearTimeout(busyDebounceRef.current);
        busyDebounceRef.current = null;
      }

      const msg = error.message || 'An error occurred. Please try again.';

      // Check for structured limit_reached payload first
      try {
        const parsed = JSON.parse(msg);
        const limitP = parseLimitPayload(parsed);
        if (limitP) {
          setLimitPayload(limitP);
          return;
        }
      } catch { /* not JSON, fall through */ }

      const structured = parseError(msg);
      setAgentError(structured);

      // Start countdown for rate limit errors
      if (structured.retryAfter && structured.retryAfter > 0) {
        setRetryCountdown(structured.retryAfter);
      }
    },
    async onToolCall({ toolCall }) {
      try {
        // Check if abort was requested
        if (toolAbortRef.current?.signal.aborted) {
          addToolOutput({ tool: toolCall.toolName as 'endTurn', toolCallId: toolCall.toolCallId, output: 'Tool execution aborted by user.' });
          return;
        }

        const args = toolCall.input as Record<string, unknown>;

        // --- Handle endTurn tool ---
        if (toolCall.toolName === 'endTurn') {
          setEndTurnCalled(true);
          setShowCompletionWarning(false);
          const summary = String((args as { summary?: string }).summary ?? 'Task completed.');
          addToolOutput({ tool: 'endTurn', toolCallId: toolCall.toolCallId, output: summary });
          return;
        }

        // Record tool invocation
        setActions((prev) => [
          ...prev,
          {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            args,
            status: 'invoked',
            startedAt: Date.now(),
          },
        ]);

        switch (toolCall.toolName) {
          case 'listFiles': {
            const out = await WebContainerAgent.listFiles(
              String(args.path ?? '/'),
              Boolean(args.recursive)
            );
            addToolOutput({ tool: 'listFiles', toolCallId: toolCall.toolCallId, output: out });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: 'success',
              finishedAt: Date.now(),
              resultPreview: out.slice(0, 400),
            }) : a));
            break;
          }
          case 'writeFile': {
            const path = String(args.path ?? '');
            const content = String(args.content ?? '');
            const res = await WebContainerAgent.writeFile(path, content, projectId);
            addToolOutput({ tool: 'writeFile', toolCallId: toolCall.toolCallId, output: JSON.stringify(res) });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: res.ok ? 'success' : 'error',
              finishedAt: Date.now(),
              resultPreview: res.message,
            }) : a));
            break;
          }
          case 'readFile': {
            const out = await WebContainerAgent.readFile(String(args.path ?? ''));
            addToolOutput({ tool: 'readFile', toolCallId: toolCall.toolCallId, output: out });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: 'success',
              finishedAt: Date.now(),
              resultPreview: out.slice(0, 400),
            }) : a));
            break;
          }
          case 'applyDiff': {
            const path = String(args.path ?? '');
            const diff = String(args.diff ?? '');
            let before = '';
            try { before = await WebContainerAgent.readFile(path); } catch {}
            const res = await WebContainerAgent.applyDiff(path, diff, projectId);
            let after = before;
            try { after = await WebContainerAgent.readFile(path); } catch {}
            const stats = diffLineStats(before, after);

            if (!res.ok) {
              const failedCount = res.failed || 0;
              const appliedCount = res.applied || 0;
              if (failedCount > 0 && appliedCount === 0) {
                toast({
                  title: 'Diff application failed',
                  description: `Could not match content in ${path}. The agent will retry with updated content.`,
                });
              } else if (failedCount > 0) {
                toast({
                  title: 'Partial diff applied',
                  description: `Applied ${appliedCount}/${appliedCount + failedCount} changes to ${path}. Some blocks failed to match.`,
                });
              }
            }

            addToolOutput({ tool: 'applyDiff', toolCallId: toolCall.toolCallId, output: JSON.stringify(res) });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: res.ok ? 'success' : 'error',
              finishedAt: Date.now(),
              fileChange: { filePath: path, before, after, additions: stats.additions, deletions: stats.deletions },
              resultPreview: res.message,
            }) : a));
            break;
          }
          case 'searchFiles': {
            const results: GrepResult[] = [];
            for await (const r of WebContainerAgent.searchFiles(
              String(args.path ?? '/'),
              String(args.query ?? '')
            )) {
              if ('filePath' in r && 'lineNumber' in r && 'lineContent' in r) {
                results.push(r);
              }
            }
            addToolOutput({ tool: 'searchFiles', toolCallId: toolCall.toolCallId, output: JSON.stringify(results) });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: 'success',
              finishedAt: Date.now(),
              resultPreview: `${results.length} matches`,
            }) : a));
            break;
          }
          case 'executeCommand': {
            let combined = '';
            const cmd = String(args.command ?? '');
            const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
            for await (const chunk of WebContainerAgent.executeCommand(cmd, cmdArgs)) {
              combined += chunk;
            }
            addToolOutput({ tool: 'executeCommand', toolCallId: toolCall.toolCallId, output: combined });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: 'success',
              finishedAt: Date.now(),
              resultPreview: combined.slice(0, 400),
            }) : a));
            break;
          }
          case 'getDevServerLog': {
            const linesBack = Number((args as { linesBack?: number }).linesBack ?? 200);
            const out = await WebContainerAgent.getDevServerLog(linesBack);
            const result = out.ok ? (out.log ?? '') : out.message;
            addToolOutput({ tool: 'getDevServerLog', toolCallId: toolCall.toolCallId, output: result });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: out.ok ? 'success' : 'error',
              finishedAt: Date.now(),
              resultPreview: result.slice(0, 400),
            }) : a));
            break;
          }
          case 'getBrowserLog': {
            const linesBack = Number((args as { linesBack?: number }).linesBack ?? 200);
            const out = await WebContainerAgent.getBrowserLog(linesBack);
            const result = out.ok ? (out.log ?? '') : out.message;
            addToolOutput({ tool: 'getBrowserLog', toolCallId: toolCall.toolCallId, output: result });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: out.ok ? 'success' : 'error',
              finishedAt: Date.now(),
              resultPreview: result.slice(0, 400),
            }) : a));
            break;
          }
          case 'startDevServer': {
            const res = await WebContainerAgent.startDevServer();
            const msg = res.message;
            addToolOutput({ tool: 'startDevServer', toolCallId: toolCall.toolCallId, output: msg });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: res.ok ? 'success' : 'error',
              finishedAt: Date.now(),
              resultPreview: msg,
            }) : a));
            break;
          }
          case 'stopDevServer': {
            const res = await WebContainerAgent.stopDevServer();
            const msg = res.message;
            addToolOutput({ tool: 'stopDevServer', toolCallId: toolCall.toolCallId, output: msg });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: res.ok ? 'success' : 'error',
              finishedAt: Date.now(),
              resultPreview: msg,
            }) : a));
            break;
          }
          case 'refreshPreview': {
            const running = await WebContainerAgent.isDevServerRunning();
            if (!running) {
              const msg = 'Dev server is not running. Start it before refreshing the preview.';
              addToolOutput({ tool: 'refreshPreview', toolCallId: toolCall.toolCallId, output: msg });
              setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
                ...a,
                status: 'error',
                finishedAt: Date.now(),
                resultPreview: msg,
              }) : a));
              break;
            }
            try {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('preview-refresh'));
              }
              const msg = 'Preview refresh requested.';
              addToolOutput({ tool: 'refreshPreview', toolCallId: toolCall.toolCallId, output: msg });
              setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
                ...a,
                status: 'success',
                finishedAt: Date.now(),
                resultPreview: msg,
              }) : a));
            } catch (e) {
              const msg = `Failed to refresh preview: ${e instanceof Error ? e.message : String(e)}`;
              addToolOutput({ tool: 'refreshPreview', toolCallId: toolCall.toolCallId, output: msg });
              setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
                ...a,
                status: 'error',
                finishedAt: Date.now(),
                resultPreview: msg,
              }) : a));
            }
            break;
          }
          case 'convexDeploy': {
            const res = await WebContainerAgent.deployConvex(projectId);
            const msg = res.message;
            addToolOutput({ tool: 'convexDeploy', toolCallId: toolCall.toolCallId, output: msg });
            setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
              ...a,
              status: res.ok ? 'success' : 'error',
              finishedAt: Date.now(),
              resultPreview: msg,
            }) : a));
            break;
          }
        }
      } catch (err: unknown) {
        console.error('Tool error', err);
        const message = err instanceof Error ? err.message : String(err);
        addToolOutput({ tool: toolCall.toolName as 'endTurn', toolCallId: toolCall.toolCallId, output: `Tool execution failed: ${message}` });
        setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
          ...a,
          status: 'error',
          finishedAt: Date.now(),
          resultPreview: message,
        }) : a));
      }
    },
    // v6: auto-resubmit when tool calls are complete (replaces maxSteps)
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  // --- Refs for values needed in effects (avoid deps that change every render) ---
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const messageQueueRef = useRef(messageQueue);
  messageQueueRef.current = messageQueue;
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const endTurnCalledRef = useRef(endTurnCalled);
  endTurnCalledRef.current = endTurnCalled;

  // --- Debounced busy state: goes true immediately on activity, only goes false after a delay ---
  useEffect(() => {
    const active = status === 'streaming' || status === 'submitted';
    if (active) {
      if (busyDebounceRef.current) {
        clearTimeout(busyDebounceRef.current);
        busyDebounceRef.current = null;
      }
      setIsBusy(true);
      if (!toolAbortRef.current || toolAbortRef.current.signal.aborted) {
        toolAbortRef.current = new AbortController();
      }
    } else {
      // Delay clearing busy to absorb gaps between tool rounds (2s debounce)
      if (busyDebounceRef.current) clearTimeout(busyDebounceRef.current);
      busyDebounceRef.current = setTimeout(() => {
        setIsBusy(false);
        busyDebounceRef.current = null;
      }, 2000);
    }
  }, [status]);

  const isAgentWorking = isBusy;

  // Emit custom event when busy state changes (workspace listens for preview loading state)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('agent-busy-change', { detail: { isBusy } }));
    }
  }, [isBusy]);

  // --- "Agent may not have finished" warning ---
  // Only show when busy state truly settles to false (debounced) and endTurn wasn't called
  const prevBusyRef = useRef(false);
  useEffect(() => {
    // Detect transition from busy → not busy (the real end of agent work)
    if (prevBusyRef.current && !isBusy) {
      if (!endTurnCalledRef.current && messagesRef.current.some(m => m.role === 'assistant')) {
        setShowCompletionWarning(true);
      }
      // Process message queue
      if (messageQueueRef.current.length > 0) {
        const [next, ...rest] = messageQueueRef.current;
        setMessageQueue(rest);
        setTimeout(() => {
          sendMessageRef.current({ text: next });
        }, 300);
      }
    }
    prevBusyRef.current = isBusy;
  }, [isBusy]); // Only trigger on actual busy state transitions

  // Track first response — only check when message count changes
  useEffect(() => {
    if (!hasAgentResponded && messagesRef.current.some(m => m.role === 'assistant')) {
      setHasAgentResponded(true);
    }
  }, [messages.length, hasAgentResponded]);

  // Reset endTurn tracking when a new user message is sent
  const lastMsgIdRef = useRef<string | null>(null);
  useEffect(() => {
    const msgs = messagesRef.current;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg?.role === 'user' && lastMsg.id !== lastMsgIdRef.current) {
      lastMsgIdRef.current = lastMsg.id;
      setEndTurnCalled(false);
      setShowCompletionWarning(false);
    }
  }, [messages.length]);

  // Estimate total tokens in conversation (messages + system prompt + tools overhead)
  // Only recalculate when message count changes (not on every content update during streaming)
  useEffect(() => {
    const SYSTEM_PROMPT_TOKENS = 4500;
    const TOOLS_TOKENS = 800;
    let msgTokens = 0;
    for (const msg of messagesRef.current) {
      for (const part of msg.parts) {
        if (part.type === 'text') {
          msgTokens += Math.ceil(part.text.length / 4);
        } else if (isToolUIPart(part)) {
          const toolStr = JSON.stringify(part);
          msgTokens += Math.ceil(toolStr.length / 4);
        }
      }
      msgTokens += 4;
    }
    setTokenEstimate(SYSTEM_PROMPT_TOKENS + TOOLS_TOKENS + msgTokens);
  }, [messages.length]);

  // Rate limit countdown timer
  useEffect(() => {
    if (retryCountdown === null || retryCountdown <= 0) return;
    const timer = setInterval(() => {
      setRetryCountdown(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [retryCountdown]);

  // Remove only the "prompt" query param from the URL without reloading
  const removePromptFromUrl = useCallback(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('prompt')) {
        url.searchParams.delete('prompt');
        window.history.replaceState({}, document.title, url.toString());
      }
    } catch {}
  }, []);

  // Load initial chat history
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/chat?projectId=${encodeURIComponent(projectId)}`);
        if (!res.ok) throw new Error('Failed to load chat');
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data?.messages)) {
          setMessages(data.messages);
          const ids = new Set<string>();
          for (const m of data.messages) ids.add(m.id);
          savedIdsRef.current = ids;
          const lastAssistant = [...data.messages].reverse().find((m: { role: string }) => m.role === 'assistant');
          if (lastAssistant) {
            try {
              lastAssistantSavedRef.current = { id: lastAssistant.id, hash: JSON.stringify(lastAssistant.parts ?? lastAssistant.content).slice(-512) };
            } catch {
              lastAssistantSavedRef.current = { id: lastAssistant.id, hash: String(lastAssistant.parts ?? lastAssistant.content) };
            }
          }
          if (data.messages.some((m: { role: string }) => m.role === 'assistant')) {
            setHasAgentResponded(true);
          }
        }
      } catch (err) {
        console.warn('No existing chat or failed to load:', err);
      } finally {
        if (!cancelled) setInitialized(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [projectId, setMessages]);

  // Load project model and user settings (BYOK presence)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
        if (res.ok) {
          const proj = await res.json();
          if (
            proj?.model === 'gpt-5.3-codex' ||
            proj?.model === 'gpt-5.4' ||
            proj?.model === 'gpt-5.2' ||
            proj?.model === 'gpt-4.1' || // legacy migration
            proj?.model === 'claude-sonnet-4.6' ||
            proj?.model === 'claude-sonnet-4.5' ||
            proj?.model === 'claude-haiku-4.5' || // removed → sonnet
            proj?.model === 'claude-opus-4.7' ||
            proj?.model === 'claude-opus-4.6' || // legacy
            proj?.model === 'claude-opus-4.5' ||
            proj?.model === 'kimi-k2.5' || // removed → minimax
            proj?.model === 'kimi-k2-thinking-turbo' || // removed → minimax
            proj?.model === 'fireworks-minimax-m2p5' ||
            proj?.model === 'fireworks-glm-5p1' ||
            proj?.model === 'fireworks-glm-5' || // legacy
            proj?.model === 'fireworks-kimi-k2p6'
          ) {
            const m = proj.model === 'gpt-4.1' ? 'gpt-5.3-codex'
              : proj.model === 'gpt-5.2' ? 'gpt-5.3-codex'
              : proj.model === 'claude-sonnet-4.5' ? 'claude-sonnet-4.6'
              : proj.model === 'claude-haiku-4.5' ? 'claude-sonnet-4.6'
              : proj.model === 'claude-opus-4.5' ? 'claude-opus-4.7'
              : proj.model === 'claude-opus-4.6' ? 'claude-opus-4.7'
              : proj.model === 'kimi-k2-thinking-turbo' ? 'fireworks-minimax-m2p5'
              : proj.model === 'kimi-k2.5' ? 'fireworks-minimax-m2p5'
              : proj.model;
            setModel(m as ModelId);
          }
        }
      } catch {}
      try {
        const s = await fetch('/api/user-settings');
        if (s.ok) {
          const data = await s.json();
          setHasOpenAIKey(Boolean(data?.hasOpenAIKey));
          setHasAnthropicKey(Boolean(data?.hasAnthropicKey));
          setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
          setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
          setHasMoonshotKey(Boolean(data?.hasMoonshotKey));
          setHasFireworksKey(Boolean(data?.hasFireworksKey));
        }
      } catch {}
    })();
  }, [projectId]);

  // Refresh provider access when settings modal closes
  useEffect(() => {
    const handler = () => {
      fetch('/api/user-settings')
        .then(r => r.ok ? r.json() : null)
        .then((data: Record<string, unknown> | null) => {
          if (!data) return;
          setHasOpenAIKey(Boolean(data?.hasOpenAIKey));
          setHasAnthropicKey(Boolean(data?.hasAnthropicKey));
          setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
          setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
          setHasMoonshotKey(Boolean(data?.hasMoonshotKey));
          setHasFireworksKey(Boolean(data?.hasFireworksKey));
        })
        .catch(() => {});
    };
    window.addEventListener('settings-closed', handler);
    return () => window.removeEventListener('settings-closed', handler);
  }, []);

  // Persist new messages — only when message count changes (not during streaming content updates)
  useEffect(() => {
    if (!initialized) return;
    async function persistNewMessages() {
      for (const m of messagesRef.current) {
        if (m.role === 'assistant') continue; // Assistant messages are persisted in onFinish
        if (!savedIdsRef.current.has(m.id)) {
          try {
            await fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId, message: m }),
            });
            savedIdsRef.current.add(m.id);
          } catch (err) {
            console.error('Failed to persist message:', err);
          }
        }
      }
    }
    void persistNewMessages();
  }, [messages.length, projectId, initialized]);

  // Initial prompt submission — fire once when initialized with no existing messages
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (initialized && initialPrompt && !initialPromptSentRef.current && messagesRef.current.length === 0) {
      initialPromptSentRef.current = true;
      setTimeout(() => {
        // Pick up any images attached on the landing page
        let fileParts: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }> | undefined;
        try {
          const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('botflow_pending_images') : null;
          if (raw) {
            sessionStorage.removeItem('botflow_pending_images');
            fileParts = JSON.parse(raw) as typeof fileParts;
          }
        } catch {}
        sendMessageRef.current({ text: initialPrompt, files: fileParts ?? undefined });
        removePromptFromUrl();
      }, 0);
    }
  }, [initialized, initialPrompt, removePromptFromUrl]);

  // Keep scrolled to bottom on new messages or actions
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, actions.length]);

  // --- Submit handler ---
  const onFormSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const hasText = input.trim().length > 0;
    const hasImages = pendingImages.length > 0;
    if (!hasText && !hasImages) return;

    const usingAnthropic = model === 'claude-sonnet-4.6' || model === 'claude-opus-4.7';
    const hasAnthropicCreds = hasAnthropicKey || hasClaudeOAuth;
    const hasOpenAICreds = hasCodexOAuth || hasOpenAIKey;
    // Pro/Max users can use OpenAI and Anthropic models via platform server keys — only
    // block free-tier users who have no personal credentials for these providers.
    const isPayingTier = userTier === 'pro' || userTier === 'max';
    if (!isPayingTier) {
      if ((model === 'gpt-5.3-codex' && hasOpenAICreds === false) || (usingAnthropic && hasAnthropicCreds === false)) {
        toast({ title: 'Missing API key', description: `Please add your ${model === 'gpt-5.3-codex' ? 'OpenAI' : 'Anthropic'} API key in Settings, or upgrade to Pro.` });
        return;
      }
    }

    // Warn if model doesn't support images but images are attached
    if (hasImages && !modelSupportsImages(model)) {
      toast({ title: `${MODEL_CONFIGS[model].displayName} doesn't support images — images will be ignored` });
    }

    // --- Message queueing: if agent is working, queue the message ---
    if (isAgentWorking) {
      setMessageQueue(prev => [...prev, input.trim()]);
      setInput('');
      toast({ title: 'Message queued', description: `Will be sent when the agent finishes. (${messageQueue.length + 1} in queue)` });
      return;
    }

    // Wait for any in-flight uploads to complete
    if (pendingUploadsRef.current.size > 0) {
      await Promise.allSettled(Array.from(pendingUploadsRef.current.values()));
    }

    // Build file parts from successfully uploaded images
    const currentImages = pendingImages;
    const fileParts = currentImages
      .filter(img => img.uploaded && img.url)
      .map(img => ({
        type: 'file' as const,
        mediaType: (img.file.type || 'image/jpeg') as `image/${string}`,
        url: img.url!,
        filename: img.file.name,
      }));

    // Clean up pending images
    currentImages.forEach(img => URL.revokeObjectURL(img.localUrl));
    setPendingImages([]);

    setAgentError(null);
    setRetryCountdown(null);
    setEndTurnCalled(false);
    setShowCompletionWarning(false);
    setIsBusy(true);
    toolAbortRef.current = new AbortController();
    sendMessage({ text: input.trim(), files: fileParts.length > 0 ? fileParts : undefined });
    setInput('');
    removePromptFromUrl();
  }, [model, hasOpenAIKey, hasAnthropicKey, hasClaudeOAuth, hasCodexOAuth, isAgentWorking, input, pendingImages, messageQueue.length, sendMessage, removePromptFromUrl, toast]);

  // --- Re-prompt for lazy completion ---
  const handleReprompt = useCallback(() => {
    setShowCompletionWarning(false);
    setEndTurnCalled(false);
    setIsBusy(true);
    toolAbortRef.current = new AbortController();
    sendMessage({ text: 'You stopped without calling endTurn. Please continue or call endTurn if done.' });
  }, [sendMessage]);

  // --- Token usage bar color ---
  const tokenRatio = maxTokens > 0 ? tokenEstimate / maxTokens : 0;
  const tokenBarColor = tokenRatio >= 0.9 ? 'bg-red-500' : tokenRatio >= 0.7 ? 'bg-yellow-500' : 'bg-accent';

  const placeholder = useMemo(() => 'Ask Botflow...', []);

  // --- Handle input change ---
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  }, []);

  // --- Handle file selection for image attachments ---
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    // Reset input so the same file can be selected again
    e.target.value = '';

    for (const file of files) {
      const pendingId = crypto.randomUUID();
      const localUrl = URL.createObjectURL(file);

      setPendingImages(prev => [...prev, {
        id: pendingId,
        file,
        localUrl,
        uploading: true,
        uploaded: false,
      }]);

      const uploadPromise = (async () => {
        try {
          const processed = await processImageForUpload(file);
          const formData = new FormData();
          formData.append('file', processed);
          formData.append('projectId', projectId);

          const res = await fetch('/api/chat-images/upload', { method: 'POST', body: formData });
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error((data as { error?: string }).error ?? 'Upload failed');
          }
          const { id: dbId, url, key } = await res.json() as { id: string; url: string; key: string };

          setPendingImages(prev => prev.map(img =>
            img.id === pendingId
              ? { ...img, uploading: false, uploaded: true, dbId, url, key }
              : img
          ));
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Upload failed';
          setPendingImages(prev => prev.map(img =>
            img.id === pendingId
              ? { ...img, uploading: false, uploaded: false, error: msg }
              : img
          ));
        } finally {
          pendingUploadsRef.current.delete(pendingId);
        }
      })();

      pendingUploadsRef.current.set(pendingId, uploadPromise);
    }
  }, [projectId]);

  // --- Remove a pending image ---
  const handleRemoveImage = useCallback((pendingId: string) => {
    setPendingImages(prev => {
      const img = prev.find(i => i.id === pendingId);
      if (img) {
        URL.revokeObjectURL(img.localUrl);
        if (img.dbId) {
          fetch('/api/chat-images/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: img.dbId }),
          }).catch(() => {});
        }
      }
      return prev.filter(i => i.id !== pendingId);
    });
  }, []);

  // --- Error display component ---
  const renderError = () => {
    if (!agentError) return null;

    let errorContent: React.ReactNode;
    switch (agentError.type) {
      case 'rate_limit':
        errorContent = (
          <p className="flex-1 text-xs leading-relaxed whitespace-pre-wrap">
            Rate limited.{retryCountdown !== null && retryCountdown > 0
              ? ` Resets in ${retryCountdown}s.`
              : ' Please wait a moment and try again.'}
          </p>
        );
        break;
      case 'auth':
        errorContent = (
          <p className="flex-1 text-xs leading-relaxed whitespace-pre-wrap">
            Authentication error. Check your API key in{' '}
            <button type="button" onClick={() => setShowSettings(true)} className="underline hover:text-red-300">Settings</button>.
          </p>
        );
        break;
      case 'context_overflow':
        errorContent = (
          <p className="flex-1 text-xs leading-relaxed whitespace-pre-wrap">
            Context too large. Try sending a shorter message or{' '}
            <button
              type="button"
              onClick={async () => {
                const confirmed = window.confirm('Reset chat to free up context? This will delete all messages.');
                if (!confirmed) return;
                try {
                  await fetch(`/api/chat?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
                  savedIdsRef.current.clear();
                  lastAssistantSavedRef.current = null;
                  setMessages([]);
                  setAgentError(null);
                  setPendingImages(prev => { prev.forEach(img => URL.revokeObjectURL(img.localUrl)); return []; });
                } catch {}
              }}
              className="underline hover:text-red-300"
            >
              reset the conversation
            </button>.
          </p>
        );
        break;
      default:
        errorContent = <p className="flex-1 text-xs leading-relaxed whitespace-pre-wrap">{agentError.message}</p>;
    }

    return (
      <div className="flex items-start gap-2.5 rounded-xl px-3.5 py-3 bg-red-500/10 border border-red-500/20 text-red-400">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        {errorContent}
        <div className="flex items-center gap-1 shrink-0">
          {agentError.type !== 'auth' && (
            <button
              type="button"
              onClick={() => {
                setAgentError(null);
                setRetryCountdown(null);
                // Re-submit the last user message as a retry
                const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                if (lastUserMsg) {
                  const textPart = lastUserMsg.parts.find(p => p.type === 'text');
                  const content = textPart && 'text' in textPart ? textPart.text : '';
                  if (content) {
                    setIsBusy(true);
                    toolAbortRef.current = new AbortController();
                    sendMessage({ text: content });
                  }
                }
              }}
              className="text-red-400/60 hover:text-red-400 transition-colors"
              aria-label="Retry"
              title="Retry"
            >
              <RotateCcw size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => { setAgentError(null); setRetryCountdown(null); }}
            className="text-red-400/60 hover:text-red-400 transition-colors"
            aria-label="Dismiss"
          >
            <IconX size={13} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={cn('flex h-full flex-col text-sm bg-surface text-fg p-2.5', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface">
        <div className="flex items-center gap-2">
          <button onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings" className="text-muted hover:text-fg">
            <Cog size={16} />
          </button>
          <CreditGauge pct={creditPct} size="sm" />
        </div>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={model}
            onChange={async (next) => {
              try {
                const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: next }),
                });
                if (res.ok) setModel(next);
                else toast({ title: 'Failed to change model' });
              } catch {
                toast({ title: 'Failed to change model' });
              }
            }}
            providerAccess={providerAccess}
            userTier={userTier}
            onTierLocked={setLimitPayload}
            size="sm"
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={async () => {
              const confirmed = window.confirm('Reset chat? This will permanently delete all messages for this project.');
              if (!confirmed) return;
              try {
                await fetch(`/api/chat?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
                savedIdsRef.current.clear();
                lastAssistantSavedRef.current = null;
                setMessages([]);
                setHasAgentResponded(false);
                setTokenEstimate(0);
                // Clean up any pending image attachments
                setPendingImages(prev => {
                  prev.forEach(img => URL.revokeObjectURL(img.localUrl));
                  return [];
                });
              } catch (err) {
                console.error('Failed to reset chat:', err);
              }
            }}
          >
            Reset
          </Button>
        </div>
      </div>

      {/* Messages — v6 parts-based rendering */}
      <div ref={scrollRef} className="flex-1 overflow-auto space-y-3 p-3 modern-scrollbar">
        {messages.map((m) => {
          const filteredParts = m.parts.filter(part => {
            if (isToolUIPart(part) && getToolName(part) === 'endTurn') return false;
            // Skip whitespace-only text parts — they would break up consecutive tool groups
            if (part.type === 'text' && !part.text.trim()) return false;
            return true;
          });
          const hasTools = filteredParts.some(p => isToolUIPart(p));

          // User messages or assistant messages with no tools — no timeline
          if (m.role === 'user' || !hasTools) {
            return (
              <div key={m.id} className={cn('rounded-xl px-2 py-3 text-[1.1rem] tracking tight', m.role === 'user' ? 'bg-elevated' : '')}>
                {filteredParts.map((part, i) => {
                  if (part.type === 'text') return <Markdown key={i} content={part.text} />;
                  if (part.type === 'reasoning') {
                    return (
                      <div key={i} className="text-xs text-muted italic border-l-2 border-accent/30 pl-2 my-1">
                        {part.text}
                      </div>
                    );
                  }
                  if (part.type === 'file' && 'mediaType' in part && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/') && 'url' in part && typeof part.url === 'string') {
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setLightboxSrc(part.url as string)}
                        className="inline-block rounded-lg overflow-hidden border border-border mt-1 hover:opacity-90 transition-opacity"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={part.url as string} alt={'filename' in part && typeof part.filename === 'string' ? part.filename : ''} className="w-16 h-16 object-cover" crossOrigin="anonymous" />
                      </button>
                    );
                  }
                  return null;
                })}
              </div>
            );
          }

          // Assistant message with tools — grouped timeline segments
          // Group consecutive tool calls vs content
          const partGroups: Array<{ type: 'tools' | 'content'; items: Array<{ part: (typeof filteredParts)[number]; idx: number }> }> = [];
          for (let pi = 0; pi < filteredParts.length; pi++) {
            const part = filteredParts[pi];
            const gType = isToolUIPart(part) ? 'tools' as const : 'content' as const;
            const last = partGroups[partGroups.length - 1];
            if (last?.type === gType) last.items.push({ part, idx: pi });
            else partGroups.push({ type: gType, items: [{ part, idx: pi }] });
          }

          // Compute the timeline span: from first tool group to last tool group
          // Everything between them (including content) is connected by a single line
          const firstToolIdx = partGroups.findIndex(g => g.type === 'tools');
          let lastToolIdx = 0;
          for (let gi = partGroups.length - 1; gi >= 0; gi--) {
            if (partGroups[gi].type === 'tools') { lastToolIdx = gi; break; }
          }
          const preTimeline  = partGroups.slice(0, firstToolIdx);
          const timeline     = partGroups.slice(firstToolIdx, lastToolIdx + 1);
          const postTimeline = partGroups.slice(lastToolIdx + 1);

          const renderContentGroup = (group: typeof partGroups[number], key: string) =>
            group.items.map(({ part, idx }) => {
              if (part.type === 'text') return <Markdown key={`${key}-${idx}`} content={part.text} />;
              if (part.type === 'reasoning') {
                return (
                  <div key={`${key}-${idx}`} className="text-xs text-muted italic border-l-2 border-accent/30 pl-2 my-1">
                    {part.text}
                  </div>
                );
              }
              return null;
            });

          return (
            <div key={m.id} className="rounded-xl px-2 py-3 text-[1.1rem] tracking tight">
              {/* Content before the first tool call */}
              {preTimeline.map((group, gi) => (
                <div key={`pre-${gi}`}>{renderContentGroup(group, `pre-${gi}`)}</div>
              ))}

              {/* Single continuous timeline from first → last tool call */}
              <div className="relative">
                {/* One line spanning the full timeline height */}
                <div className="absolute left-[6px] top-[14px] bottom-0 w-px bg-border" />

                {timeline.map((group, ti) => {
                  const isLastInTimeline = ti === timeline.length - 1;
                  if (group.type === 'tools') {
                    return (
                      <div key={`tl-${ti}`} className={isLastInTimeline ? 'pb-2' : ''}>
                        {group.items.map(({ part, idx }) => {
                          if (!isToolUIPart(part)) return null;
                          return (
                            <ToolStep
                              key={idx}
                              toolName={getToolName(part)}
                              state={part.state}
                              content={
                                <pre className="text-xs overflow-auto bg-surface p-2 rounded border border-border">
                                  {JSON.stringify('input' in part ? part.input : part, null, 2)}
                                </pre>
                              }
                            />
                          );
                        })}
                      </div>
                    );
                  }
                  // Content between tool groups — indented to sit beside the line
                  return (
                    <div key={`tl-${ti}`} className="pl-6 py-1">
                      {renderContentGroup(group, `tl-${ti}`)}
                    </div>
                  );
                })}
              </div>

              {/* Content after the last tool call — full width, no line */}
              {postTimeline.map((group, gi) => (
                <div key={`post-${gi}`}>{renderContentGroup(group, `post-${gi}`)}</div>
              ))}
            </div>
          );
        })}

        {/* Error banner */}
        {renderError()}

        {/* Lazy completion warning */}
        {showCompletionWarning && !isAgentWorking && !agentError && (
          <div className="flex items-center gap-2.5 rounded-xl px-3.5 py-3 bg-yellow-500/10 border border-yellow-500/20 text-yellow-400">
            <AlertCircle size={14} className="shrink-0" />
            <p className="flex-1 text-xs leading-relaxed">Agent may not have finished.</p>
            <button
              type="button"
              onClick={handleReprompt}
              className="text-xs text-yellow-400 hover:text-yellow-300 underline shrink-0"
            >
              Re-prompt
            </button>
            <button
              type="button"
              onClick={() => setShowCompletionWarning(false)}
              className="text-yellow-400/60 hover:text-yellow-400 transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <IconX size={13} />
            </button>
          </div>
        )}

        {/* Persistent thinking indicator */}
        {isAgentWorking && (
          <div className="flex items-center gap-2 py-2">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span className="text-xs text-muted">Agent is working<span className="animate-pulse">...</span></span>
          </div>
        )}

      </div>

      {/* Compound input card */}
      <form
        onSubmit={(e) => { void onFormSubmit(e); }}
        className="group flex flex-col rounded-2xl border border-border bg-elevated transition-colors duration-150 ease-in-out relative mt-2"
      >
        {/* Inset top — Live Actions */}
        {actions.length > 0 && (
          <div className="border-b border-border">
            <LiveActions
              actions={actions}
              onClear={() => setActions([])}
              className="border-0 bg-transparent rounded-none"
            />
          </div>
        )}

        {/* Textarea */}
        <div data-state="closed" style={{ cursor: 'text' }} className="px-4 pt-3">
          <div className="relative flex flex-1 items-center">
            <textarea
              className="flex w-full ring-offset-background placeholder:text-muted focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none text-[16px] leading-snug placeholder-shown:text-ellipsis placeholder-shown:whitespace-nowrap md:text-base focus-visible:ring-0 focus-visible:ring-offset-0 max-h-[200px] bg-transparent focus:bg-transparent flex-1 m-1 rounded-md p-0"
              id="chatinput"
              placeholder={isAgentWorking ? 'Type to queue a message...' : placeholder}
              maxLength={50000}
              style={{ minHeight: 40, height: 40 }}
              value={input}
              onChange={handleInputChange}
            />
          </div>
        </div>

        {/* Image thumbnail strip */}
        {pendingImages.length > 0 && (
          <div className="flex overflow-x-auto px-4 pb-1 gap-2 modern-scrollbar">
            {pendingImages.map(img => (
              <div key={img.id} className="relative group shrink-0">
                <div className="w-12 h-12 rounded-lg border border-border overflow-hidden bg-soft flex items-center justify-center">
                  {img.uploading ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.localUrl} alt="" className="w-full h-full object-cover opacity-50" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 size={16} className="animate-spin text-accent" />
                      </div>
                    </>
                  ) : img.error ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.localUrl} alt="" className="w-full h-full object-cover opacity-30" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <AlertCircle size={16} className="text-red-400" />
                      </div>
                    </>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={img.localUrl} alt={img.file.name} className="w-full h-full object-cover" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center size-4 rounded-full bg-surface border border-border text-muted hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove image"
                >
                  <IconX size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Buttons row */}
        <div className="flex items-center gap-1 px-4 pb-2">
          <input
            ref={fileInputRef}
            id="file-upload"
            className="hidden"
            accept="image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp"
            multiple
            tabIndex={-1}
            type="file"
            onChange={handleFileSelect}
          />

          {/* Attach image button */}
          {modelSupportsImages(model) && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center size-6 rounded-full text-muted hover:text-foreground transition-colors"
              title="Attach image"
              aria-label="Attach image"
            >
              <ImagePlus size={16} />
            </button>
          )}

          {/* Queued message count */}
          {messageQueue.length > 0 && (
            <span className="text-[10px] text-muted bg-soft border border-border rounded-full px-2 py-0.5">
              {messageQueue.length} queued
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-1">
              {isAgentWorking && input.trim() ? (
                /* Queue button: shown when agent is working AND user has typed something */
                <button
                  id="chatinput-queue-button"
                  type="submit"
                  className="flex size-6 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors duration-150 ease-out hover:opacity-80"
                  title="Queue message"
                  aria-label="Queue message"
                >
                  <ListPlus size={16} />
                </button>
              ) : isAgentWorking ? (
                /* Stop button: shown when agent is working and no text entered */
                <button
                  id="chatinput-stop-button"
                  type="button"
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-700 transition-colors duration-150 ease-out'
                  )}
                  onClick={() => {
                    stop();
                    if (toolAbortRef.current) {
                      toolAbortRef.current.abort();
                    }
                    setIsBusy(false);
                    if (busyDebounceRef.current) {
                      clearTimeout(busyDebounceRef.current);
                      busyDebounceRef.current = null;
                    }
                    setShowCompletionWarning(false);
                    setMessageQueue([]);
                  }}
                  title="Stop"
                  aria-label="Stop"
                >
                  <IconX size={18} />
                </button>
              ) : (
                <button
                  id="chatinput-send-message-button"
                  type="submit"
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full bg-accent text-accent-foreground transition-opacity duration-150 ease-out',
                    !input.trim() && pendingImages.length === 0 ? 'disabled:cursor-not-allowed disabled:opacity-50 opacity-50' : ''
                  )}
                  disabled={!input.trim() && pendingImages.length === 0}
                  title="Send"
                  aria-label="Send"
                >
                  <ArrowUp size={20} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Inset bottom — Token counter */}
        {tokenEstimate > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 border-t border-border">
            <div className="flex-1 h-1 rounded-full bg-soft overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-300', tokenBarColor)}
                style={{ width: `${Math.min(tokenRatio * 100, 100)}%` }}
              />
            </div>
            <span className={cn(
              'text-[10px] tabular-nums',
              tokenRatio >= 0.9 ? 'text-red-400' : tokenRatio >= 0.7 ? 'text-yellow-400' : 'text-muted'
            )}>
              {formatTokenCount(tokenEstimate)} / {formatTokenCount(maxTokens)}
            </span>
          </div>
        )}
      </form>

      {createPortal(
        <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} workspaceContext />,
        document.body
      )}

      {lightboxSrc && createPortal(
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />,
        document.body
      )}

      {limitPayload && createPortal(
        <LimitModal payload={limitPayload} onClose={() => setLimitPayload(null)} />,
        document.body
      )}
    </div>
  );
}