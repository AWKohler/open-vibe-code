"use client";

/**
 * Conflict resolution modal for the sandboxed-web GitHub flow.
 *
 * Default mode (Phase B): non-developer view.
 *   • Lists conflicted files with three per-file actions:
 *       "Let assistant fix this" (Phase E stub), "Use mine", "Use GitHub's".
 *   • Bottom escape hatch: "Discard my changes and use GitHub's version".
 *   • Bottom escape hatch: "Fix manually (advanced)" — Phase E will swap in
 *     the three-pane diff editor; for now we show a tooltip explaining it's
 *     coming next.
 *
 * Once every file has a resolution, "Complete merge" calls /resolve and
 * closes the modal. Push happens separately from the panel.
 */
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, GitMerge, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export interface ConflictBlob {
  marked: string;
  ours: string | null;
  theirs: string | null;
  base: string | null;
}

interface ConflictModalProps {
  projectId: string;
  branch: string;
  conflicts: string[];
  conflictBlobs: Record<string, ConflictBlob>;
  onClose: () => void;
  onResolved: () => void;
}

type ResolutionChoice =
  | { kind: "ours" }
  | { kind: "theirs" }
  | { kind: "agent"; pending: true } // Phase E placeholder
  | { kind: "manual"; content: string }; // Phase E

export function ConflictModal({
  projectId,
  branch,
  conflicts,
  conflictBlobs,
  onClose,
  onResolved,
}: ConflictModalProps) {
  const { toast } = useToast();
  const [choices, setChoices] = useState<Record<string, ResolutionChoice>>({});
  const [finalizing, setFinalizing] = useState(false);
  const [aborting, setAborting] = useState(false);

  const allResolved = useMemo(
    () => conflicts.every((p) => Boolean(choices[p])),
    [conflicts, choices],
  );

  const setChoice = useCallback((path: string, choice: ResolutionChoice) => {
    setChoices((prev) => ({ ...prev, [path]: choice }));
  }, []);

  const completeMerge = useCallback(async () => {
    setFinalizing(true);
    try {
      const resolutions = conflicts
        .map((path) => {
          const c = choices[path];
          if (!c) return null;
          if (c.kind === "ours") return { path, side: "ours" as const };
          if (c.kind === "theirs") return { path, side: "theirs" as const };
          if (c.kind === "manual") return { path, content: c.content };
          return null; // agent choices were already applied externally
        })
        .filter((r): r is { path: string; side: "ours" | "theirs" } | { path: string; content: string } => r !== null);

      const res = await fetch(`/api/projects/${projectId}/github/sandbox/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolutions,
          finalizeMessage: `Merge branch '${branch}' into ${branch}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (!data.finalized) {
        toast({
          title: "Some files still have conflict markers",
          description: `Remaining: ${(data.remainingConflicts as string[]).join(", ")}`,
        });
        return;
      }
      toast({ title: "Merge complete", description: "You can push now." });
      onResolved();
      onClose();
    } catch (e) {
      toast({ title: "Resolve failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFinalizing(false);
    }
  }, [branch, choices, conflicts, onClose, onResolved, projectId, toast]);

  const discardLocalChanges = useCallback(async () => {
    if (!confirm(`This discards all your local changes and uses GitHub's version of every file. Continue?`)) return;
    setAborting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/github/sandbox/abort-merge`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast({ title: "Merge aborted", description: "Local changes restored to pre-pull state." });
      onResolved();
      onClose();
    } catch (e) {
      toast({ title: "Abort failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAborting(false);
    }
  }, [onClose, onResolved, projectId, toast]);

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-surface shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <GitMerge size={16} className="text-accent" />
            <div>
              <h2 className="text-sm font-medium text-fg">Some files were also changed on GitHub.</h2>
              <p className="text-[11px] text-muted mt-0.5">
                Pick how to handle each one, then complete the merge.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-fg"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto modern-scrollbar p-3 space-y-2">
          {conflicts.map((path) => (
            <ConflictFileCard
              key={path}
              path={path}
              blob={conflictBlobs[path]}
              choice={choices[path] ?? null}
              onChoose={(c) => setChoice(path, c)}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Button
              onClick={completeMerge}
              disabled={!allResolved || finalizing}
              size="sm"
              className="flex-1"
            >
              {finalizing ? <Loader2 size={12} className="animate-spin" /> : "Complete merge"}
            </Button>
            <Button onClick={onClose} variant="ghost" size="sm" disabled={finalizing}>
              Cancel
            </Button>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <button
              type="button"
              disabled
              className="text-muted/50 cursor-not-allowed"
              title="Three-pane manual editor coming in the next phase"
            >
              Fix manually (advanced) — coming soon
            </button>
            <button
              type="button"
              onClick={discardLocalChanges}
              disabled={aborting}
              className="text-muted hover:text-red-400"
            >
              {aborting ? "Aborting…" : "Discard my changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(modal, document.body);
}

// ── Per-file card ────────────────────────────────────────────────────────

function ConflictFileCard({
  path,
  blob,
  choice,
  onChoose,
}: {
  path: string;
  blob: ConflictBlob | undefined;
  choice: ResolutionChoice | null;
  onChoose: (c: ResolutionChoice) => void;
}) {
  const previewLines = blob?.marked.split("\n").slice(0, 8).join("\n");

  return (
    <div className="rounded-lg border border-border bg-elevated p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-xs text-fg truncate">{path}</div>
        {choice && (
          <span className="inline-flex items-center gap-1 text-[10px] text-accent">
            <Check size={10} />
            {labelForChoice(choice)}
          </span>
        )}
      </div>

      {previewLines && (
        <pre className="mt-2 text-[10px] text-muted bg-surface border border-border rounded p-2 max-h-24 overflow-hidden whitespace-pre-wrap">
          {previewLines}
          {(blob?.marked.split("\n").length ?? 0) > 8 ? "\n…" : ""}
        </pre>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={choice?.kind === "agent" ? "default" : "outline"}
          onClick={() =>
            onChoose({ kind: "agent", pending: true })
          }
          disabled
          title="Agent-led merge lands in Phase E"
        >
          <AlertCircle size={11} className="mr-1" />
          Let assistant fix this — soon
        </Button>
        <Button
          size="sm"
          variant={choice?.kind === "ours" ? "default" : "outline"}
          onClick={() => onChoose({ kind: "ours" })}
        >
          Use mine
        </Button>
        <Button
          size="sm"
          variant={choice?.kind === "theirs" ? "default" : "outline"}
          onClick={() => onChoose({ kind: "theirs" })}
        >
          Use GitHub&apos;s
        </Button>
      </div>
    </div>
  );
}

function labelForChoice(c: ResolutionChoice): string {
  switch (c.kind) {
    case "ours":
      return "Using mine";
    case "theirs":
      return "Using GitHub's";
    case "agent":
      return "Agent-led";
    case "manual":
      return "Manually edited";
  }
}
