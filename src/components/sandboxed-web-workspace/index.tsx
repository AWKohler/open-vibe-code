"use client";

/**
 * SandboxedWebWorkspace
 *
 * The web/Vite-Convex experience but driven by a Vercel Sandbox instead of a
 * StackBlitz WebContainer. Mirrors `<Workspace>` for layout/UX:
 *
 *   • Tabs: Preview / Code / Database (Database only when hasBackend)
 *   • Sidebar (on Code): Files / Search / ENV
 *   • Terminal panel at the bottom of Code tab (xterm via sandbox/exec SSE)
 *   • Play to start the dev server inside the sandbox
 *   • Preview iframe sources the public domain returned by `sandbox.domain(port)`
 *
 * Out of scope for v1 (deferred — both panels are heavily WebContainer-coupled
 * and need a separate refactor):
 *   • GitHub panel
 *   • Publish panel (Cloudflare deploy)
 *   • HTML snapshot capture (requires postMessage from a cross-origin iframe;
 *     verify the template's main.tsx forwarding works to *.vercel.run first)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useToast } from "@/components/ui/toast";
import { CodeEditor } from "@/components/workspace/code-editor";
import { FileTree } from "@/components/workspace/file-tree";
import { EnvPanel } from "@/components/workspace/env-panel";
import { ImageViewer } from "@/components/workspace/image-viewer";
import { Preview } from "@/components/workspace/preview";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { ConvexDashboard } from "@/components/convex/ConvexDashboard";
import { Button } from "@/components/ui/button";
import { Tabs, TabOption } from "@/components/ui/tabs";
import { UserButton } from "@clerk/nextjs";

const PersistentTerminal = dynamic(
  () => import("@/components/persistent-workspace/terminal").then((m) => m.PersistentTerminal),
  { ssr: false, loading: () => <div className="h-full w-full bg-elevated" /> },
);
import {
  PanelLeft,
  Save,
  Play,
  Loader2,
  Monitor,
  Tablet,
  Smartphone,
  AppWindow,
  Frame,
  ArrowUpRight,
} from "lucide-react";
import type { PreviewInfo } from "@/lib/preview-store";
import { cn } from "@/lib/utils";
import {
  normalizeBackendType,
  projectUsesConvex,
  type BackendType,
} from "@/lib/project-platform";
import { FileSearch } from "@/components/persistent-workspace/file-search";

type WorkspaceView = "preview" | "code" | "database";
type SandboxStatus = "idle" | "booting" | "ready" | "error";
type FileEntry = { type: "file" | "folder" };

interface SandboxedWebWorkspaceProps {
  projectId: string;
  initialPrompt?: string;
  backendType?: BackendType;
}

export function SandboxedWebWorkspace({
  projectId,
  initialPrompt,
  backendType: initialBackendType,
}: SandboxedWebWorkspaceProps) {
  const { toast } = useToast();

  // ── Sandbox lifecycle ────────────────────────────────────────────────
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus>("idle");
  const [bootError, setBootError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // ── File state ───────────────────────────────────────────────────────
  const [files, setFiles] = useState<Record<string, FileEntry>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null);
  const [imageByteLength, setImageByteLength] = useState<number | undefined>(undefined);

  // ── UI state ─────────────────────────────────────────────────────────
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"files" | "search" | "env">("files");
  const [currentView, setCurrentView] = useState<WorkspaceView>("preview");

  // ── Preview / dev server ─────────────────────────────────────────────
  const [previews, setPreviews] = useState<PreviewInfo[]>([]);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [previewPath, setPreviewPath] = useState<string>("/");
  const [previewDevice, setPreviewDevice] = useState<
    "desktop" | "tablet" | "mobile" | "responsive" | "figma"
  >("desktop");
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [isDevServerRunning, setIsDevServerRunning] = useState(false);
  const [isStartingServer, setIsStartingServer] = useState(false);

  // ── Project metadata ─────────────────────────────────────────────────
  const [backendType, setBackendType] = useState<BackendType>(
    initialBackendType ?? "platform",
  );
  const hasBackend = projectUsesConvex(backendType);

  // Fall back to Preview if Database tab is selected but no backend
  useEffect(() => {
    if (!hasBackend && currentView === "database") {
      setCurrentView("preview");
    }
  }, [hasBackend, currentView]);

  // Fetch project metadata (backendType) on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
        if (!res.ok) return;
        const proj = await res.json();
        if (!initialBackendType && typeof proj?.backendType === "string") {
          setBackendType(normalizeBackendType(proj.backendType));
        }
      } catch (e) {
        console.warn("Failed to load project metadata", e);
      }
    })();
  }, [initialBackendType, projectId]);

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/files`);
      if (!res.ok) return;
      const data = (await res.json()) as { files: Record<string, FileEntry> };
      setFiles(data.files ?? {});
    } catch (e) {
      console.warn("Failed to load files", e);
    }
  }, [projectId]);

  // Boot the sandbox: ensure session → seed if empty → load file tree.
  // Extracted so the retry button on the error banner can re-invoke it.
  const bootSandbox = useCallback(async () => {
    setSandboxStatus("booting");
    setBootError(null);
    try {
      const sessionRes = await fetch(`/api/projects/${projectId}/sandbox/session`, {
        method: "POST",
      });
      if (!sessionRes.ok) {
        const body = await sessionRes.text();
        throw new Error(body || `Failed to start sandbox (status ${sessionRes.status})`);
      }

      const seedRes = await fetch(`/api/projects/${projectId}/sandbox/seed`, {
        method: "POST",
      });
      if (seedRes.ok) {
        const { seeded, template } = (await seedRes.json()) as {
          seeded: boolean;
          template?: string;
        };
        if (seeded) {
          const label =
            template === "viteConvex"
              ? "the Vite + Convex starter"
              : template === "vite"
                ? "the Vite starter"
                : "the project starter";
          toast({ title: "Project initialized", description: `Seeded ${label}.` });
        }
      }

      await refreshFiles();
      setSandboxStatus("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start sandbox";
      setBootError(msg);
      setSandboxStatus("error");
      toast({ title: "Sandbox error", description: msg });
    }
  }, [projectId, refreshFiles, toast]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void bootSandbox();
  }, [bootSandbox]);

  // ── File actions ─────────────────────────────────────────────────────
  const isImageExtension = (filename: string) => {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(ext);
  };

  const handleFileSelect = useCallback(
    async (filePath: string) => {
      if (files[filePath]?.type !== "file") return;
      try {
        if (isImageExtension(filePath)) {
          // Image: fetch as binary and produce a blob URL for ImageViewer
          const res = await fetch(
            `/api/projects/${projectId}/sandbox/files?path=${encodeURIComponent(filePath)}`,
          );
          if (!res.ok) {
            toast({ title: "Failed to read image", description: await res.text() });
            return;
          }
          const data = (await res.json()) as { content: string; binary: boolean };
          if (!data.binary) return;
          const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const mime =
            ext === "svg" ? "image/svg+xml" : ext === "ico" ? "image/x-icon" : `image/${ext}`;
          const blob = new Blob([new Uint8Array(bytes)], { type: mime });
          if (imageBlobUrl) URL.revokeObjectURL(imageBlobUrl);
          setImageBlobUrl(URL.createObjectURL(blob));
          setImageByteLength(bytes.byteLength);
          setSelectedFile(filePath);
          setFileContent("");
          setHasUnsavedChanges(false);
          return;
        }

        const res = await fetch(
          `/api/projects/${projectId}/sandbox/files?path=${encodeURIComponent(filePath)}`,
        );
        if (!res.ok) {
          toast({ title: "Failed to read file", description: await res.text() });
          return;
        }
        const data = (await res.json()) as { content: string; binary: boolean };
        if (data.binary) {
          toast({ title: "Binary file", description: "Binary files cannot be edited here." });
          return;
        }
        if (imageBlobUrl) {
          URL.revokeObjectURL(imageBlobUrl);
          setImageBlobUrl(null);
        }
        setSelectedFile(filePath);
        setFileContent(data.content);
        setHasUnsavedChanges(false);
      } catch (e) {
        console.error("Failed to read file:", e);
      }
    },
    [projectId, files, toast, imageBlobUrl],
  );

  const handleContentChange = useCallback((next: string) => {
    setFileContent(next);
    setHasUnsavedChanges(true);
  }, []);

  const handleSaveFile = useCallback(async () => {
    if (!selectedFile) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      });
      if (!res.ok) throw new Error(await res.text());
      setHasUnsavedChanges(false);
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [projectId, selectedFile, fileContent, toast]);

  // Cmd/Ctrl+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (selectedFile && hasUnsavedChanges) handleSaveFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedFile, hasUnsavedChanges, handleSaveFile]);

  // ── Iframe postMessage → server browser log ──────────────────────────
  // The Vite template at `vite_convex_template/src/main.tsx` posts console
  // events, errors, and HMR events to `window.parent` with targetOrigin '*'.
  // We accept them only from *.vercel.run (the sandbox public domain),
  // buffer them in a ref, and flush via debounced POST to /browser-log so
  // the agent's `getBrowserLog` tool can read recent activity.
  const browserLogBufferRef = useRef<
    Array<{ timestamp: number; level: "log" | "warn" | "error"; message: string; type: "console" | "error" | "hmr" }>
  >([]);
  const browserLogFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const FLUSH_THRESHOLD = 50;
    const FLUSH_INTERVAL_MS = 500;

    function flush() {
      if (browserLogFlushTimerRef.current) {
        clearTimeout(browserLogFlushTimerRef.current);
        browserLogFlushTimerRef.current = null;
      }
      const batch = browserLogBufferRef.current.splice(0, browserLogBufferRef.current.length);
      if (batch.length === 0) return;
      fetch(`/api/projects/${projectId}/browser-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: batch }),
        keepalive: true,
      }).catch(() => { /* best-effort; the next batch will arrive shortly */ });
    }

    function schedule() {
      if (browserLogBufferRef.current.length >= FLUSH_THRESHOLD) {
        flush();
        return;
      }
      if (browserLogFlushTimerRef.current) return;
      browserLogFlushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
    }

    function handleMessage(event: MessageEvent) {
      // Only accept messages from the sandbox's own public domain. In dev the
      // origin will be sb-xxxx.vercel.run; if a project ever runs locally we
      // also accept localhost to ease testing.
      if (
        !event.origin.endsWith(".vercel.run") &&
        !event.origin.startsWith("http://localhost")
      ) return;

      const data = event.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== "object") return;
      const type = data.type;

      if (type === "IFRAME_CONSOLE") {
        const level = data.level === "warn" || data.level === "error" ? data.level : "log";
        const message = typeof data.message === "string" ? data.message : String(data.message ?? "");
        if (!message) return;
        browserLogBufferRef.current.push({
          timestamp: Date.now(),
          level,
          message,
          type: "console",
        });
        schedule();
      } else if (type === "IFRAME_ERROR") {
        const message = data.filename
          ? `${data.message} at ${data.filename}:${data.lineno}:${data.colno}`
          : String(data.message ?? "");
        if (!message) return;
        browserLogBufferRef.current.push({
          timestamp: Date.now(),
          level: "error",
          message,
          type: "error",
        });
        schedule();
      } else if (type === "VITE_HMR") {
        const evt = typeof data.event === "string" ? data.event : "";
        if (!evt) return;
        const err = typeof data.error === "string" ? data.error : undefined;
        browserLogBufferRef.current.push({
          timestamp: Date.now(),
          level: evt === "error" ? "error" : "log",
          message: err ? `${evt}: ${err}` : evt,
          type: "hmr",
        });
        schedule();
      }
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      // Final flush on unmount.
      flush();
    };
  }, [projectId]);

  // ── Preview refresh polling ──────────────────────────────────────────
  // The agent's `refreshPreview` tool bumps a Redis key on the server. We
  // poll for that timestamp every 2s while the preview tab is active and
  // bump previewReloadKey when it changes, which remounts the iframe.
  const lastRefreshAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (currentView !== "preview") return;
    if (sandboxStatus !== "ready") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/sandbox/preview-state`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { refreshAt: number | null };
        if (cancelled) return;
        const next = data.refreshAt;
        // First poll establishes the baseline; we only react to *changes*
        // after that, so a stale leftover signal from before the user
        // opened the workspace doesn't trigger an immediate reload.
        if (lastRefreshAtRef.current === null) {
          lastRefreshAtRef.current = next;
          return;
        }
        if (next && next !== lastRefreshAtRef.current) {
          lastRefreshAtRef.current = next;
          setPreviewReloadKey((k) => k + 1);
        }
      } catch {
        // Network blips are fine; we'll catch up on the next tick.
      }
    };

    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, currentView, sandboxStatus]);

  // ── Dev server ───────────────────────────────────────────────────────
  const handleStartDevServer = useCallback(async () => {
    if (isStartingServer) return;
    setIsStartingServer(true);
    try {
      // installFirst=true on every click is fine — pnpm short-circuits when
      // the lockfile is satisfied and node_modules already exist.
      const res = await fetch(`/api/projects/${projectId}/sandbox/devserver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: 5173, installFirst: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The route returns either { error, log } (timeout) or { error, stdout, stderr } (install fail)
        const detail = body.log
          ? `${body.error}\n\nLast log:\n${body.log}`
          : body.stderr
            ? `${body.error}\n\n${body.stderr}`
            : body.message || body.error || "Failed to start dev server";
        throw new Error(detail);
      }
      const { previewUrl, port, responseHeaders } = body as {
        previewUrl: string;
        port: number;
        responseHeaders?: Record<string, string>;
      };
      // Surface the proxy's response headers so we can diagnose iframe-blocking
      // directives (X-Frame-Options, CSP frame-ancestors, COEP/COOP, etc.) at
      // a glance. If the iframe shows "refused to connect", these tell us why.
      // Log each header on its own line so Chrome's console shows them flat
      // (logging the object alone makes it collapse to "Object").
      if (responseHeaders) {
        // eslint-disable-next-line no-console
        console.log("[botflow] === sandbox response headers ===");
        for (const [k, v] of Object.entries(responseHeaders)) {
          // eslint-disable-next-line no-console
          console.log(`  ${k}: ${v}`);
        }
        // eslint-disable-next-line no-console
        console.log("[botflow] === end headers ===");

        const blockers: string[] = [];
        if (responseHeaders["x-frame-options"]) {
          blockers.push(`X-Frame-Options: ${responseHeaders["x-frame-options"]}`);
        }
        const csp = responseHeaders["content-security-policy"];
        if (csp && csp.includes("frame-ancestors")) {
          blockers.push(`CSP frame-ancestors: ${csp}`);
        }
        if (blockers.length) {
          console.warn("[botflow] iframe-blocking headers detected:", blockers);
        }
      }
      setPreviews([{ port, ready: true, baseUrl: previewUrl }]);
      setActivePreviewIndex(0);
      setIsDevServerRunning(true);
      setPreviewReloadKey((k) => k + 1);
      setCurrentView("preview");
    } catch (err) {
      const description = err instanceof Error ? err.message : String(err);
      toast({ title: "Dev server failed to start", description: description.slice(0, 800) });
      console.error("Dev server start failed:", description);
    } finally {
      setIsStartingServer(false);
    }
  }, [projectId, isStartingServer, toast]);

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex bolt-bg text-fg">
      {/* Agent sidebar. Hold the initial prompt until the sandbox is ready —
          otherwise the agent fires its first turn against an empty filesystem
          while the seed is still cloning, and tools fail. */}
      <div className="w-96 flex flex-col bg-elevated/70 backdrop-blur-sm">
        <AgentPanel
          className="h-full"
          projectId={projectId}
          initialPrompt={sandboxStatus === "ready" ? initialPrompt : undefined}
          platform="sandboxed-web"
        />
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col">
        {bootError && (
          <div className="px-4 py-2 bg-red-900/80 border-b border-red-700 text-white text-xs flex items-center gap-3">
            <span className="font-semibold">Sandbox failed to start</span>
            <span className="opacity-80 flex-1 truncate">{bootError}</span>
            <button
              onClick={() => void bootSandbox()}
              className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-white text-xs font-medium"
            >
              Retry
            </button>
          </div>
        )}

        {/* Header */}
        <div className="h-12 flex items-center pr-2.5 gap-4 bg-surface backdrop-blur-sm">
          <Tabs
            options={
              [
                { value: "preview", text: "Preview" },
                { value: "code", text: "Code" },
                ...(hasBackend
                  ? [{ value: "database" as const, text: "Database" }]
                  : []),
              ] as TabOption<WorkspaceView>[]
            }
            selected={currentView}
            onSelect={setCurrentView}
          />

          <Button
            variant="ghost"
            size="sm"
            onClick={handleStartDevServer}
            disabled={isStartingServer || sandboxStatus !== "ready"}
            className={cn(
              "flex items-center gap-2 font-bold text-md",
              isDevServerRunning
                ? "text-green-400 hover:text-green-300 hover:bg-green-400/10"
                : "text-green-400 hover:text-green-300 hover:bg-green-400/10",
            )}
            title={isDevServerRunning ? "Restart dev server" : "Start dev server"}
          >
            {isStartingServer ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
            <span>
              {isStartingServer
                ? "Starting..."
                : isDevServerRunning
                  ? "Restart"
                  : "Start"}
            </span>
          </Button>

          {currentView === "code" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSidebar(!showSidebar)}
              className="text-muted hover:text-fg bolt-hover"
              title={showSidebar ? "Hide explorer" : "Show explorer"}
            >
              <PanelLeft size={16} />
            </Button>
          )}

          {currentView === "code" && selectedFile && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted">/</span>
              <span className="text-fg font-medium bg-elevated/70 px-2 py-1 rounded flex items-center gap-2">
                {selectedFile.split("/").pop()}
                {hasUnsavedChanges && (
                  <span
                    className="w-2 h-2 rounded-full bg-orange-500"
                    title="Unsaved changes"
                  />
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveFile}
                className="text-muted hover:text-fg bolt-hover"
                title="Save file"
              >
                <Save size={16} />
                <span className="ml-1">Save</span>
              </Button>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {currentView === "database" && hasBackend && (
              <button
                onClick={() => window.open(`/workspace/${projectId}/database`, "_blank")}
                className="flex items-center gap-1.5 text-sm text-muted hover:text-fg border border-border rounded-md px-3 py-1 bolt-hover"
                title="Open database in new tab"
              >
                <ArrowUpRight size={14} />
                Open in new tab
              </button>
            )}
            {currentView === "preview" && (
              <div className="flex items-center gap-2 border border-border rounded-full px-3 py-1 min-w-[220px]">
                <button
                  onClick={() =>
                    setPreviewDevice((prev) =>
                      prev === "desktop"
                        ? "tablet"
                        : prev === "tablet"
                          ? "mobile"
                          : prev === "mobile"
                            ? "responsive"
                            : prev === "responsive"
                              ? "figma"
                              : "desktop",
                    )
                  }
                  className="text-muted hover:text-fg"
                  title={`Device: ${previewDevice}`}
                >
                  {previewDevice === "desktop" && <Monitor size={16} />}
                  {previewDevice === "tablet" && <Tablet size={16} />}
                  {previewDevice === "mobile" && <Smartphone size={16} />}
                  {previewDevice === "responsive" && <AppWindow size={16} />}
                  {previewDevice === "figma" && <Frame size={16} />}
                </button>
                <span className="text-muted text-sm select-none">/</span>
                <input
                  className="flex-1 bg-transparent outline-none text-sm text-fg placeholder:text-muted"
                  value={previewPath}
                  onChange={(e) => setPreviewPath(e.target.value)}
                  placeholder="/"
                />
              </div>
            )}
            <UserButton />
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 min-h-0 relative bg-surface">
          {/* Code view */}
          <div
            className={cn(
              "absolute inset-0",
              currentView === "code" ? "flex flex-col" : "hidden",
              "rounded-xl border border-border overflow-hidden",
            )}
          >
            <div className="flex-1 min-h-0 flex">
              {showSidebar && (
                <div className="w-80 bolt-border border-r flex flex-col backdrop-blur-sm">
                  <div className="p-2 bolt-border border-b">
                    <Tabs
                      options={
                        [
                          { value: "files", text: "Files" },
                          { value: "search", text: "Search" },
                          { value: "env", text: "ENV" },
                        ] as TabOption<"files" | "search" | "env">[]
                      }
                      selected={sidebarTab}
                      onSelect={(v) => setSidebarTab(v as "files" | "search" | "env")}
                      stretch
                    />
                  </div>
                  <div className="flex-1 overflow-auto modern-scrollbar">
                    {sidebarTab === "files" ? (
                      <FileTree
                        files={files}
                        selectedFile={selectedFile}
                        onFileSelect={handleFileSelect}
                      />
                    ) : sidebarTab === "search" ? (
                      <FileSearch
                        projectId={projectId}
                        onOpenFile={(path) => {
                          setCurrentView("code");
                          handleFileSelect(path);
                        }}
                      />
                    ) : (
                      <EnvPanel projectId={projectId} />
                    )}
                  </div>
                </div>
              )}
              <div className="flex-1 min-h-0 relative">
                <div className="absolute inset-0 bg-elevated/90 backdrop-blur-sm">
                  {imageBlobUrl ? (
                    <ImageViewer
                      src={imageBlobUrl}
                      filename={selectedFile ?? ""}
                      byteLength={imageByteLength}
                    />
                  ) : (
                    <CodeEditor
                      value={fileContent}
                      onChange={handleContentChange}
                      language={getLanguageFromFilename(selectedFile || "")}
                      filename={selectedFile}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Terminal — always mounted, persists across tab switches.
                Wired to the sandbox via /api/projects/:id/sandbox/exec. */}
            <div className="h-64 bolt-border border-t bg-elevated backdrop-blur-sm">
              <PersistentTerminal projectId={projectId} ready={sandboxStatus === "ready"} />
            </div>
          </div>

          {/* Database view */}
          {currentView === "database" && hasBackend && (
            <div className="absolute inset-0 pb-2.5 pr-2.5">
              <div className="w-full h-full rounded-xl border border-border overflow-hidden">
                <ConvexDashboard projectId={projectId} />
              </div>
            </div>
          )}

          {/* Preview view */}
          <div
            className={cn(
              "absolute inset-0 pb-2.5 pr-2.5",
              currentView === "preview" ? "block" : "hidden",
            )}
          >
            <Preview
              previews={previews}
              activePreviewIndex={activePreviewIndex}
              onActivePreviewChange={setActivePreviewIndex}
              showHeader={false}
              currentPath={previewPath}
              selectedDevice={previewDevice}
              isLandscape={false}
              reloadKey={previewReloadKey}
              isDevServerRunning={isDevServerRunning}
              isInstalling={false}
              isStartingServer={isStartingServer}
              onToggleDevServer={handleStartDevServer}
              platform="sandboxed-web"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "javascript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    py: "python",
    rb: "ruby",
    php: "php",
    java: "java",
    cpp: "cpp",
    c: "c",
    go: "go",
    rs: "rust",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
  };
  return map[ext || ""] || "plaintext";
}
