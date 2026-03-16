"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { WebContainer } from "@webcontainer/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Globe,
  ExternalLink,
  Copy,
  Loader2,
  Check,
  Trash2,
  RefreshCw,
  AlertCircle,
  Smartphone,
  Apple,
  Play,
  Hammer,
} from "lucide-react";

type PublishState = "idle" | "building" | "published" | "error";

interface PublishPanelProps {
  projectId: string;
  webcontainer: WebContainer | null;
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  cloudflareProjectName: string | null;
  cloudflareDeploymentUrl: string | null;
  onPublished: (name: string, url: string) => void;
  onUnpublished: () => void;
  platform?: "web" | "mobile" | "multiplatform";
}

/** Recursively read all files under a directory as base64 strings */
async function readDistFilesAsBase64(
  container: WebContainer,
  basePath: string,
  relativeTo: string,
  acc: Record<string, string> = {}
): Promise<Record<string, string>> {
  const entries = await container.fs.readdir(basePath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = basePath === "/" ? `/${entry.name}` : `${basePath}/${entry.name}`;
    const relPath = fullPath.slice(relativeTo.length);
    if (entry.isDirectory()) {
      await readDistFilesAsBase64(container, fullPath, relativeTo, acc);
    } else {
      try {
        // Read as binary (Uint8Array) to handle images, fonts, wasm etc.
        const bytes = await container.fs.readFile(fullPath);
        // Convert Uint8Array to base64
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        acc[relPath] = btoa(binary);
      } catch {
        // skip unreadable
      }
    }
  }
  return acc;
}

