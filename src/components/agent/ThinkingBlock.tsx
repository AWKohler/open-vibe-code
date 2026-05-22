"use client";

/**
 * ThinkingBlock — collapsible "Thinking" / "Thought" header for reasoning parts.
 *
 * Replaces the verbose italic block we used to render for `part.type === 'reasoning'`.
 * Default state: collapsed, one line. Click to reveal the full reasoning content.
 *
 * While the model is still streaming reasoning (`state === 'streaming'`) the
 * header reads "Thinking" with a shimmer animation. Once `state === 'done'`
 * (or if no state info is present and the message is otherwise complete), it
 * switches to a static "Thought" label.
 *
 * Used by AgentPanel for both Botflow and Claude Code agent paths — any
 * `reasoning` part flows through this same component.
 */
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const SHIMMER_STYLE_ID = "botflow-thinking-shimmer-styles";
const SHIMMER_STYLES = `
@keyframes botflow-thinking-shimmer {
  from { background-position: 100% center; }
  to   { background-position: 0% center; }
}
.botflow-thinking-shimmer {
  display: inline-block;
  background-size: 250% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  background-image: linear-gradient(
    90deg,
    var(--color-muted, #94a3b8) 0%,
    var(--color-muted, #94a3b8) 40%,
    var(--color-foreground, #f5f5f4) 50%,
    var(--color-muted, #94a3b8) 60%,
    var(--color-muted, #94a3b8) 100%
  );
  background-repeat: no-repeat;
  animation: botflow-thinking-shimmer 1.4s linear infinite;
}
`;

let shimmerInjected = false;
function ensureShimmerStyles() {
  if (typeof document === "undefined" || shimmerInjected) return;
  if (document.getElementById(SHIMMER_STYLE_ID)) {
    shimmerInjected = true;
    return;
  }
  const el = document.createElement("style");
  el.id = SHIMMER_STYLE_ID;
  el.textContent = SHIMMER_STYLES;
  document.head.appendChild(el);
  shimmerInjected = true;
}

export interface ThinkingBlockProps {
  /** Full reasoning text. May be partial while streaming. */
  content: string;
  /**
   * 'streaming' → shimmer header, label "Thinking"
   * 'done' (or undefined) → static muted header, label "Thought"
   *
   * The AI SDK populates this on `ReasoningUIPart`. Older messages (loaded
   * from the DB before this field existed) will read `undefined`, which we
   * treat as 'done' since they're historical.
   */
  state?: "streaming" | "done";
  className?: string;
}

export function ThinkingBlock({ content, state, className }: ThinkingBlockProps) {
  useEffect(() => {
    ensureShimmerStyles();
  }, []);

  const [open, setOpen] = useState(false);
  const hasContent = content.trim().length > 0;
  const isThinking = state === "streaming";
  const label = isThinking ? "Thinking" : "Thought";

  return (
    <div className={cn("flex flex-col gap-1.5 my-1", className)}>
      <button
        type="button"
        onClick={() => hasContent && setOpen((v) => !v)}
        disabled={!hasContent}
        aria-expanded={hasContent ? open : undefined}
        className={cn(
          "group inline-flex items-center gap-1 self-start select-none rounded-md px-0 py-0 bg-transparent border-0 text-left text-xs",
          hasContent ? "cursor-pointer hover:text-fg" : "cursor-default",
          "text-muted",
        )}
      >
        <ChevronRight
          size={11}
          className={cn(
            "shrink-0 transition-transform duration-150 ease-out",
            open ? "rotate-90" : "rotate-0",
            !hasContent && "opacity-40",
          )}
        />
        <span className="font-medium whitespace-nowrap leading-none">
          {isThinking ? (
            <span className="botflow-thinking-shimmer">{label}</span>
          ) : (
            label
          )}
        </span>
      </button>
      {hasContent && open && (
        <div className="overflow-hidden ml-3 border-l-2 border-border pl-2">
          <div className="max-h-48 overflow-y-auto modern-scrollbar">
            <p className="text-xs text-muted italic whitespace-pre-wrap leading-relaxed">
              {content}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
