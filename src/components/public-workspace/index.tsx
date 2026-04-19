"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { checkDeviceSupport } from "@/lib/device";
import {
  Eye,
  Code2,
  Star,
  Monitor,
  Loader2,
  Sparkles,
  RefreshCw,
  ExternalLink,
  ArrowLeft,
  Copy,
  Check,
  Play,
} from "lucide-react";
import { WebContainerManager } from "@/lib/webcontainer";
import { DevServerManager } from "@/lib/dev-server";
import { getPreviewStore, type PreviewInfo } from "@/lib/preview-store";
import { CodeEditor } from "@/components/workspace/code-editor";
import { FileTree } from "@/components/workspace/file-tree";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type PublicFile =
  | { path: string; type: "file"; content: string; hash: string }
  | { path: string; type: "asset"; url: string; hash: string };

export interface PublicProjectData {
  project: {
    id: string;
    name: string;
    platform: "web" | "mobile" | "multiplatform";
    publicSlug: string;
    publicDescription: string | null;
    thumbnailUrl: string | null;
    htmlSnapshotUrl: string | null;
    starCount: number;
    publishedAt: string | null;
    createdAt: string;
    author: { name: string; imageUrl: string | null };
    hasStarred: boolean;
    isOwner: boolean;
  };
  files: PublicFile[];
}

interface PublicWorkspaceProps {
  data: PublicProjectData;
  isSignedIn: boolean;
}

type Tab = "preview" | "code";

function buildFileTree(files: PublicFile[]): Record<string, { type: "file" | "folder" }> {
  const tree: Record<string, { type: "file" | "folder" }> = {};
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    // folders
    for (let i = 1; i < parts.length; i++) {
      const folder = "/" + parts.slice(0, i).join("/");
      tree[folder] = { type: "folder" };
    }
    tree[f.path] = { type: "file" };
  }
  return tree;
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
    json: "json", md: "markdown", html: "html", css: "css", scss: "scss",
    py: "python", rb: "ruby", php: "php", java: "java", cpp: "cpp", c: "c",
    go: "go", rs: "rust", sh: "shell", yml: "yaml", yaml: "yaml", xml: "xml", sql: "sql",
  };
  return map[ext || ""] || "plaintext";
}

