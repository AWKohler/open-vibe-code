"use client";

import { useEffect, useState } from 'react';
import { SignedIn, SignedOut, SignInButton, PricingTable } from '@clerk/nextjs';
import { useToast } from '@/components/ui/toast';
import { X, ExternalLink, AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UsageTab } from './UsageTab';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: Tab;
}

type Tab = 'usage' | 'connections' | 'subscription';
type Provider = 'openai' | 'anthropic' | 'moonshot' | 'fireworks';
type OAuthStep = 'idle' | 'tos' | 'connecting' | 'exchanging' | 'success';

const PROVIDERS: Array<{
  provider: Provider;
  label: string;
  field: string;
  placeholder: string;
}> = [
  { provider: 'openai', label: 'OpenAI API Key', field: 'openaiApiKey', placeholder: 'sk-...' },
  { provider: 'anthropic', label: 'Anthropic API Key', field: 'anthropicApiKey', placeholder: 'sk-ant-...' },
  { provider: 'moonshot', label: 'Moonshot API Key', field: 'moonshotApiKey', placeholder: 'moonshot-...' },
  { provider: 'fireworks', label: 'Fireworks AI API Key', field: 'fireworksApiKey', placeholder: 'fw-...' },
];

export function SettingsModal({ open, onClose, defaultTab = 'usage' }: SettingsModalProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<Provider | null>(null);
  const [removingKey, setRemovingKey] = useState<Provider | null>(null);
  const [keys, setKeys] = useState<Record<Provider, string>>({
    openai: '', anthropic: '', moonshot: '', fireworks: '',
  });
  const [hasKey, setHasKey] = useState<Record<Provider, boolean>>({
    openai: false, anthropic: false, moonshot: false, fireworks: false,
  });
  const [hasClaudeOAuth, setHasClaudeOAuth] = useState(false);
  const [hasCodexOAuth, setHasCodexOAuth] = useState(false);

  // Codex OAuth device flow state
  const [codexOAuthStep, setCodexOAuthStep] = useState<'idle' | 'polling' | 'success'>('idle');
  const [codexUserCode, setCodexUserCode] = useState('');
  const [codexVerificationUrl, setCodexVerificationUrl] = useState('');
  const [codexDeviceAuthId, setCodexDeviceAuthId] = useState('');
  const [codexPollInterval, setCodexPollInterval] = useState(5);

  // OAuth flow state
  const [oauthStep, setOauthStep] = useState<OAuthStep>('idle');
  const [tosChecked, setTosChecked] = useState(false);
  const [oauthCode, setOauthCode] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [pkceVerifier, setPkceVerifier] = useState('');
  const [oauthError, setOauthError] = useState('');

  useEffect(() => {
    if (!open) return;
    setActiveTab(defaultTab);
  }, [open, defaultTab]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setKeys({ openai: '', anthropic: '', moonshot: '', fireworks: '' });
    setOauthStep('idle');
    setTosChecked(false);
    setOauthCode('');
    setPkceVerifier('');
    setOauthError('');
    setCodexOAuthStep('idle');
    setCodexUserCode('');
    setCodexVerificationUrl('');
    setCodexDeviceAuthId('');
    (async () => {
      try {
        const res = await fetch('/api/user-settings');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setHasKey({
              openai: Boolean(data?.hasOpenAIKey),
              anthropic: Boolean(data?.hasAnthropicKey),
              moonshot: Boolean(data?.hasMoonshotKey),
              fireworks: Boolean(data?.hasFireworksKey),
            });
            setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
            setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  // handleClose is stable (defined inline on render, but deps are fine for this)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Codex device auth polling
  useEffect(() => {
    if (codexOAuthStep !== 'polling' || !codexDeviceAuthId || !codexUserCode) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/oauth/codex/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_auth_id: codexDeviceAuthId, user_code: codexUserCode }),
        });
        const data = await res.json();
        if (data.status === 'success') {
          setCodexOAuthStep('success');
          setHasCodexOAuth(true);
          toast({ title: 'ChatGPT Codex connected', description: 'OAuth token saved. GPT-5.3 Codex will use it automatically.' });
        } else if (data.status === 'failed') {
          setCodexOAuthStep('idle');
          toast({ title: 'Auth failed', description: 'Device authorization failed. Please try again.' });
        }
        // 'pending' — keep polling
      } catch {
        // ignore network errors, keep polling
      }
    }, codexPollInterval * 1000);
    return () => clearInterval(interval);
  }, [codexOAuthStep, codexDeviceAuthId, codexUserCode, codexPollInterval, toast]);

  const saveKey = async (provider: Provider) => {
    const config = PROVIDERS.find(p => p.provider === provider)!;
    const value = keys[provider].trim();
    if (!value) return;

    setSavingKey(provider);
    try {
      const res = await fetch('/api/user-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [config.field]: value }),
      });
      if (res.ok) {
        const data = await res.json();
        setHasKey({
          openai: Boolean(data?.hasOpenAIKey),
          anthropic: Boolean(data?.hasAnthropicKey),
          moonshot: Boolean(data?.hasMoonshotKey),
          fireworks: Boolean(data?.hasFireworksKey),
        });
        setKeys(prev => ({ ...prev, [provider]: '' }));
        toast({ title: 'Key saved', description: `${config.label} has been updated.` });
      } else {
        toast({ title: 'Save failed', description: 'Could not save key.' });
      }
    } catch {
      toast({ title: 'Save failed', description: 'Unexpected error.' });
    } finally {
      setSavingKey(null);
    }
  };

  const removeKey = async (provider: Provider) => {
    const config = PROVIDERS.find(p => p.provider === provider)!;
    setRemovingKey(provider);
    try {
      const res = await fetch('/api/user-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [config.field]: null }),
      });
      if (res.ok) {
        setHasKey(prev => ({ ...prev, [provider]: false }));
        setKeys(prev => ({ ...prev, [provider]: '' }));
        toast({ title: 'Key removed', description: `${config.label} has been removed.` });
      } else {
        toast({ title: 'Remove failed', description: 'Could not remove key.' });
      }
    } catch {
      toast({ title: 'Remove failed', description: 'Unexpected error.' });
    } finally {
      setRemovingKey(null);
    }
  };

  // ── Claude Code OAuth ────────────────────────────────────────────────────

  const startOAuthFlow = async () => {
    setOauthError('');
    try {
      const res = await fetch('/api/oauth/claude/start', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start OAuth flow');
      const { authUrl: url, verifier } = await res.json();
      setAuthUrl(url);
      setPkceVerifier(verifier);
      setOauthStep('connecting');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : 'Failed to start OAuth flow');
    }
  };

  function extractCode(input: string): string {
    const trimmed = input.trim();
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get('code');
      if (code) return code;
    } catch {
      // Not a URL — treat as raw code
    }
    return trimmed;
  }

  const exchangeCode = async () => {
    const code = extractCode(oauthCode);
    if (!code) return;
    setOauthError('');
    setOauthStep('exchanging');
    try {
      const res = await fetch('/api/oauth/claude/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier: pkceVerifier }),
      });
      const data = await res.json();
      if (!res.ok) {
        setOauthError(data.error ?? 'Token exchange failed');
        setOauthStep('connecting');
        return;
      }
      setHasClaudeOAuth(true);
      setOauthStep('success');
      toast({ title: 'Claude Code connected', description: 'OAuth token saved. Anthropic models will use it automatically.' });
    } catch {
      setOauthError('Unexpected error exchanging token.');
      setOauthStep('connecting');
    }
  };

  const disconnectOAuth = async () => {
    try {
      await fetch('/api/oauth/claude/disconnect', { method: 'POST' });
      setHasClaudeOAuth(false);
      setOauthStep('idle');
      toast({ title: 'Disconnected', description: 'Claude Code OAuth token removed.' });
    } catch {
      toast({ title: 'Error', description: 'Failed to disconnect.' });
    }
  };

  // ── ChatGPT Codex OAuth (device flow) ──────────────────────────────────

  const startCodexOAuth = async () => {
    try {
      const res = await fetch('/api/oauth/codex/start', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start device auth');
      const data = await res.json();
      setCodexUserCode(data.user_code);
      setCodexVerificationUrl(data.verification_url);
      setCodexDeviceAuthId(data.device_auth_id);
      setCodexPollInterval(data.interval || 5);
      setCodexOAuthStep('polling');
      window.open(data.verification_url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to start Codex auth' });
    }
  };

  const disconnectCodexOAuth = async () => {
    try {
      await fetch('/api/oauth/codex/disconnect', { method: 'POST' });
      setHasCodexOAuth(false);
      setCodexOAuthStep('idle');
      toast({ title: 'Disconnected', description: 'ChatGPT Codex OAuth removed.' });
    } catch {
      toast({ title: 'Error', description: 'Failed to disconnect.' });
    }
  };

  if (!open) return null;

  const handleClose = () => {
    onClose();
    // Notify listeners (AgentPanel, landing page) to refresh provider access
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('settings-closed'));
    }
  };

  const isSubscriptionTab = activeTab === 'subscription';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-4">
      {/* Blur backdrop as a sibling — NOT an ancestor of the modal content.
          This prevents backdrop-filter from creating a containing block that
          traps Clerk's checkout panel (position:fixed) inside our modal. */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={handleClose}
      />
      <div
        className={cn(
          'relative w-full rounded-2xl border border-border bg-bg shadow-xl max-h-[90vh] flex flex-col overflow-hidden transition-all duration-200',
          isSubscriptionTab ? 'max-w-5xl' : activeTab === 'usage' ? 'max-w-xl' : 'max-w-lg'
        )}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-6">
            <h2 className="text-lg font-semibold text-fg">Settings</h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveTab('usage')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition',
                  activeTab === 'usage'
                    ? 'bg-elevated text-fg'
                    : 'text-muted hover:text-fg'
                )}
              >
                Usage
              </button>
              <button
                onClick={() => setActiveTab('connections')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition',
                  activeTab === 'connections'
                    ? 'bg-elevated text-fg'
                    : 'text-muted hover:text-fg'
                )}
              >
                Connections
              </button>
              <button
                onClick={() => setActiveTab('subscription')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition',
                  activeTab === 'subscription'
                    ? 'bg-elevated text-fg'
                    : 'text-muted hover:text-fg'
                )}
              >
                Subscription
              </button>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="inline-flex items-center justify-center h-8 w-8 rounded-full hover:bg-elevated transition"
          >
            <X className="h-4 w-4 text-muted" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="px-6 py-5 overflow-y-auto flex-1">
          <SignedOut>
            <div className="rounded-xl border border-border p-6">
              <p className="mb-4 text-sm text-muted">You need to sign in to manage settings.</p>
              <SignInButton>
                <button className="inline-flex items-center rounded-lg border border-border bg-bg px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-surface transition">
                  Sign in
                </button>
              </SignInButton>
            </div>
          </SignedOut>

          <SignedIn>
            {/* ── Usage tab ── */}
            {activeTab === 'usage' && <UsageTab />}

            {/* ── Subscription tab ── */}
            {activeTab === 'subscription' && (
              <div>
                <p className="text-xs text-muted mb-5">
                  Free is the default plan — no action needed to get started.
                  Upgrade anytime to unlock more capabilities.
                </p>
                <PricingTable
                  newSubscriptionRedirectUrl="/projects"
                  ctaPosition="bottom"
                />
              </div>
            )}

            {/* ── Connections tab ── */}
            {activeTab === 'connections' && (
              <>
                {loading ? (
                  <div className="py-8 text-center text-sm text-muted">Loading…</div>
                ) : (
                  <div className="space-y-8">

                    {/* ── ChatGPT Codex OAuth section ── */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="text-sm font-semibold text-fg">ChatGPT Codex</h3>
                          <p className="text-xs text-muted mt-0.5">
                            Use your ChatGPT subscription for GPT-5.3 Codex.
                            Takes priority over the OpenAI API key below.
                          </p>
                        </div>
                        {hasCodexOAuth && codexOAuthStep === 'idle' ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-600 border border-green-500/30 whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3" /> Connected
                          </span>
                        ) : null}
                      </div>

                      {!hasCodexOAuth && codexOAuthStep === 'idle' && (
                        <button
                          onClick={startCodexOAuth}
                          className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg px-3.5 py-2 text-sm font-medium text-fg shadow-sm hover:bg-surface transition"
                        >
                          Sign in with ChatGPT Codex
                        </button>
                      )}

                      {hasCodexOAuth && codexOAuthStep === 'idle' && (
                        <button
                          onClick={disconnectCodexOAuth}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/15 px-3.5 py-2 text-sm font-medium text-red-500 hover:bg-red-500/25 transition"
                        >
                          Disconnect
                        </button>
                      )}

                      {codexOAuthStep === 'success' && (
                        <div className="flex items-center gap-2 text-sm text-green-700">
                          <CheckCircle2 className="h-4 w-4" />
                          Connected successfully!
                          <button
                            onClick={() => setCodexOAuthStep('idle')}
                            className="ml-auto text-muted hover:text-fg text-xs underline"
                          >
                            Done
                          </button>
                        </div>
                      )}

                      {codexOAuthStep === 'polling' && (
                        <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                          <p className="text-sm text-fg">
                            Go to{' '}
                            <a
                              href={codexVerificationUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium underline text-fg"
                            >
                              {codexVerificationUrl}
                            </a>{' '}
                            and enter this code:
                          </p>
                          <div className="flex items-center gap-3">
                            <code className="rounded-lg bg-bg border border-border px-4 py-2 text-lg font-mono font-bold tracking-widest text-fg select-all">
                              {codexUserCode}
                            </code>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(codexUserCode);
                                toast({ title: 'Copied', description: 'Code copied to clipboard.' });
                              }}
                              className="text-xs text-muted hover:text-fg underline"
                            >
                              Copy
                            </button>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Waiting for authorization...
                          </div>
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => window.open(codexVerificationUrl, '_blank', 'noopener,noreferrer')}
                              className="text-xs text-muted underline"
                            >
                              Re-open verification page
                            </button>
                            <button
                              onClick={() => { setCodexOAuthStep('idle'); setCodexUserCode(''); setCodexDeviceAuthId(''); }}
                              className="text-xs text-muted underline"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ── Claude Code OAuth section ── */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="text-sm font-semibold text-fg">Claude Code OAuth</h3>
                          <p className="text-xs text-muted mt-0.5">
                            Use your Claude Pro/Max subscription instead of an API key.
                            Takes priority over the Anthropic API key below.
                          </p>
                        </div>
                        {hasClaudeOAuth && oauthStep !== 'idle' && oauthStep !== 'success' ? null : hasClaudeOAuth ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-600 border border-green-500/30 whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3" /> Connected
                          </span>
                        ) : null}
                      </div>

                      {!hasClaudeOAuth && oauthStep === 'idle' && (
                        <button
                          onClick={() => setOauthStep('tos')}
                          className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg px-3.5 py-2 text-sm font-medium text-fg shadow-sm hover:bg-surface transition"
                        >
                          Connect with Claude Code
                        </button>
                      )}

                      {hasClaudeOAuth && oauthStep === 'idle' && (
                        <button
                          onClick={disconnectOAuth}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/15 px-3.5 py-2 text-sm font-medium text-red-500 hover:bg-red-500/25 transition"
                        >
                          Disconnect
                        </button>
                      )}

                      {oauthStep === 'success' && (
                        <div className="flex items-center gap-2 text-sm text-green-700">
                          <CheckCircle2 className="h-4 w-4" />
                          Connected successfully!
                          <button
                            onClick={() => setOauthStep('idle')}
                            className="ml-auto text-muted hover:text-fg text-xs underline"
                          >
                            Done
                          </button>
                        </div>
                      )}

                      {oauthStep === 'tos' && (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                            <div>
                              <p className="text-sm font-semibold text-amber-800">Non-commercial use only</p>
                              <p className="text-xs text-amber-700 mt-1">
                                Per Anthropic&apos;s Terms of Service, using your Claude Pro/Max
                                subscription via OAuth is permitted for <strong>personal, non-commercial
                                use only</strong>. Do not use this feature to power commercial products
                                or services.
                              </p>
                              <a
                                href="https://www.anthropic.com/legal/consumer-terms"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-amber-700 underline mt-1"
                              >
                                Anthropic Consumer Terms <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          </div>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={tosChecked}
                              onChange={e => setTosChecked(e.target.checked)}
                              className="h-4 w-4 rounded border-amber-300 accent-amber-600"
                            />
                            <span className="text-xs text-amber-800">
                              I understand this is for non-commercial use only
                            </span>
                          </label>
                          <div className="flex gap-2">
                            <button
                              onClick={startOAuthFlow}
                              disabled={!tosChecked}
                              className="inline-flex items-center gap-2 rounded-lg bg-fg px-3.5 py-2 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-40 transition"
                            >
                              Authorize with Claude
                              <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => { setOauthStep('idle'); setTosChecked(false); }}
                              className="inline-flex items-center rounded-lg border border-border px-3.5 py-2 text-sm text-muted hover:bg-surface transition"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {(oauthStep === 'connecting' || oauthStep === 'exchanging') && (
                        <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                          <ol className="text-xs text-muted space-y-1 list-decimal list-inside">
                            <li>Complete authorization in the tab that opened.</li>
                            <li>After redirecting, copy the full URL from your browser&apos;s address bar.</li>
                            <li>Paste it below and click&nbsp;<strong>Connect</strong>.</li>
                          </ol>
                          <p className="text-xs text-muted">
                            You can paste the full URL or just the <code className="bg-soft px-1 rounded">code</code> value:{' '}
                            <code className="bg-soft px-1 rounded text-muted">
                              …/callback?code=<strong>THIS PART</strong>&amp;state=…
                            </code>
                          </p>
                          {oauthError && (
                            <p className="text-xs text-red-600 font-medium">{oauthError}</p>
                          )}
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="Paste full callback URL or just the code…"
                              value={oauthCode}
                              onChange={e => setOauthCode(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') exchangeCode(); }}
                              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border"
                              disabled={oauthStep === 'exchanging'}
                            />
                            <button
                              onClick={exchangeCode}
                              disabled={!oauthCode.trim() || oauthStep === 'exchanging'}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-fg px-3.5 py-2 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-40 transition"
                            >
                              {oauthStep === 'exchanging' ? (
                                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</>
                              ) : 'Connect'}
                            </button>
                          </div>
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => window.open(authUrl, '_blank', 'noopener,noreferrer')}
                              className="text-xs text-muted underline"
                            >
                              Re-open authorization page
                            </button>
                            <button
                              onClick={() => { setOauthStep('idle'); setOauthCode(''); setPkceVerifier(''); setOauthError(''); }}
                              className="text-xs text-muted underline"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ── BYOK API Keys ── */}
                    <div>
                      <h3 className="text-sm font-semibold text-fg mb-1">API Keys</h3>
                      <p className="text-xs text-muted mb-4">
                        Bring your own keys. Each key is saved independently — adding one won&apos;t affect the others.
                        {hasCodexOAuth && (
                          <span className="ml-1 text-green-700 font-medium">
                            Codex OAuth is active — OpenAI API key is used as fallback only.
                          </span>
                        )}
                        {hasClaudeOAuth && (
                          <span className="ml-1 text-green-700 font-medium">
                            Claude Code OAuth is active — Anthropic API key is used as fallback only.
                          </span>
                        )}
                      </p>
                      <div className="space-y-4">
                        {PROVIDERS.map(({ provider, label, placeholder }) => (
                          <div key={provider}>
                            <label className="flex items-center gap-2 text-sm font-medium text-fg mb-1.5">
                              {label}
                              {hasKey[provider] && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-600 border border-green-500/30">
                                  Saved
                                </span>
                              )}
                              {provider === 'openai' && hasCodexOAuth && (
                                <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
                                  fallback
                                </span>
                              )}
                              {provider === 'anthropic' && hasClaudeOAuth && (
                                <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
                                  fallback
                                </span>
                              )}
                            </label>
                            <div className="flex items-center gap-2">
                              <input
                                type="password"
                                placeholder={hasKey[provider] ? '●●●●●●●● (type to replace)' : placeholder}
                                value={keys[provider]}
                                onChange={e => setKeys(prev => ({ ...prev, [provider]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') saveKey(provider); }}
                                className="flex-1 rounded-lg border border-border bg-bg text-fg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-border"
                              />
                              {hasKey[provider] && (
                                <button
                                  onClick={() => removeKey(provider)}
                                  disabled={removingKey === provider || savingKey === provider}
                                  title="Remove key"
                                  className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-red-500/30 bg-red-500/15 text-red-500 hover:bg-red-500/25 disabled:opacity-40 transition"
                                >
                                  {removingKey === provider
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Trash2 className="h-3.5 w-3.5" />}
                                </button>
                              )}
                              <button
                                onClick={() => saveKey(provider)}
                                disabled={!keys[provider].trim() || savingKey === provider || removingKey === provider}
                                className="inline-flex items-center rounded-lg bg-fg px-3.5 py-2 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-40 transition"
                              >
                                {savingKey === provider ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                  </div>
                )}
              </>
            )}
          </SignedIn>
        </div>
      </div>
    </div>
  );
}