export function PublishPanel({
  projectId,
  webcontainer,
  isOpen,
  onClose,
  anchorRef,
  cloudflareProjectName,
  cloudflareDeploymentUrl,
  onPublished,
  onUnpublished,
  platform = "web",
}: PublishPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ top: 0, right: 0 });

  const [state, setState] = useState<PublishState>(
    cloudflareDeploymentUrl ? "published" : "idle"
  );
  const [statusText, setStatusText] = useState("");
  const [errorOutput, setErrorOutput] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  // Sync state with props
  useEffect(() => {
    if (cloudflareDeploymentUrl) {
      setState("published");
    } else if (state === "published") {
      setState("idle");
    }
  }, [cloudflareDeploymentUrl]);

  // Position from anchor
  useEffect(() => {
    if (isOpen && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setCoords({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      });
    }
  }, [isOpen, anchorRef]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose, anchorRef]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const handlePublish = useCallback(async () => {
    if (!webcontainer) return;
    setState("building");
    setStatusText("Building...");
    setErrorOutput("");

    try {
      // 1. Run build — multiplatform uses build:web (expo export --platform web)
      setStatusText("Building project...");
      const buildCmd = platform === "multiplatform" ? "build:web" : "build";
      const buildProcess = await webcontainer.spawn("pnpm", ["run", buildCmd]);

      let buildOutput = "";
      const reader = buildProcess.output.getReader();
      let reading = true;

      // Drain output concurrently — output stream and proc.exit can deadlock
      // if you await one fully before the other
      const drain = (async () => {
        try {
          while (reading) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) buildOutput += value;
          }
        } catch {
          // ignore
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      })();

      const exitCode = await buildProcess.exit;
      reading = false;
      try { await reader.cancel(); } catch {}
      await drain;
      if (exitCode !== 0) {
        setState("error");
        setErrorOutput(buildOutput || "Build failed with no output");
        return;
      }

      // 2. Read dist/ files as base64
      setStatusText("Packaging...");

      // Check if dist/ exists
      try {
        await webcontainer.fs.readdir("/dist");
      } catch {
        setState("error");
        setErrorOutput(
          "No /dist directory found after build. Make sure your build outputs to /dist.\n\n" +
          "If your project uses a different output directory (e.g., build/), update your vite.config or build config to output to dist/."
        );
        return;
      }

      const files = await readDistFilesAsBase64(webcontainer, "/dist", "/dist");

      if (Object.keys(files).length === 0) {
        setState("error");
        setErrorOutput("Build produced an empty dist/ directory.");
        return;
      }

      // 3. Upload
      setStatusText("Uploading to Cloudflare...");
      const res = await fetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });

      if (!res.ok) {
        const err = await res.json();
        setState("error");
        setErrorOutput(err.error || "Upload failed");
        return;
      }

      const data = await res.json() as { ok: boolean; url: string; projectName: string };
      setState("published");
      onPublished(data.projectName, data.url);
    } catch (err) {
      setState("error");
      setErrorOutput(err instanceof Error ? err.message : String(err));
    }
  }, [webcontainer, projectId, onPublished]);

  const handleUnpublish = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`, {
        method: "DELETE",
      });
      if (res.ok) {
        setState("idle");
        setConfirmUnpublish(false);
        onUnpublished();
      }
    } catch (err) {
      console.error("Unpublish error:", err);
    }
  }, [projectId, onUnpublished]);

  const handleCopyUrl = useCallback(() => {
    if (cloudflareDeploymentUrl) {
      navigator.clipboard.writeText(cloudflareDeploymentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [cloudflareDeploymentUrl]);

  const handleCopyError = useCallback(() => {
    navigator.clipboard.writeText(errorOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [errorOutput]);

  if (!isOpen) return null;

  const panel = (
    <div
      ref={panelRef}
      className={cn(
        "fixed z-[9999] w-80",
        "bg-surface border border-border rounded-xl shadow-xl",
        "flex flex-col"
      )}
      style={{
        top: coords.top,
        right: coords.right,
        maxHeight: "calc(100vh - 80px)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Globe
            className={cn(
              "w-4 h-4",
              state === "published" ? "text-green-500" : "text-muted opacity-60"
            )}
          />
          <span className="text-sm font-semibold">{platform === "multiplatform" ? "Deploy" : "Publish"}</span>
        </div>
        {state === "published" && (
          <span className="text-[10px] text-green-600 dark:text-green-400 font-medium bg-green-500/10 px-2 py-0.5 rounded-full">
            Live
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto modern-scrollbar">
        {state === "idle" && (
          <div className="flex flex-col items-center gap-4 px-5 py-8 text-center">
            <div className="w-12 h-12 rounded-full bg-soft/60 flex items-center justify-center">
              <Globe className="w-6 h-6 text-muted" />
            </div>
            <div>
              <p className="text-sm font-medium">{platform === "multiplatform" ? "Deploy Web Version" : "Publish to the web"}</p>
              <p className="text-xs text-muted mt-1 leading-relaxed">
                {platform === "multiplatform"
                  ? "Export and deploy the web version of your app to Cloudflare Pages."
                  : "Build and deploy your project to a live URL on Cloudflare Pages."}
              </p>
            </div>
            <Button
              size="sm"
              className="w-full"
              onClick={handlePublish}
              disabled={!webcontainer}
            >
              Publish
            </Button>
          </div>
        )}

        {state === "building" && (
          <div className="flex flex-col items-center gap-4 px-5 py-8 text-center">
            <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-accent animate-spin" />
            </div>
            <div>
              <p className="text-sm font-medium">{statusText}</p>
              <p className="text-xs text-muted mt-1">This may take a moment</p>
            </div>
          </div>
        )}

        {state === "published" && (
          <div className="flex flex-col gap-3 px-4 py-4">
            {/* URL display */}
            <div className="flex items-center gap-2 px-3 py-2 bg-bg rounded-lg border border-border">
              <Globe size={12} className="text-green-500 shrink-0" />
              <a
                href={cloudflareDeploymentUrl ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent truncate flex-1 hover:underline"
              >
                {cloudflareDeploymentUrl}
              </a>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleCopyUrl}
              >
                {copied ? (
                  <Check size={13} className="mr-1.5 text-green-500" />
                ) : (
                  <Copy size={13} className="mr-1.5" />
                )}
                {copied ? "Copied" : "Copy URL"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => window.open(cloudflareDeploymentUrl ?? "#", "_blank")}
              >
                <ExternalLink size={13} className="mr-1.5" />
                Open
              </Button>
            </div>

            {/* Update button */}
            <Button
              size="sm"
              className="w-full"
              onClick={handlePublish}
              disabled={!webcontainer}
            >
              <RefreshCw size={13} className="mr-1.5" />
              Update
            </Button>

            {/* Unpublish */}
            {!confirmUnpublish ? (
              <button
                type="button"
                onClick={() => setConfirmUnpublish(true)}
                className="flex items-center justify-center gap-1.5 text-xs text-muted hover:text-red-500 transition-colors mt-1"
              >
                <Trash2 size={11} />
                Unpublish
              </button>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-muted flex-1">Remove deployment?</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => setConfirmUnpublish(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-7 px-2 text-red-500 border-red-500/40 hover:bg-red-500/10"
                  onClick={handleUnpublish}
                >
                  Confirm
                </Button>
              </div>
            )}
          </div>
        )}

        {state === "error" && (
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex items-center gap-2">
              <AlertCircle size={14} className="text-red-500 shrink-0" />
              <span className="text-xs font-medium text-red-500">Build failed</span>
            </div>

            {/* Error output */}
            <textarea
              readOnly
              value={errorOutput}
              className={cn(
                "w-full h-40 px-3 py-2 text-[11px] font-mono rounded-lg resize-none",
                "bg-bg border border-border text-foreground",
                "modern-scrollbar"
              )}
            />

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleCopyError}
              >
                {copied ? (
                  <Check size={13} className="mr-1.5 text-green-500" />
                ) : (
                  <Copy size={13} className="mr-1.5" />
                )}
                {copied ? "Copied" : "Copy error"}
              </Button>
              <Button
                size="sm"
                className="flex-1"
                onClick={handlePublish}
              >
                Try Again
              </Button>
            </div>

            <p className="text-[10px] text-muted text-center leading-relaxed">
              Tip: Copy the error and paste it in the chat for help fixing it.
            </p>
          </div>
        )}
      </div>

      {/* Native Builds Section (multiplatform only) */}
      {platform === "multiplatform" && (
        <div className="border-t border-border">
          <div className="px-4 py-3 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-muted opacity-60" />
              <span className="text-sm font-semibold">Native Builds</span>
              <span className="text-[10px] text-muted bg-soft px-1.5 py-0.5 rounded-full ml-auto">Coming Soon</span>
            </div>
          </div>
          <div className="flex flex-col gap-2 px-4 py-3">
            {/* iOS Build */}
            <button
              type="button"
              disabled
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg/50 opacity-60 cursor-not-allowed"
            >
              <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center shrink-0">
                <Apple size={16} className="text-white" />
              </div>
              <div className="flex-1 text-left">
                <div className="text-xs font-medium text-fg">iOS Build</div>
                <div className="text-[10px] text-muted">Compile for App Store</div>
              </div>
              <Hammer size={14} className="text-muted" />
            </button>

            {/* Android Build */}
            <button
              type="button"
              disabled
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg/50 opacity-60 cursor-not-allowed"
            >
              <div className="w-8 h-8 rounded-lg bg-green-600 flex items-center justify-center shrink-0">
                <Play size={16} className="text-white" />
              </div>
              <div className="flex-1 text-left">
                <div className="text-xs font-medium text-fg">Android Build</div>
                <div className="text-[10px] text-muted">Compile for Play Store</div>
              </div>
              <Hammer size={14} className="text-muted" />
            </button>

            <p className="text-[10px] text-muted text-center leading-relaxed mt-1">
              Native builds will be available in a future update.
              Web deployment above is fully functional.
            </p>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(panel, document.body);
}
