"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import {
  Eye,
  Code2,
  Star,
  Loader2,
  Sparkles,
  RefreshCw,
  ExternalLink,
  ArrowLeft,
  Copy,
  Check,
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
            thumbnailUrl={project.htmlSnapshotUrl || project.thumbnailUrl}
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
  thumbnailUrl,
}: {
  bootState: "idle" | "mounting" | "installing" | "starting" | "ready" | "error";
  bootMessage: string;
  activePreview: PreviewInfo | undefined;
  reloadKey: number;
  onReload: () => void;
  thumbnailUrl: string | null;
}) {
  const isReady = bootState === "ready" && activePreview?.ready;
  const isError = bootState === "error";

  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      {/* Browser-chrome address bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
        </div>
        <button
          onClick={onReload}
          className="ml-2 inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-elevated text-muted hover:text-fg transition"
          title="Reload preview"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1 mx-2 rounded-md bg-elevated px-3 py-1 text-xs text-muted truncate">
          {activePreview?.baseUrl ?? "Starting preview…"}
        </div>
        {activePreview && (
          <a
            href={activePreview.baseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-elevated text-muted hover:text-fg transition"
            title="Open in new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      <div className="relative flex-1 bg-bg">
        {isReady && activePreview ? (
          <iframe
            key={reloadKey}
            src={activePreview.baseUrl}
            className="absolute inset-0 w-full h-full bg-white"
            sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-downloads"
            title="Public project preview"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            {/* background: blurred thumbnail if available */}
            {thumbnailUrl && !isError && (
              <img
                src={thumbnailUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover object-top opacity-30 blur-md scale-105"
              />
            )}
            <div className="relative z-10 max-w-md w-full text-center">
              <div className="inline-flex items-center justify-center h-14 w-14 rounded-full border border-border bg-surface shadow-sm mb-4">
                {isError ? (
                  <span className="text-red-500 text-2xl">!</span>
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-accent" />
                )}
              </div>
              <h3 className="text-lg font-semibold text-fg mb-1">
                {isError ? "Preview failed to start" : "Building preview…"}
              </h3>
              <p className="text-sm text-muted mb-4">{bootMessage}</p>
              {isError && (
                <button
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-elevated px-3.5 py-2 text-sm font-medium text-fg hover:bg-soft transition"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
              )}
              {!isError && (
                <div className="mx-auto h-1 w-48 overflow-hidden rounded-full bg-elevated">
                  <div className="h-full w-1/3 rounded-full bg-accent animate-[progress_2s_ease-in-out_infinite]" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
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
