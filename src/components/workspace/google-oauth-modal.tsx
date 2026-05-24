"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface GoogleOAuthModalProps {
  requestId: string;
  convexSiteUrl: string | null;
  projectId: string;
  /** Called after a successful save OR a dismiss — clears the modal. */
  onClose: () => void;
}

export function GoogleOAuthModal({
  requestId,
  convexSiteUrl,
  projectId,
  onClose,
}: GoogleOAuthModalProps) {
  const callbackUrl = convexSiteUrl
    ? `${convexSiteUrl}/api/auth/callback/google`
    : "Convex site URL not available — deploy your Convex functions first";

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCopy = async () => {
    if (!convexSiteUrl) return;
    await navigator.clipboard.writeText(callbackUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDismiss = async () => {
    // Fire-and-forget the dismiss; close immediately so the user isn't blocked.
    fetch(`/api/projects/${projectId}/convex/oauth-provider-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, dismissed: true }),
    }).catch(() => {});
    onClose();
  };

  const handleSave = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError("Both fields are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/convex/oauth-provider-complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
        },
      );
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setError(data.error ?? "Failed to save credentials. Please try again.");
        return;
      }
      onClose();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    /* Full-screen overlay */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* Modal card */}
      <div className="relative w-full max-w-lg bg-surface border border-border rounded-2xl shadow-2xl mx-4 overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-border">
          {/* Google "G" logo */}
          <svg viewBox="0 0 24 24" className="w-6 h-6 shrink-0" aria-hidden="true">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-fg">Connect Google Sign-In</h2>
            <p className="text-xs text-muted mt-0.5">Enter your Google OAuth credentials to enable "Sign in with Google"</p>
          </div>
          <button
            onClick={handleDismiss}
            className="shrink-0 text-muted hover:text-fg hover:bg-elevated rounded-lg p-1.5 transition-colors"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">

          {/* Step 1 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-xs font-bold">1</span>
              <span className="text-sm font-medium text-fg">Create OAuth credentials in Google Cloud Console</span>
            </div>
            <div className="pl-7 space-y-2">
              <p className="text-xs text-muted leading-relaxed">
                Go to <strong className="text-fg">APIs &amp; Services → Credentials → Create Credentials → OAuth client ID</strong>.
                Choose <em>Web application</em> as the type, then add this redirect URI:
              </p>
              {/* Redirect URI display */}
              <div className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2",
                convexSiteUrl
                  ? "bg-elevated border-border"
                  : "bg-elevated border-border/50 opacity-60",
              )}>
                <code className="flex-1 text-xs text-fg font-mono break-all leading-relaxed">
                  {callbackUrl}
                </code>
                <button
                  onClick={handleCopy}
                  disabled={!convexSiteUrl}
                  className="shrink-0 text-muted hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Copy redirect URI"
                >
                  {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                </button>
              </div>
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
              >
                Open Google Cloud Console
                <ExternalLink size={11} />
              </a>
            </div>
          </div>

          {/* Step 2 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-xs font-bold">2</span>
              <span className="text-sm font-medium text-fg">Paste your credentials</span>
            </div>
            <div className="pl-7 space-y-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-muted">
                  Client ID
                </label>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => { setClientId(e.target.value); setError(null); }}
                  placeholder="123456789-abc...apps.googleusercontent.com"
                  className="w-full bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-fg placeholder:text-muted outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50 transition-colors"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-muted">
                  Client Secret
                </label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => { setClientSecret(e.target.value); setError(null); }}
                  placeholder="GOCSPX-…"
                  className="w-full bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-fg placeholder:text-muted outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50 transition-colors"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 pb-6">
          <button
            onClick={handleDismiss}
            className="text-sm text-muted hover:text-fg transition-colors"
          >
            Cancel — do this later
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !clientId.trim() || !clientSecret.trim()}
            className="flex items-center gap-2 bg-accent text-accent-foreground text-sm font-medium rounded-lg px-4 py-2 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Saving…
              </>
            ) : (
              "Save Credentials"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
