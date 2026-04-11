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
  Lock,
  ChevronDown,
  ChevronUp,
  LinkIcon,
  X,
} from "lucide-react";

type PublishState = "idle" | "building" | "published" | "error";
type DomainStatus = "pending" | "active" | "error" | null;

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
  customDomain: string | null;
  customDomainStatus: DomainStatus;
  onCustomDomainChanged: (domain: string | null, status: DomainStatus) => void;
  canUseCustomDomain: boolean;
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
        const bytes = await container.fs.readFile(fullPath);
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

// ─── Domain section sub-components ───────────────────────────────────────────

function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [value]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors",
        "text-muted hover:text-foreground hover:bg-soft",
        className
      )}
    >
      {copied ? (
        <Check size={10} className="text-green-500" />
      ) : (
        <Copy size={10} />
      )}
      {copied ? "Copied" : label}
    </button>
  );
}

function DnsRecordCard({
  domain,
  cnameTarget,
}: {
  domain: string;
  cnameTarget: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg overflow-hidden text-[11px]">
      <div className="px-3 py-1.5 bg-soft/50 border-b border-border">
        <span className="font-medium text-muted uppercase tracking-wide text-[9px]">DNS Record</span>
      </div>
      <div className="divide-y divide-border/60">
        <div className="flex items-center px-3 py-2 gap-2">
          <span className="w-10 text-muted shrink-0">Type</span>
          <span className="font-mono font-semibold text-foreground">CNAME</span>
        </div>
        <div className="flex items-center px-3 py-2 gap-2">
          <span className="w-10 text-muted shrink-0">Name</span>
          <span className="font-mono text-foreground flex-1 truncate">{domain}</span>
          <CopyButton value={domain} />
        </div>
        <div className="flex items-center px-3 py-2 gap-2">
          <span className="w-10 text-muted shrink-0">Value</span>
          <span className="font-mono text-foreground flex-1 truncate">{cnameTarget}</span>
          <CopyButton value={cnameTarget} />
        </div>
        <div className="flex items-center px-3 py-2 gap-2">
          <span className="w-10 text-muted shrink-0">TTL</span>
          <span className="font-mono text-foreground">Auto</span>
        </div>
      </div>
    </div>
  );
}

function RedirectInstructions({ apex, www }: { apex: string; www: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-bg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-soft/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ArrowRightIcon className="w-3 h-3 text-muted shrink-0" />
          <span className="text-[11px] font-medium">
            Also redirect <span className="font-mono">{apex}</span> → <span className="font-mono">{www}</span>
          </span>
        </div>
        {open ? (
          <ChevronUp size={12} className="text-muted shrink-0" />
        ) : (
          <ChevronDown size={12} className="text-muted shrink-0" />
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 text-[11px] text-muted leading-relaxed border-t border-border/60 pt-2.5 space-y-2">
          <p>
            So visitors going to <span className="font-mono text-foreground">{apex}</span> are
            redirected to your site, add a <strong className="text-foreground">URL Forward</strong>{" "}
            or <strong className="text-foreground">URL Redirect</strong> at your registrar:
          </p>
          <div className="rounded border border-border bg-soft/40 px-3 py-2 font-mono text-[10px] space-y-1">
            <div>
              <span className="text-muted">From: </span>
              <span className="text-foreground">{apex}</span>
            </div>
            <div>
              <span className="text-muted">To: </span>
              <span className="text-foreground">https://{www}</span>
            </div>
            <div>
              <span className="text-muted">Type: </span>
              <span className="text-foreground">301 Permanent</span>
            </div>
          </div>
          <p className="text-[10px]">
            Look for &ldquo;URL Forwarding&rdquo;, &ldquo;URL Redirect&rdquo;, or &ldquo;Domain Forwarding&rdquo; in
            your registrar&apos;s DNS settings. Every major registrar (Namecheap,
            GoDaddy, Squarespace, Google, Cloudflare) supports this.
          </p>
        </div>
      )}
    </div>
  );
}