export function PublicWorkspace({ data, isSignedIn }: PublicWorkspaceProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { project, files } = data;

  const [tab, setTab] = useState<Tab>("preview");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [bootState, setBootState] = useState<"idle" | "mounting" | "installing" | "starting" | "ready" | "error">("idle");
  const [bootMessage, setBootMessage] = useState<string>("Preparing preview…");
  const [previews, setPreviews] = useState<PreviewInfo[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [stars, setStars] = useState(project.starCount);
  const [hasStarred, setHasStarred] = useState(project.hasStarred);
  const [starring, setStarring] = useState(false);
  const [forking, setForking] = useState(false);
  const [copied, setCopied] = useState(false);

  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const textFileMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of files) {
      if (f.type === "file") map[f.path] = f.content;
    }
    return map;
  }, [files]);

  const bootedRef = useRef(false);

  // Boot the WebContainer and run dev server
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    let cancelled = false;
    const store = getPreviewStore();
    const unsubscribe = store.subscribe((p) => {
      if (!cancelled) setPreviews(p);
    });

    (async () => {
      try {
        setBootState("mounting");
        setBootMessage("Booting preview sandbox…");
        const container = await WebContainerManager.getInstance();
        store.setWebContainer(container);

        if (cancelled) return;

        setBootMessage("Writing project files…");
        // Wipe any pre-existing files from a prior project in the same tab
        // (e.g. user navigated from their own /workspace into a public /p view).
        // Public view is read-only and never writes to IndexedDB, so this is safe.
        try {
          const entries = await container.fs.readdir("/", { withFileTypes: true });
          for (const entry of entries) {
            const p = `/${entry.name}`;
            try {
              await container.fs.rm(p, { recursive: true, force: true });
            } catch {}
          }
        } catch {}
        // Create folders first
        const folderSet = new Set<string>();
        for (const f of files) {
          const parts = f.path.split("/").filter(Boolean);
          for (let i = 1; i < parts.length; i++) {
            folderSet.add("/" + parts.slice(0, i).join("/"));
          }
        }
        for (const folder of folderSet) {
          try {
            await container.fs.mkdir(folder, { recursive: true });
          } catch {}
        }
        // Write files
        for (const f of files) {
          try {
            if (f.type === "file") {
              await container.fs.writeFile(f.path, f.content);
            } else {
              const res = await fetch(f.url);
              const buf = new Uint8Array(await res.arrayBuffer());
              await container.fs.writeFile(f.path, buf);
            }
          } catch (err) {
            console.warn(`Failed writing ${f.path}`, err);
          }
        }

        if (cancelled) return;
        setBootState("installing");
        setBootMessage("Installing dependencies (this usually takes ~30s)…");

        // Start the dev server — this does pnpm install automatically
        setBootState("starting");
        setBootMessage("Starting dev server…");
        const result = await DevServerManager.start();
        if (!result.ok) {
          throw new Error(result.message);
        }
        if (!cancelled) {
          setBootState("ready");
          setBootMessage("Preview ready");
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setBootState("error");
          setBootMessage(err instanceof Error ? err.message : "Failed to load preview");
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [files]);

  const activePreview = previews.find((p) => p.ready) ?? previews[0];

  // Auto-select an interesting file for the code tab
  useEffect(() => {
    if (selectedFile) return;
    const preferred = ["/src/App.tsx", "/src/app.tsx", "/app/_layout.tsx", "/src/App.jsx", "/src/main.tsx", "/src/index.ts", "/src/index.tsx", "/package.json"];
    for (const p of preferred) {
      if (textFileMap[p]) {
        setSelectedFile(p);
        return;
      }
    }
    // fallback: first text file
    const firstText = files.find((f) => f.type === "file");
    if (firstText) setSelectedFile(firstText.path);
  }, [files, selectedFile, textFileMap]);

  const handleStar = useCallback(async () => {
    if (!isSignedIn) {
      router.push(`/sign-in?redirect_url=${encodeURIComponent(`/p/${project.publicSlug}`)}`);
      return;
    }
    if (starring) return;
    setStarring(true);
    // Optimistic
    const prev = { stars, hasStarred };
    setHasStarred(!hasStarred);
    setStars(hasStarred ? Math.max(stars - 1, 0) : stars + 1);
    try {
      const res = await fetch(`/api/public/projects/${project.publicSlug}/star`, { method: "POST" });
      if (!res.ok) throw new Error("Failed");
      const body = await res.json();
      setHasStarred(Boolean(body.starred));
      setStars(body.starCount ?? 0);
    } catch (err) {
      setStars(prev.stars);
      setHasStarred(prev.hasStarred);
      toast({ title: "Could not update star", description: err instanceof Error ? err.message : undefined });
    } finally {
      setStarring(false);
    }
  }, [isSignedIn, router, project.publicSlug, starring, stars, hasStarred, toast]);

  const handleFork = useCallback(async () => {
    if (!isSignedIn) {
      router.push(`/sign-in?redirect_url=${encodeURIComponent(`/p/${project.publicSlug}?fork=1`)}`);
      return;
    }
    if (forking) return;
    setForking(true);
    try {
      const res = await fetch(`/api/public/projects/${project.publicSlug}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to fork");
      }
      const { projectId } = await res.json();
      router.push(`/workspace/${projectId}`);
    } catch (err) {
      toast({ title: "Could not use as template", description: err instanceof Error ? err.message : undefined });
      setForking(false);
    }
  }, [isSignedIn, router, project.publicSlug, forking, toast]);

  // Auto-fork flag: ?fork=1 — used when user signs in on a forked flow
  useEffect(() => {
    if (!isSignedIn) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("fork") === "1") {
      url.searchParams.delete("fork");
      window.history.replaceState({}, "", url.toString());
      handleFork();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ title: "Could not copy link" });
    }
  }, [toast]);

  return (
    <div className="antialiased text-fg bg-bg min-h-screen flex flex-col">
      {/* Header */}
      <header className="relative z-30 border-b border-border bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 py-3">
          <div className="flex items-center gap-3">
            <Link href="/explore" className="hidden md:inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted hover:text-fg hover:bg-elevated transition">
              <ArrowLeft className="h-4 w-4" />
              Explore
            </Link>

            <div className="flex items-center gap-3 min-w-0 flex-1">
              {project.author.imageUrl ? (
                <img src={project.author.imageUrl} alt="" className="h-8 w-8 rounded-full border border-border shrink-0" />
              ) : (
                <div className="h-8 w-8 rounded-full bg-elevated border border-border shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <h1 className="font-semibold text-fg truncate" title={project.name}>{project.name}</h1>
                  <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted shrink-0">
                    {project.platform === "web" ? "Web" : project.platform === "mobile" ? "Mobile" : "Universal"}
                  </span>
                </div>
                <p className="text-xs text-muted truncate">by {project.author.name}</p>
              </div>
            </div>

            {/* Tab switcher */}
            <div className="inline-flex items-center rounded-xl border border-border bg-bg p-0.5 shadow-sm">
              <button
                onClick={() => setTab("preview")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  tab === "preview" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                )}
              >
                <Eye className="h-4 w-4" />
                Preview
              </button>
              <button
                onClick={() => setTab("code")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  tab === "code" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                )}
              >
                <Code2 className="h-4 w-4" />
                Code
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleStar}
                disabled={starring}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-medium transition",
                  hasStarred
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-border bg-elevated text-fg hover:bg-soft"
                )}
                title={hasStarred ? "Unstar" : "Star"}
              >
                <Star className={cn("h-4 w-4", hasStarred && "fill-current")} />
                <span className="tabular-nums">{stars}</span>
              </button>

              <button
                onClick={handleCopyLink}
                className="hidden sm:inline-flex items-center justify-center rounded-xl border border-border bg-elevated h-[34px] w-[34px] text-fg hover:bg-soft transition"
                title="Copy share link"
                aria-label="Copy share link"
              >
                {copied ? <Check className="h-4 w-4 text-accent" /> : <Copy className="h-4 w-4" />}
              </button>

              <button
                onClick={handleFork}
                disabled={forking}
                className="inline-flex items-center gap-1.5 rounded-xl bg-fg px-3.5 py-1.5 text-sm font-medium text-bg shadow-md hover:opacity-90 disabled:opacity-60 transition"
              >
                {forking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Use as template
              </button>

              <SignedOut>
                <SignInButton>
                  <button className="hidden md:inline-flex items-center rounded-xl border border-border bg-elevated px-3 py-1.5 text-sm font-medium text-fg hover:bg-soft transition">
                    Log in
                  </button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <UserButton afterSignOutUrl="/" />
              </SignedIn>
            </div>
          </div>

          {project.publicDescription && (
            <p className="mt-2 pl-11 text-sm text-muted line-clamp-2">{project.publicDescription}</p>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 relative overflow-hidden">
        {tab === "preview" ? (
          <PreviewPane
            bootState={bootState}
            bootMessage={bootMessage}
            activePreview={activePreview}
            reloadKey={reloadKey}
            onReload={() => setReloadKey((k) => k + 1)}
            htmlSnapshotUrl={project.htmlSnapshotUrl}
            thumbnailUrl={project.thumbnailUrl}
          />
        ) : (
          <CodePane
            files={fileTree}
            selectedFile={selectedFile}
            onFileSelect={setSelectedFile}
            content={selectedFile ? textFileMap[selectedFile] ?? "" : ""}
          />
        )}
      </main>
    </div>
  );
}

function PreviewPane({
  bootState,
  bootMessage,
  activePreview,
  reloadKey,
  onReload,
  htmlSnapshotUrl,
  thumbnailUrl,
}: {
  bootState: "idle" | "mounting" | "installing" | "starting" | "ready" | "error";
  bootMessage: string;
  activePreview: PreviewInfo | undefined;
  reloadKey: number;
  onReload: () => void;
  htmlSnapshotUrl: string | null;
  thumbnailUrl: string | null;
}) {
  const isReady = bootState === "ready" && activePreview?.ready;
  const isBooting = bootState !== "ready" && bootState !== "error" && bootState !== "idle";
  const isError = bootState === "error";

  const [snapshotHtml, setSnapshotHtml] = useState<string | null>(null);
  const [internalPath, setInternalPath] = useState("/");
  const [iframeUrl, setIframeUrl] = useState("");

  // Fetch HTML snapshot for placeholder background
  useEffect(() => {
    if (!htmlSnapshotUrl) return;
    fetch(htmlSnapshotUrl)
      .then((r) => r.text())
      .then(setSnapshotHtml)
      .catch(() => {});
  }, [htmlSnapshotUrl]);

  // Sync iframe URL when preview becomes ready or path changes
  useEffect(() => {
    if (activePreview?.baseUrl) {
      setIframeUrl(activePreview.baseUrl + (internalPath || "/"));
    }
  }, [activePreview, internalPath]);

  const handlePathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const raw = (e.target as HTMLInputElement).value;
      const normalized = raw.startsWith("/") ? raw : "/" + raw;
      setInternalPath(normalized);
      if (activePreview?.baseUrl) {
        setIframeUrl(activePreview.baseUrl + normalized);
      }
    }
  };

  const openInNewTab = () => {
    if (activePreview?.baseUrl) {
      const url = activePreview.baseUrl + (internalPath || "/");
      window.open(`/preview-popup?url=${encodeURIComponent(url)}`, "_blank");
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      {/* Browser-chrome address bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface">
        <button
          onClick={onReload}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-elevated text-muted hover:text-fg transition"
          title="Reload preview"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>

        {/* URL bar: hides raw webcontainer domain, shows editable path */}
        <div className="flex-1 mx-1 flex items-center gap-0 rounded-md bg-elevated border border-border px-3 py-1 text-xs">
          <span className="text-muted select-none shrink-0">localhost</span>
          <input
            type="text"
            value={internalPath}
            onChange={(e) => setInternalPath(e.target.value)}
            onKeyDown={handlePathKeyDown}
            placeholder="/"
            className="flex-1 bg-transparent text-fg outline-none min-w-0"
          />
        </div>

        <button
          onClick={openInNewTab}
          disabled={!activePreview}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-elevated text-muted hover:text-fg disabled:opacity-40 transition"
          title="Open in new tab"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="relative flex-1 bg-bg overflow-hidden">
        {/* Live preview iframe — always mounted once ready so it doesn't remount on tab switch */}
        {isReady && activePreview && (
          <iframe
            key={reloadKey}
            src={iframeUrl || activePreview.baseUrl}
            className="absolute inset-0 w-full h-full bg-white"
            sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-downloads"
            title="Public project preview"
          />
        )}

        {/* Snapshot placeholder + overlay while not yet ready */}
        {!isReady && (
          <div className="absolute inset-0">
            {/* Background: HTML snapshot iframe or thumbnail image */}
            {snapshotHtml ? (
              <iframe
                srcDoc={snapshotHtml}
                className="w-full h-full border-none pointer-events-none"
                sandbox="allow-scripts allow-same-origin"
                title="Preview snapshot"
              />
            ) : thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt=""
                className="w-full h-full object-cover object-top"
              />
            ) : null}

            {/* Blur overlay */}
            <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex flex-col items-center justify-center gap-4">
              <button
                disabled
                className="flex items-center justify-center w-24 h-24 rounded-full bg-white/90 shadow-2xl"
              >
                {isBooting ? (
                  <span className="inline-flex h-10 w-10 rounded-full border-4 border-green-600 border-t-transparent animate-spin" />
                ) : isError ? (
                  <span className="text-red-500 text-3xl font-bold">!</span>
                ) : (
                  <Play size={40} className="text-green-600 fill-green-600 ml-1" />
                )}
              </button>
              <p className="text-white text-sm font-medium drop-shadow-lg max-w-xs text-center">
                {isError ? bootMessage : isBooting ? bootMessage : "Loading…"}
              </p>
              {isError && (
                <button
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/30 bg-white/10 px-3.5 py-2 text-sm font-medium text-white hover:bg-white/20 transition"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PublicWorkspaceGuard({ data, isSignedIn }: PublicWorkspaceProps) {
  const [deviceBlocked, setDeviceBlocked] = useState<string | null>(null);

  useEffect(() => {
    const result = checkDeviceSupport();
    if (!result.supported) setDeviceBlocked(result.reason ?? "Your device is not supported.");
  }, []);

  if (deviceBlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg text-fg px-4">
        <div className="max-w-md text-center space-y-5 p-8 rounded-2xl border border-border bg-surface shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-elevated">
            <Monitor className="h-7 w-7 text-muted" />
          </div>
          <h1 className="text-2xl font-semibold">Desktop required</h1>
          <p className="text-sm text-muted leading-relaxed">{deviceBlocked}</p>
          <p className="text-xs text-muted opacity-60">
            Botflow uses WebContainer technology that requires a desktop browser to run full development environments.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2">
            <Link
              href="/explore"
              className="inline-flex items-center rounded-xl bg-fg px-4 py-2 text-sm font-medium text-bg shadow hover:opacity-90 transition"
            >
              Browse public projects
            </Link>
            <Link
              href="/"
              className="inline-flex items-center rounded-xl border border-border bg-elevated px-4 py-2 text-sm font-medium text-fg hover:bg-soft transition"
            >
              Back home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <PublicWorkspace data={data} isSignedIn={isSignedIn} />;
}

function CodePane({
  files,
  selectedFile,
  onFileSelect,
  content,
}: {
  files: Record<string, { type: "file" | "folder" }>;
  selectedFile: string | null;
  onFileSelect: (path: string) => void;
  content: string;
}) {
  return (
    <div className="absolute inset-0 flex bg-bg">
      <aside className="w-64 shrink-0 border-r border-border bg-surface flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[11px] uppercase tracking-wide font-medium text-muted">Files</div>
        </div>
        <div className="flex-1 overflow-y-auto modern-scrollbar">
          <FileTree files={files} selectedFile={selectedFile} onFileSelect={onFileSelect} />
        </div>
      </aside>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface">
          <div className="text-sm text-muted">{selectedFile ?? "No file selected"}</div>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            Read-only
          </span>
        </div>
        <div className="flex-1 min-h-0">
          {selectedFile ? (
            <CodeEditor
              value={content}
              onChange={() => {}}
              language={getLanguageFromFilename(selectedFile)}
              filename={selectedFile}
              disabled
            />
          ) : (
            <div className="h-full flex items-center justify-center text-muted text-sm">
              Select a file to view
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
