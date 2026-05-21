"use client";

/**
 * Agent backend UI elements.
 *
 * Two pieces:
 *  - <BackendBadge> — small always-visible pill at the top of AgentPanel.
 *      Shows the active backend's glyph + name. Pure visual, no interaction.
 *  - <BackendChip> — chip rendered next to the model picker. Three modes:
 *      1. hidden     — no choice and the active backend is the default
 *                       (avoids visual noise for the typical free user)
 *      2. info-only  — locked to one backend; clicking opens a "what this means"
 *                       popover so users learn why
 *      3. toggle     — BYOK choice; two-segment switch
 *
 * Both share the same brand glyphs (loaded from /brand/ + /model-icons/) so
 * the agent identity is consistent across the panel.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { AgentBackend, BackendResolution, ResolutionReason } from "@/lib/agent/backend-resolution";

interface GlyphProps {
  size?: number;
  className?: string;
}

function BotflowGlyph({ size = 14, className }: GlyphProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/botflow-glyph.svg"
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    />
  );
}

function AnthropicGlyph({ size = 14, className }: GlyphProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/model-icons/anthropic.png"
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 rounded-sm", className)}
    />
  );
}

export function BackendGlyph({ backend, size = 14, className }: { backend: AgentBackend; size?: number; className?: string }) {
  return backend === "claude-code"
    ? <AnthropicGlyph size={size} className={className} />
    : <BotflowGlyph size={size} className={className} />;
}

function backendLabel(backend: AgentBackend): string {
  return backend === "claude-code" ? "Claude Code" : "Botflow";
}

/* ─────────────────────────────────────────────────────────────────────────
 * Top-of-panel badge
 * ────────────────────────────────────────────────────────────────────── */

export function BackendBadge({ backend }: { backend: AgentBackend }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full bg-elevated border border-border px-2 py-0.5 text-[11px] text-muted"
      title={`Agent: ${backendLabel(backend)}`}
    >
      <BackendGlyph backend={backend} size={12} />
      <span className="font-medium text-fg leading-none">{backendLabel(backend)}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Inline chip (next to model picker)
 * ────────────────────────────────────────────────────────────────────── */

const reasonCopy: Record<ResolutionReason, { title: string; body: string } | null> = {
  flag_disabled: null,
  non_anthropic_model: null,
  non_sandbox_platform: null,
  oauth_required: {
    title: "Your Claude subscription is being used",
    body:
      "You're signed in with your Claude account. Anthropic requires that subscription tokens flow through their official Claude Code client — never a third party. So your Anthropic model requests run inside a real `claude` process in your project's sandbox, billed to your plan.\n\nNothing about this is custom — it's how Anthropic intends paid subscriptions to be used outside the Claude app.",
  },
  byok_choice: {
    title: "Pick your agent",
    body:
      "You have an Anthropic API key, so you can run Claude either through Botflow's agent (our tools, our prompting) or through Anthropic's official Claude Code (their tools, their autonomy). Both bill your API key — pick whichever you prefer.",
  },
  platform_key_only: null,
};

export interface BackendChipProps {
  backend: AgentBackend;
  resolution: BackendResolution;
  onRequestSwitch: (next: AgentBackend) => void;
  /** Disable interaction while a switch is in-flight. */
  switching?: boolean;
}

export function BackendChip({ backend, resolution, onRequestSwitch, switching }: BackendChipProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Dismiss the popover when clicking elsewhere.
  useEffect(() => {
    if (!popoverOpen) return;
    function handleClickAway(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickAway);
    return () => document.removeEventListener("mousedown", handleClickAway);
  }, [popoverOpen]);

  // Hidden when the resolution forces Botflow for a non-meaningful reason
  // (flag off, WebContainer, non-Anthropic model, or platform-key-only). The
  // top BackendBadge still communicates "you're on Botflow" — the inline chip
  // is only for surfacing a *meaningful* choice or explanation.
  const copy = reasonCopy[resolution.reason];
  if (!copy) return null;

  // BYOK toggle
  if (resolution.locked === null && resolution.available.length >= 2) {
    return (
      <div ref={wrapperRef} className="relative inline-flex items-center">
        <div className="inline-flex items-center gap-0.5 rounded-full bg-elevated border border-border p-0.5">
          {(["botflow", "claude-code"] as const).map((option) => {
            const active = backend === option;
            return (
              <button
                key={option}
                type="button"
                disabled={switching}
                onClick={() => {
                  if (option !== backend) onRequestSwitch(option);
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium transition",
                  active ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
                  switching && "opacity-50 cursor-not-allowed",
                )}
                title={`Use ${backendLabel(option)}`}
              >
                <BackendGlyph backend={option} size={12} />
                {backendLabel(option)}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setPopoverOpen(true)}
          className="ml-1 text-muted hover:text-fg text-[11px] underline-offset-2 hover:underline"
          aria-label="What does this mean?"
        >
          What&apos;s this?
        </button>
        {popoverOpen && (
          <Popover title={copy.title} body={copy.body} onClose={() => setPopoverOpen(false)} />
        )}
      </div>
    );
  }

  // Locked / info-only — show the active backend as an info chip
  return (
    <div ref={wrapperRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setPopoverOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 border border-accent/30 px-2 py-1 text-[11px] font-medium text-fg hover:bg-accent/15"
      >
        <BackendGlyph backend={resolution.locked ?? backend} size={12} />
        {copy.title}
        <span className="text-muted">·</span>
        <span className="text-accent underline-offset-2 hover:underline">What this means?</span>
      </button>
      {popoverOpen && (
        <Popover title={copy.title} body={copy.body} onClose={() => setPopoverOpen(false)} />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Popover (positioned below the trigger, follows existing patterns)
 * ────────────────────────────────────────────────────────────────────── */

function Popover({ title, body, onClose }: { title: string; body: string; onClose: () => void }) {
  return (
    <div className="absolute left-0 top-full mt-1 z-50 w-80 rounded-xl border border-border bg-surface shadow-lg p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-fg">{title}</div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-fg text-xs"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-snug text-muted whitespace-pre-wrap">{body}</p>
    </div>
  );
}