// Inline arrow-right icon to avoid importing another icon
function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

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
  customDomain,
  customDomainStatus,
  onCustomDomainChanged,
  canUseCustomDomain,
  platform = "web",
}: PublishPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ top: 0, right: 0 });

  // ── Publish state ────────────────────────────────────────────────────────
  const [state, setState] = useState<PublishState>(
    cloudflareDeploymentUrl ? "published" : "idle"
  );
  const [statusText, setStatusText] = useState("");
  const [errorOutput, setErrorOutput] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  // ── Custom domain state ──────────────────────────────────────────────────
  const [domainInput, setDomainInput] = useState("");
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainError, setDomainError] = useState("");
  const [domainCopied, setDomainCopied] = useState(false);
  const [confirmRemoveDomain, setConfirmRemoveDomain] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Apex domain for redirect instructions (derived from www.domain)
  const domainApex = customDomain?.startsWith("www.")
    ? customDomain.slice(4)
    : null;

  // CNAME target: the pages.dev URL
  const cnameTarget = cloudflareProjectName
    ? `${cloudflareProjectName}.pages.dev`
    : null;

  // ── Sync publish state with props ────────────────────────────────────────
  useEffect(() => {
    if (cloudflareDeploymentUrl) {
      setState("published");
    } else if (state === "published") {
      setState("idle");
    }
  }, [cloudflareDeploymentUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Position panel from anchor ───────────────────────────────────────────
  useEffect(() => {
    if (isOpen && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setCoords({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      });
    }
  }, [isOpen, anchorRef]);

  // ── Close on outside click ───────────────────────────────────────────────
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

  // ── Close on Escape ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // ── Domain status polling ────────────────────────────────────────────────
  useEffect(() => {
    if (customDomainStatus !== "pending" || !isOpen) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/custom-domain`);
        if (!res.ok) return;
        const data = await res.json() as { domain: string | null; status: DomainStatus; apex: string | null };
        if (data.status && data.status !== customDomainStatus) {
          onCustomDomainChanged(data.domain, data.status);
        }
      } catch {
        // silent
      }
    };

    pollRef.current = setInterval(poll, 12000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [customDomainStatus, isOpen, projectId, onCustomDomainChanged]);

  // ── Publish handlers ─────────────────────────────────────────────────────
  const handlePublish = useCallback(async () => {
    if (!webcontainer) return;
    setState("building");
    setStatusText("Building...");
    setErrorOutput("");

    try {
      setStatusText("Building project...");
      const buildCmd = platform === "multiplatform" ? "build:web" : "build";
      const buildProcess = await webcontainer.spawn("pnpm", ["run", buildCmd]);

      let buildOutput = "";
      const reader = buildProcess.output.getReader();
      let reading = true;

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

      setStatusText("Packaging...");
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
  }, [webcontainer, projectId, onPublished, platform]);

  const handleUnpublish = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`, { method: "DELETE" });
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

  // ── Custom domain handlers ───────────────────────────────────────────────
  const handleAddDomain = useCallback(async () => {
    const trimmed = domainInput.trim();
    if (!trimmed) return;
    setDomainLoading(true);
    setDomainError("");

    try {
      const res = await fetch(`/api/projects/${projectId}/custom-domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: trimmed }),
      });
      const data = await res.json() as {
        ok?: boolean;
        error?: string;
        message?: string;
        domain?: string;
        status?: DomainStatus;
        wasApex?: boolean;
      };

      if (!res.ok) {
        setDomainError(data.message ?? data.error ?? "Failed to add domain.");
        return;
      }

      onCustomDomainChanged(data.domain ?? null, data.status ?? null);
      setDomainInput("");
    } catch (err) {
      setDomainError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setDomainLoading(false);
    }
  }, [domainInput, projectId, onCustomDomainChanged]);

  const handleRemoveDomain = useCallback(async () => {
    setDomainLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/custom-domain`, { method: "DELETE" });
      if (res.ok) {
        onCustomDomainChanged(null, null);
        setConfirmRemoveDomain(false);
        setDomainError("");
      }
    } catch (err) {
      console.error("Remove domain error:", err);
    } finally {
      setDomainLoading(false);
    }
  }, [projectId, onCustomDomainChanged]);

  const handleCheckDomainNow = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/custom-domain`);
      if (!res.ok) return;
      const data = await res.json() as { domain: string | null; status: DomainStatus; apex: string | null };
      onCustomDomainChanged(data.domain, data.status);
    } catch {
      // silent
    }
  }, [projectId, onCustomDomainChanged]);

  const handleRetryDomain = useCallback(async () => {
    if (!customDomain) return;
    setDomainLoading(true);
    setDomainError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/custom-domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: customDomain }),
      });
      const data = await res.json() as {
        ok?: boolean;
        error?: string;
        message?: string;
        domain?: string;
        status?: DomainStatus;
      };
      if (!res.ok) {
        setDomainError(data.message ?? data.error ?? "Retry failed.");
        return;
      }
      onCustomDomainChanged(data.domain ?? null, data.status ?? null);
    } catch (err) {
      setDomainError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setDomainLoading(false);
    }
  }, [customDomain, projectId, onCustomDomainChanged]);

  const handleCopyDomain = useCallback(() => {
    if (customDomain) {
      navigator.clipboard.writeText(`https://${customDomain}`);
      setDomainCopied(true);
      setTimeout(() => setDomainCopied(false), 2000);
    }
  }, [customDomain]);

  if (!isOpen) return null;

  // ─── Render ──────────────────────────────────────────────────────────────
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
          <span className="text-sm font-semibold">
            {platform === "multiplatform" ? "Deploy" : "Publish"}
          </span>
        </div>
        {state === "published" && (
          <span className="text-[10px] text-green-600 dark:text-green-400 font-medium bg-green-500/10 px-2 py-0.5 rounded-full">
            Live
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto modern-scrollbar">

        {/* ── Idle ── */}
        {state === "idle" && (
          <div className="flex flex-col items-center gap-4 px-5 py-8 text-center">
            <div className="w-12 h-12 rounded-full bg-soft/60 flex items-center justify-center">
              <Globe className="w-6 h-6 text-muted" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {platform === "multiplatform" ? "Deploy Web Version" : "Publish to the web"}
              </p>
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

        {/* ── Building ── */}
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

        {/* ── Published ── */}
        {state === "published" && (
          <div className="flex flex-col gap-3 px-4 py-4">
            {/* Primary URL */}
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
              <Button variant="outline" size="sm" className="flex-1" onClick={handleCopyUrl}>
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

            {/* Update */}
            <Button size="sm" className="w-full" onClick={handlePublish} disabled={!webcontainer}>
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

            {/* ── Custom Domain Section ── */}
            <div className="border-t border-border mt-1 pt-3">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-1.5">
                  <LinkIcon size={12} className="text-muted" />
                  <span className="text-xs font-semibold">Custom Domain</span>
                </div>

                {/* Status badge */}
                {customDomainStatus === "pending" && (
                  <span className="flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    Pending
                  </span>
                )}
                {customDomainStatus === "active" && (
                  <span className="flex items-center gap-1 text-[10px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full">
                    <Check size={9} />
                    Active
                  </span>
                )}
                {customDomainStatus === "error" && (
                  <span className="flex items-center gap-1 text-[10px] font-medium text-red-500 bg-red-500/10 px-2 py-0.5 rounded-full">
                    <X size={9} />
                    Error
                  </span>
                )}
                {!canUseCustomDomain && (
                  <span className="text-[10px] font-medium text-accent bg-accent/10 px-2 py-0.5 rounded-full">
                    Pro
                  </span>
                )}
              </div>

              {/* ── Free tier gate ── */}
              {!canUseCustomDomain && (
                <div className="rounded-lg border border-border bg-bg p-3 text-center space-y-2">
                  <div className="flex justify-center">
                    <div className="w-8 h-8 rounded-full bg-soft flex items-center justify-center">
                      <Lock size={14} className="text-muted" />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted leading-relaxed">
                    Connect your own domain (e.g., <span className="font-mono">myapp.com</span>) instead of the default <span className="font-mono">.pages.dev</span> URL.
                  </p>
                  <a
                    href="/pricing"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center w-full h-7 rounded-md border border-border bg-transparent text-xs font-medium text-foreground hover:bg-soft transition-colors"
                  >
                    Upgrade to Pro
                  </a>
                </div>
              )}

              {/* ── No domain set (Pro/Max) ── */}
              {canUseCustomDomain && !customDomain && (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted leading-relaxed">
                    Connect your own domain. Enter your domain and we&apos;ll give you a DNS record to add.
                  </p>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={domainInput}
                      onChange={(e) => {
                        setDomainInput(e.target.value);
                        setDomainError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !domainLoading) handleAddDomain();
                      }}
                      placeholder="myapp.com"
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                      className={cn(
                        "flex-1 min-w-0 h-8 px-2.5 rounded-lg border text-xs font-mono",
                        "bg-bg text-foreground placeholder:text-muted",
                        "focus:outline-none focus:ring-1 focus:ring-accent/50",
                        domainError ? "border-red-500/60" : "border-border"
                      )}
                    />
                    <Button
                      size="sm"
                      className="h-8 px-3 shrink-0"
                      onClick={handleAddDomain}
                      disabled={domainLoading || !domainInput.trim()}
                    >
                      {domainLoading ? <Loader2 size={12} className="animate-spin" /> : "Add"}
                    </Button>
                  </div>
                  {domainError && (
                    <p className="text-[11px] text-red-500 leading-relaxed">{domainError}</p>
                  )}
                  <p className="text-[10px] text-muted leading-relaxed">
                    Entering <span className="font-mono">myapp.com</span> will use <span className="font-mono">www.myapp.com</span>. We&apos;ll show you how to redirect the root domain too.
                  </p>
                </div>
              )}

              {/* ── Domain pending (DNS setup) ── */}
              {canUseCustomDomain && customDomain && customDomainStatus === "pending" && cnameTarget && (
                <div className="space-y-3">
                  <p className="text-[11px] text-muted leading-relaxed">
                    Add this DNS record at your domain registrar, then wait a few minutes for it to propagate.
                  </p>

                  <DnsRecordCard domain={customDomain} cnameTarget={cnameTarget} />

                  {domainApex && (
                    <RedirectInstructions apex={domainApex} www={customDomain} />
                  )}

                  <p className="text-[10px] text-muted text-center leading-relaxed">
                    DNS can take a few minutes to propagate.{" "}
                    <span className="italic">Checking automatically...</span>
                  </p>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs h-7"
                      onClick={handleCheckDomainNow}
                    >
                      <RefreshCw size={11} className="mr-1.5" />
                      Check Now
                    </Button>
                    {!confirmRemoveDomain ? (
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveDomain(true)}
                        className="flex items-center gap-1 text-xs text-muted hover:text-red-500 transition-colors px-2"
                      >
                        <Trash2 size={11} />
                        Remove
                      </button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveDomain(false)}
                          className="text-[11px] text-muted hover:text-foreground px-1"
                        >
                          Cancel
                        </button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-[11px] h-7 px-2 text-red-500 border-red-500/40 hover:bg-red-500/10"
                          onClick={handleRemoveDomain}
                          disabled={domainLoading}
                        >
                          {domainLoading ? <Loader2 size={10} className="animate-spin" /> : "Confirm"}
                        </Button>
                      </div>
                    )}
                  </div>

                  <p className="text-[10px] text-muted leading-relaxed">
                    <strong className="text-foreground">Tip:</strong> Some registrars only need the subdomain part in the Name field (e.g., just <span className="font-mono">www</span> instead of the full <span className="font-mono">{customDomain}</span>). Try both if one doesn&apos;t work.
                  </p>
                </div>
              )}

              {/* ── Domain active ── */}
              {canUseCustomDomain && customDomain && customDomainStatus === "active" && (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2 px-3 py-2 bg-bg rounded-lg border border-green-500/30">
                    <Globe size={12} className="text-green-500 shrink-0" />
                    <a
                      href={`https://${customDomain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-accent truncate flex-1 hover:underline font-mono"
                    >
                      {customDomain}
                    </a>
                  </div>

                  {domainApex && (
                    <p className="text-[10px] text-muted leading-relaxed">
                      Remember to set up a redirect from <span className="font-mono">{domainApex}</span> → <span className="font-mono">https://{customDomain}</span> at your registrar if you haven&apos;t already.
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs h-7"
                      onClick={handleCopyDomain}
                    >
                      {domainCopied ? (
                        <Check size={11} className="mr-1.5 text-green-500" />
                      ) : (
                        <Copy size={11} className="mr-1.5" />
                      )}
                      {domainCopied ? "Copied" : "Copy URL"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs h-7"
                      onClick={() => window.open(`https://${customDomain}`, "_blank")}
                    >
                      <ExternalLink size={11} className="mr-1.5" />
                      Open
                    </Button>
                  </div>

                  {!confirmRemoveDomain ? (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveDomain(true)}
                      className="flex items-center justify-center gap-1.5 text-xs text-muted hover:text-red-500 transition-colors w-full mt-1"
                    >
                      <Trash2 size={11} />
                      Remove Custom Domain
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted flex-1">Remove domain?</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7 px-2"
                        onClick={() => setConfirmRemoveDomain(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7 px-2 text-red-500 border-red-500/40 hover:bg-red-500/10"
                        onClick={handleRemoveDomain}
                        disabled={domainLoading}
                      >
                        {domainLoading ? <Loader2 size={10} className="animate-spin" /> : "Confirm"}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Domain error ── */}
              {canUseCustomDomain && customDomain && customDomainStatus === "error" && (
                <div className="space-y-2.5">
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                    <AlertCircle size={13} className="text-red-500 shrink-0 mt-0.5" />
                    <div className="space-y-1 min-w-0">
                      <p className="text-[11px] font-medium text-red-500">Domain verification failed</p>
                      <p className="text-[11px] text-muted leading-relaxed">
                        Cloudflare couldn&apos;t verify <span className="font-mono break-all">{customDomain}</span>.
                        Make sure the CNAME record is correct and try again.
                      </p>
                    </div>
                  </div>

                  {cnameTarget && (
                    <DnsRecordCard domain={customDomain} cnameTarget={cnameTarget} />
                  )}

                  {domainError && (
                    <p className="text-[11px] text-red-500 leading-relaxed">{domainError}</p>
                  )}

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 text-xs h-8"
                      onClick={handleRetryDomain}
                      disabled={domainLoading}
                    >
                      {domainLoading ? (
                        <Loader2 size={12} className="animate-spin mr-1.5" />
                      ) : (
                        <RefreshCw size={12} className="mr-1.5" />
                      )}
                      Retry
                    </Button>
                    {!confirmRemoveDomain ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs h-8 text-red-500 border-red-500/40 hover:bg-red-500/10"
                        onClick={() => setConfirmRemoveDomain(true)}
                      >
                        <Trash2 size={12} className="mr-1.5" />
                        Remove
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1 flex-1">
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveDomain(false)}
                          className="text-[11px] text-muted hover:text-foreground px-1"
                        >
                          Cancel
                        </button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 text-[11px] h-8 text-red-500 border-red-500/40 hover:bg-red-500/10"
                          onClick={handleRemoveDomain}
                          disabled={domainLoading}
                        >
                          {domainLoading ? <Loader2 size={10} className="animate-spin" /> : "Confirm Remove"}
                        </Button>
                      </div>
                    )}
                  </div>

                  <p className="text-[10px] text-muted leading-relaxed">
                    Common causes: the CNAME record hasn&apos;t propagated yet (can take up to 48 hours), or the record was entered incorrectly. Some registrars only need <span className="font-mono">www</span> as the Name field — check your registrar&apos;s documentation.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {state === "error" && (
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex items-center gap-2">
              <AlertCircle size={14} className="text-red-500 shrink-0" />
              <span className="text-xs font-medium text-red-500">Build failed</span>
            </div>

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
              <Button variant="outline" size="sm" className="flex-1" onClick={handleCopyError}>
                {copied ? (
                  <Check size={13} className="mr-1.5 text-green-500" />
                ) : (
                  <Copy size={13} className="mr-1.5" />
                )}
                {copied ? "Copied" : "Copy error"}
              </Button>
              <Button size="sm" className="flex-1" onClick={handlePublish}>
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
              <span className="text-[10px] text-muted bg-soft px-1.5 py-0.5 rounded-full ml-auto">
                Coming Soon
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-2 px-4 py-3">
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
              Native builds will be available in a future update. Web deployment above is fully
              functional.
            </p>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(panel, document.body);
}
