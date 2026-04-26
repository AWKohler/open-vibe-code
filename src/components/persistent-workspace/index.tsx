"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useToast } from "@/components/ui/toast";
import { CodeEditor } from "@/components/workspace/code-editor";
import { UserButton } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import {
  PanelLeft,
  Save,
  Play,
  Square,
  Loader2,
  ArrowUpRight,
  ChevronRight,
  ChevronDown,
  FileIcon,
  FolderIcon,
  Terminal as TerminalIcon,
} from "lucide-react";

interface PersistentWorkspaceProps {
  projectId: string;
  initialPrompt?: string;
}

type FileEntry = { type: "file" | "folder" };
type SandboxStatus = "idle" | "booting" | "ready" | "error";

export function PersistentWorkspace({ projectId, initialPrompt: _initialPrompt }: PersistentWorkspaceProps) {
  const { toast } = useToast();

  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus>("idle");
  const [files, setFiles] = useState<Record<string, FileEntry>>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set([""]));
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDevServerRunning, setIsDevServerRunning] = useState(false);
  const [isStartingServer, setIsStartingServer] = useState(false);
  const [view, setView] = useState<"code" | "preview">("code");

  // Terminal
  const [terminalLines, setTerminalLines] = useState<{ stream: "stdout" | "stderr" | "info"; text: string }[]>([]);
  const [terminalInput, setTerminalInput] = useState("");
  const [isRunningCmd, setIsRunningCmd] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const appendTerminal = useCallback((stream: "stdout" | "stderr" | "info", text: string) => {
    setTerminalLines(prev => [...prev, { stream, text }]);
  }, []);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalLines]);

  // Boot sandbox on mount
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setSandboxStatus("booting");
      appendTerminal("info", "Starting persistent sandbox…");
      try {
        const sessionRes = await fetch(`/api/projects/${projectId}/sandbox/session`, { method: "POST" });
        if (!sessionRes.ok) throw new Error(await sessionRes.text());
        const session = await sessionRes.json() as { sandboxName: string; status: string };
        if (cancelled) return;
        appendTerminal("info", `Sandbox ready: ${session.sandboxName}`);

        // Seed if empty (first visit)
        appendTerminal("info", "Checking project files…");
        const seedRes = await fetch(`/api/projects/${projectId}/sandbox/seed`, { method: "POST" });
        if (seedRes.ok) {
          const { seeded } = await seedRes.json() as { seeded: boolean };
          if (seeded) appendTerminal("info", "Seeded starter template.");
        }

        // Load file tree
        await loadFiles();
        if (cancelled) return;
        setSandboxStatus("ready");
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to start sandbox";
        appendTerminal("stderr", msg);
        setSandboxStatus("error");
        toast({ title: "Sandbox error", description: msg });
      }
    }

    boot();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const loadFiles = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/sandbox/files`);
    if (!res.ok) return;
    const data = await res.json() as { files: Record<string, FileEntry> };
    setFiles(data.files);
  }, [projectId]);

  const handleFileSelect = useCallback(async (path: string, entry: FileEntry) => {
    if (entry.type === "folder") {
      setExpandedFolders(prev => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      return;
    }

    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const data = await res.json() as { content: string; binary: boolean };
      if (!data.binary) {
        setSelectedFile(path);
        setFileContent(data.content);
        setHasUnsavedChanges(false);
      } else {
        toast({ title: "Binary file", description: "Binary files cannot be edited in the browser." });
      }
    } catch (e) {
      console.error("Failed to read file", e);
    }
  }, [projectId, toast]);

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
      toast({ title: "File saved" });
    } catch (err) {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : "Unknown error" });
    }
  }, [projectId, selectedFile, fileContent, toast]);

  const runCommand = useCallback(async (cmd: string, args: string[] = [], cwd?: string) => {
    setIsRunningCmd(true);
    setShowTerminal(true);
    appendTerminal("info", `$ ${cmd} ${args.join(" ")}`);

    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, args, cwd }),
      });

      if (!res.body) throw new Error("No response stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let event = "stdout";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) {
              try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
            }
          }
          if (data) appendTerminal(event as "stdout" | "stderr", data);
        }
      }
    } catch (err) {
      appendTerminal("stderr", err instanceof Error ? err.message : "Command failed");
    } finally {
      setIsRunningCmd(false);
    }
  }, [projectId, appendTerminal]);

  const handleTerminalSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const input = terminalInput.trim();
    if (!input || isRunningCmd) return;
    setTerminalInput("");
    const parts = input.split(" ");
    await runCommand(parts[0]!, parts.slice(1));
  }, [terminalInput, isRunningCmd, runCommand]);

  const startDevServer = useCallback(async () => {
    setIsStartingServer(true);
    appendTerminal("info", "Starting dev server…");
    setShowTerminal(true);
    try {
      // Install first if no node_modules
      const checkRes = await fetch(`/api/projects/${projectId}/sandbox/devserver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installFirst: true }),
      });
      if (!checkRes.ok) {
        const err = await checkRes.json() as { error: string };
        throw new Error(err.error);
      }
      const { previewUrl: url } = await checkRes.json() as { previewUrl: string };
      setPreviewUrl(url);
      setIsDevServerRunning(true);
      setView("preview");
      appendTerminal("info", `Dev server running at ${url}`);
      toast({ title: "Dev server started", description: url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start dev server";
      appendTerminal("stderr", msg);
      toast({ title: "Dev server failed", description: msg });
    } finally {
      setIsStartingServer(false);
    }
  }, [projectId, appendTerminal, toast]);

  // Build a simple sorted file tree
  const sortedPaths = Object.keys(files).sort((a, b) => {
    const aIsFolder = files[a]?.type === "folder";
    const bIsFolder = files[b]?.type === "folder";
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    return a.localeCompare(b);
  });

  // Only show direct children of a given parent
  const getChildren = (parent: string) => {
    return sortedPaths.filter(p => {
      const rel = parent ? p.slice(parent.length + 1) : p.slice(1);
      return p.startsWith(parent ? parent + "/" : "/") && !rel.slice(1).includes("/") && rel !== "";
    });
  };

  const renderTree = (parent = "") => {
    const children = parent === "" ? getChildren("") : getChildren(parent);
    return children.map(path => {
      const name = path.split("/").pop() ?? path;
      const entry = files[path]!;
      const isExpanded = expandedFolders.has(path);
      return (
        <div key={path}>
          <button
            onClick={() => handleFileSelect(path, entry)}
            className={cn(
              "w-full flex items-center gap-1.5 px-2 py-0.5 text-xs rounded hover:bg-[var(--sand-soft)] transition text-left",
              selectedFile === path && "bg-[var(--sand-soft)] font-medium",
            )}
            style={{ paddingLeft: `${(path.split("/").length - 1) * 12 + 8}px` }}
          >
            {entry.type === "folder" ? (
              isExpanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted" />
            ) : null}
            {entry.type === "folder"
              ? <FolderIcon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              : <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--sand-text-muted)]" />}
            <span className="truncate">{name}</span>
          </button>
          {entry.type === "folder" && isExpanded && renderTree(path)}
        </div>
      );
    });
  };

  return (
    <div className="flex flex-col h-screen bg-[var(--sand-bg)] text-[var(--sand-text)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border bg-[var(--sand-elevated)] shrink-0">
        <button
          onClick={() => setShowSidebar(v => !v)}
          className="p-1 rounded hover:bg-[var(--sand-soft)] transition"
          title="Toggle sidebar"
        >
          <PanelLeft className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-1 text-xs border border-border rounded-md overflow-hidden">
          <button
            onClick={() => setView("code")}
            className={cn("px-2.5 py-1 transition", view === "code" ? "bg-[var(--sand-soft)] font-medium" : "hover:bg-[var(--sand-soft)]")}
          >Code</button>
          <button
            onClick={() => setView("preview")}
            className={cn("px-2.5 py-1 transition", view === "preview" ? "bg-[var(--sand-soft)] font-medium" : "hover:bg-[var(--sand-soft)]")}
          >Preview</button>
        </div>

        <div className="flex items-center gap-1 ml-auto">
          {sandboxStatus === "booting" && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> Booting…
            </span>
          )}

          {sandboxStatus === "ready" && !isDevServerRunning && (
            <button
              onClick={startDevServer}
              disabled={isStartingServer}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-[var(--sand-accent)] text-[var(--sand-accent-foreground)] hover:opacity-90 transition disabled:opacity-50"
            >
              {isStartingServer ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run
            </button>
          )}

          {isDevServerRunning && (
            <>
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Live
              </span>
              {previewUrl && (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-muted hover:text-[var(--sand-text)] transition"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              )}
              <button
                onClick={() => { setIsDevServerRunning(false); setPreviewUrl(null); }}
                className="p-1 rounded hover:bg-[var(--sand-soft)] transition"
                title="Stop"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            </>
          )}

          {hasUnsavedChanges && (
            <button
              onClick={handleSaveFile}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border hover:bg-[var(--sand-soft)] transition"
            >
              <Save className="h-3 w-3" /> Save
            </button>
          )}

          <button
            onClick={() => setShowTerminal(v => !v)}
            className={cn("p-1 rounded hover:bg-[var(--sand-soft)] transition", showTerminal && "bg-[var(--sand-soft)]")}
            title="Terminal"
          >
            <TerminalIcon className="h-4 w-4" />
          </button>

          <div className="ml-1">
            <UserButton />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {showSidebar && (
          <div className="w-52 shrink-0 border-r border-border bg-[var(--sand-elevated)] overflow-y-auto flex flex-col">
            <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted border-b border-border">
              Files
            </div>
            <div className="flex-1 py-1 overflow-y-auto">
              {sandboxStatus === "booting" ? (
                <div className="flex items-center justify-center py-8 text-muted text-xs">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (
                renderTree()
              )}
            </div>
            <div className="border-t border-border p-2">
              <button
                onClick={loadFiles}
                className="w-full text-xs text-muted hover:text-[var(--sand-text)] transition py-1"
              >
                Refresh files
              </button>
            </div>
          </div>
        )}

        {/* Main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {view === "code" ? (
            <div className="flex-1 overflow-hidden">
              {selectedFile ? (
                <CodeEditor
                  key={selectedFile}
                  value={fileContent}
                  onChange={(v) => {
                    setFileContent(v);
                    setHasUnsavedChanges(v !== fileContent);
                  }}
                  language={inferLanguage(selectedFile)}
                  path={selectedFile}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted text-sm">
                  Select a file to edit
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-hidden">
              {previewUrl ? (
                <iframe
                  src={previewUrl}
                  className="w-full h-full border-0"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted text-sm gap-3">
                  <p>No preview running</p>
                  <button
                    onClick={startDevServer}
                    disabled={isStartingServer || sandboxStatus !== "ready"}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-[var(--sand-accent)] text-[var(--sand-accent-foreground)] hover:opacity-90 transition disabled:opacity-50"
                  >
                    {isStartingServer ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Start dev server
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Terminal panel */}
          {showTerminal && (
            <div className="h-48 border-t border-border bg-black flex flex-col shrink-0">
              <div className="flex items-center justify-between px-3 py-1 border-b border-white/10 text-xs text-white/60">
                <span>Terminal</span>
                <button onClick={() => setShowTerminal(false)} className="hover:text-white transition">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
                {terminalLines.map((line, i) => (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap leading-5",
                      line.stream === "stderr" ? "text-red-400" : line.stream === "info" ? "text-blue-400" : "text-white/90",
                    )}
                  >
                    {line.text}
                  </div>
                ))}
                <div ref={terminalEndRef} />
              </div>
              <form onSubmit={handleTerminalSubmit} className="flex items-center border-t border-white/10 px-3 py-1.5">
                <span className="text-white/40 text-xs mr-2 font-mono">$</span>
                <input
                  value={terminalInput}
                  onChange={e => setTerminalInput(e.target.value)}
                  disabled={isRunningCmd || sandboxStatus !== "ready"}
                  placeholder="Enter command…"
                  className="flex-1 bg-transparent text-white/90 text-xs font-mono outline-none placeholder:text-white/30"
                />
                {isRunningCmd && <Loader2 className="h-3 w-3 animate-spin text-white/40" />}
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", css: "css", html: "html", md: "markdown", yaml: "yaml",
    yml: "yaml", toml: "toml", sh: "shell", py: "python", rs: "rust",
    go: "go", sql: "sql", graphql: "graphql",
  };
  return map[ext] ?? "plaintext";
}
