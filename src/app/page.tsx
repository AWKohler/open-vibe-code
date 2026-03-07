"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useUser,
} from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { ArrowUp, Plus, Smartphone, Laptop, Cog, ImagePlus, X as IconX } from "lucide-react";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { useToast } from "@/components/ui/toast";
import { ModelSelector } from "@/components/ui/ModelSelector";
import type { ModelId } from "@/lib/agent/models";
import { modelSupportsImages } from "@/lib/agent/models";
import { processImageForUpload } from "@/lib/image-processing";
import { checkDeviceSupport } from "@/lib/device";
import { Anthropic } from "@/components/icons/anthropic";
import { OpenAI } from "@/components/icons/openai";
import { Convex } from "@/components/icons/convex";

interface LandingPendingImage {
  id: string;
  file: File;
  localUrl: string;
}

export default function Home() {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState<"web" | "mobile">("web");
  const [model, setModel] = useState<ModelId>("fireworks-minimax-m2p5");
  const { toast } = useToast();
  const [hasOpenAIKey, setHasOpenAIKey] = useState<boolean | null>(null);
  const [hasAnthropicKey, setHasAnthropicKey] = useState<boolean | null>(null);
  const [hasClaudeOAuth, setHasClaudeOAuth] = useState<boolean | null>(null);
  const [hasMoonshotKey, setHasMoonshotKey] = useState<boolean | null>(null);
  const [hasCodexOAuth, setHasCodexOAuth] = useState<boolean | null>(null);
  const [hasFireworksKey, setHasFireworksKey] = useState<boolean | null>(null);
  const [userTier, setUserTier] = useState<'free' | 'pro' | 'max'>('free');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDefaultTab, setSettingsDefaultTab] = useState<'usage' | 'connections' | 'subscription'>('usage');
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [pendingImages, setPendingImages] = useState<LandingPendingImage[]>([]);
  const [showPlusPopover, setShowPlusPopover] = useState(false);
  const plusButtonRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [projectName, setProjectName] = useState("");
  const [pendingParams, setPendingParams] = useState<URLSearchParams | null>(
    null,
  );
  const PENDING_PARAMS_KEY = "huggable_pending_start_params";
  const PENDING_NAME_KEY = "huggable_pending_project_name";
  const allowedModels = new Set([
    "gpt-5.3-codex",
    "gpt-5.2", // legacy compat
    "claude-sonnet-4.6",
    "claude-opus-4.6",
    "kimi-k2-thinking-turbo", // legacy compat
    "fireworks-minimax-m2p5",
    "fireworks-glm-5",
  ]);

  // Models served via platform keys — don't require BYOK at project start
  const serverKeyModels = new Set([
    "fireworks-minimax-m2p5",
    "fireworks-glm-5",
    "claude-sonnet-4.6",
    "claude-opus-4.6",
  ]);
  const landingSignInModalAppearance = {
    elements: {
      modalContent: "!max-h-[90vh] !overflow-hidden",
      cardBox:
        "!max-h-[90vh] !overflow-y-auto !rounded-2xl !border !border-[var(--sand-border)] !bg-[var(--color-surface)] !shadow-xl",
      card: "!h-auto !max-h-none !overflow-visible !bg-transparent !border-0 !shadow-none !pb-4",
      footer: "!mt-2 !pt-2 !bg-transparent",
    },
  } as const;

  const canSend = useMemo(() => prompt.trim().length > 0 || pendingImages.length > 0, [prompt, pendingImages.length]);

  const providerAccess = useMemo(() => ({
    openai: hasCodexOAuth || hasOpenAIKey,
    // For server-key models (Sonnet, Opus, MiniMax, GLM-5) BYOK isn't required —
    // treat provider as null (unknown/not checked) rather than false (blocked).
    // The tier gate handles access control for those models.
    anthropic: hasClaudeOAuth || hasAnthropicKey || null,
    moonshot: hasMoonshotKey,
    fireworks: hasFireworksKey === true ? true : null,
  }), [hasCodexOAuth, hasOpenAIKey, hasClaudeOAuth, hasAnthropicKey, hasMoonshotKey, hasFireworksKey]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const newImages = await Promise.all(files.map(async (file) => {
      const processed = await processImageForUpload(file);
      return { id: crypto.randomUUID(), file: processed, localUrl: URL.createObjectURL(processed) };
    }));
    setPendingImages(prev => [...prev, ...newImages]);
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setPendingImages(prev => {
      const img = prev.find(i => i.id === id);
      if (img) URL.revokeObjectURL(img.localUrl);
      return prev.filter(i => i.id !== id);
    });
  }, []);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 300) + 'px';
  }, [prompt]);

  // Close plus popover on outside click
  useEffect(() => {
    if (!showPlusPopover) return;
    const handler = (e: MouseEvent) => {
      if (plusButtonRef.current && !plusButtonRef.current.contains(e.target as Node)) {
        setShowPlusPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPlusPopover]);

  const ensureModelKeyPresent = () => {
    // Server-key models don't require BYOK — platform provides them
    if (serverKeyModels.has(model)) return true;

    const hasAnthropicCreds = hasAnthropicKey || hasClaudeOAuth;
    const hasOpenAICreds = hasCodexOAuth || hasOpenAIKey;
    const keyChecks: Record<string, { hasKey: boolean | null; provider: string }> = {
      "gpt-5.3-codex": { hasKey: hasOpenAICreds, provider: "OpenAI" },
    };
    const check = keyChecks[model];
    if (check?.hasKey === false) {
      toast({
        title: "Missing API key",
        description: `Please add your ${check.provider} API key in Settings.`,
      });
      return false;
    }
    return true;
  };

  const start = (authed: boolean) => {
    const device = checkDeviceSupport();
    if (!device.supported) {
      toast({
        title: "Device not supported",
        description: device.reason ?? "Botflow is a desktop-only platform. Please use a desktop browser.",
      });
      return;
    }

    const params = new URLSearchParams();
    if (prompt.trim()) params.set("prompt", prompt.trim());
    params.set("visibility", "public");
    params.set("platform", platform);
    params.set("model", model);
    const defaultName = prompt.trim()
      ? prompt.trim().slice(0, 48)
      : "New Project";
    params.set("name", defaultName);
    const target = `/start?${params.toString()}`;
    if (authed) {
      setPendingParams(params);
      setProjectName(defaultName);
      if (typeof window !== "undefined") {
        localStorage.setItem(PENDING_PARAMS_KEY, params.toString());
        localStorage.setItem(PENDING_NAME_KEY, defaultName);
      }
      setShowNameDialog(true);
    } else {
      setPendingParams(params);
      setProjectName(defaultName);
      if (typeof window !== "undefined") {
        localStorage.setItem(PENDING_PARAMS_KEY, params.toString());
        localStorage.setItem(PENDING_NAME_KEY, defaultName);
      }
      setShowAuthDialog(true);
    }
  };

  const handleCreateProject = async () => {
    if (!pendingParams) return;
    if (!ensureModelKeyPresent()) return;
    const params = new URLSearchParams(pendingParams);
    const chosenName = projectName.trim()
      ? projectName.trim().slice(0, 48)
      : "New Project";
    params.set("name", chosenName);
    setShowNameDialog(false);
    setPendingParams(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
    // Serialize pending images to sessionStorage for AgentPanel to pick up
    if (pendingImages.length > 0) {
      try {
        const imageParts = await Promise.all(
          pendingImages.map((img) =>
            new Promise<{ type: 'file'; mediaType: string; url: string; filename: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve({
                type: 'file',
                mediaType: img.file.type || 'image/jpeg',
                url: reader.result as string,
                filename: img.file.name,
              });
              reader.onerror = reject;
              reader.readAsDataURL(img.file);
            })
          )
        );
        sessionStorage.setItem('botflow_pending_images', JSON.stringify(imageParts));
      } catch (err) {
        console.error('Failed to serialize images for workspace:', err);
      }
      pendingImages.forEach(img => URL.revokeObjectURL(img.localUrl));
      setPendingImages([]);
    }
    router.push(`/start?${params.toString()}`);
  };

  const closeAuthDialog = () => {
    setShowAuthDialog(false);
    setPendingParams(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
  };

  const closeNameDialog = () => {
    setShowNameDialog(false);
    setPendingParams(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
  };

  const fetchUserSettings = useCallback(async () => {
    try {
      const [settingsRes, budgetRes] = await Promise.all([
        fetch("/api/user-settings"),
        fetch("/api/usage/budget"),
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setHasOpenAIKey(Boolean(data?.hasOpenAIKey));
        setHasAnthropicKey(Boolean(data?.hasAnthropicKey));
        setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
        setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
        setHasMoonshotKey(Boolean(data?.hasMoonshotKey));
        setHasFireworksKey(Boolean(data?.hasFireworksKey));
      }
      if (budgetRes.ok) {
        const data = await budgetRes.json();
        if (data?.tier === 'pro' || data?.tier === 'max') {
          setUserTier(data.tier as 'pro' | 'max');
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      setHasOpenAIKey(null);
      setHasAnthropicKey(null);
      setHasMoonshotKey(null);
      setHasFireworksKey(null);
      return;
    }
    void fetchUserSettings();
  }, [isSignedIn, fetchUserSettings]);

  // Refresh provider access when settings modal closes
  useEffect(() => {
    const handler = () => { if (isSignedIn) void fetchUserSettings(); };
    window.addEventListener('settings-closed', handler);
    return () => window.removeEventListener('settings-closed', handler);
  }, [isSignedIn, fetchUserSettings]);

  useEffect(() => {
    if (!pendingParams && typeof window !== "undefined") {
      const storedParams = localStorage.getItem(PENDING_PARAMS_KEY);
      const storedName = localStorage.getItem(PENDING_NAME_KEY);
      if (storedParams) {
        setPendingParams(new URLSearchParams(storedParams));
        const storedParamsObj = new URLSearchParams(storedParams);
        const storedModel = storedParamsObj.get("model");
        const storedPlatform = storedParamsObj.get("platform");
        if (storedModel && allowedModels.has(storedModel)) {
          // Map legacy model IDs
          const resolved = storedModel === 'gpt-5.2' ? 'gpt-5.3-codex' : storedModel;
          setModel(resolved as ModelId);
        }
        if (storedPlatform === "web" || (storedPlatform === "mobile" && process.env.NEXT_PUBLIC_ALLOW_MOBILE_EXP)) {
          setPlatform(storedPlatform);
        }
        if (storedName) setProjectName(storedName);
      }
    }
    if (isSignedIn && pendingParams) {
      setShowAuthDialog(false);
      setShowNameDialog(true);
    }
  }, [isSignedIn, pendingParams]);

  return (
    <>
      <div className="antialiased text-[var(--sand-text)] bg-[var(--sand-bg)] min-h-screen flex flex-col">
        {/* Background gradient */}
        <div className="relative isolate overflow-hidden flex flex-1 flex-col">
          <div className="pointer-events-none absolute inset-0 -z-10 landing-gradient" />

          {/* Nav */}
          <header className="relative">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-4 sm:py-5">
              <div className="flex items-center justify-between">
                <a className="flex items-center gap-2.5" href="#">
                  <img
                    src="/brand/botflow-glyph.svg"
                    alt=""
                    className="h-9 w-9"
                  />
                  <img
                    src="/brand/botflow-wordmark.svg"
                    alt="Botflow"
                    className="h-6 w-auto botflow-wordmark-invert"
                  />
                </a>

                <nav className="hidden md:flex items-center gap-7 text-sm text-[var(--sand-text)]">
                  <SignedIn>
                    <a
                      className="font-medium hover:text-[var(--sand-text)] transition"
                      href="/projects"
                    >
                      My Projects
                    </a>
                  </SignedIn>
                  <a
                    className="font-semibold hover:text-[var(--sand-text)] transition"
                    href="/pricing"
                  >
                    Pricing
                  </a>
                </nav>

                <div className="flex items-center gap-2">
                  <SignedOut>
                    <Link
                      href="/sign-in"
                      className="hidden sm:inline-flex items-center rounded-xl border border-border bg-elevated px-3.5 py-2 text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      Log in
                    </Link>
                    <Link
                      href="/sign-up"
                      className="inline-flex items-center rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow-[0_1px_0_rgba(255,255,255,0.2)_inset,0_8px_20px_-8px_rgba(0,0,0,0.5)] hover:opacity-95 transition"
                    >
                      Get started
                    </Link>
                  </SignedOut>
                  <SignedIn>
                    <button
                      onClick={() => { setSettingsDefaultTab('usage'); setShowSettings(true); }}
                      className="inline-flex items-center justify-center rounded-xl border border-border bg-elevated px-2.5 py-2 text-sm text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                      title="Settings"
                      aria-label="Settings"
                    >
                      <Cog className="h-4 w-4" />
                    </button>
                    <UserButton afterSignOutUrl="/" />
                  </SignedIn>
                </div>
              </div>
            </div>
          </header>

          {/* Hero */}
          <section className="relative flex flex-1 items-center justify-center">
            <div className="relative flex w-full flex-col items-center justify-center overflow-hidden px-6 py-[20vh] pb-[24vh] 2xl:py-48 2xl:pb-52">
              <div className="w-full max-w-3xl flex flex-col items-center">

              <h1 className="text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-semibold tracking-tight text-[var(--sand-text)] text-center leading-tight">
                Build something
                <span className="inline-flex mx-1 sm:mx-2 translate-y-0.5 sm:translate-y-1 align-middle">
                  <img
                    src="/brand/botflow-glyph.svg"
                    alt=""
                    className="h-8 w-8 sm:h-12 sm:w-12"
                  />
                </span>
              </h1>
              <p className="text-center text-[var(--sand-text)] text-sm sm:text-lg leading-none">
                Create apps and websites by chatting with AI.
              </p>
              {/* <p className="text-center text-[var(--sand-text)] text-sm sm:text-lg leading-none -mt-2">
                Backend by{" "}
                <span className="inline-flex items-center align-middle -ml-3" style={{ height: "2.8em" }}>
                  <Convex className="h-full w-auto" />
                </span>
              </p> */}

              {/* Prompt box */}
              <div className="w-full mt-4 sm:mt-5">
                <div className="flex flex-col rounded-2xl sm:rounded-3xl border border-border bg-elevated backdrop-blur-sm shadow-[0_2px_0_rgba(0,0,0,0.02),0_20px_60px_-20px_rgba(0,0,0,0.2)]">

                  {/* Textarea — grows but never overlaps the footer */}
                  <textarea
                    ref={textareaRef}
                    placeholder="Ask Botflow to create a web app that..."
                    className="w-full bg-transparent px-4 sm:px-5 pt-3 sm:pt-4 pb-2 text-sm sm:text-lg text-[var(--sand-text)] placeholder-neutral-400 outline-none resize-none overflow-y-auto modern-scrollbar"
                    aria-label="Generation prompt"
                    style={{ minHeight: 96, maxHeight: 300 }}
                    maxLength={30000}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />

                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                  />

                  {/* Footer bar */}
                  <div className="flex flex-col gap-1 px-2.5 sm:px-3 pb-2.5 sm:pb-3 pt-1">
                    {/* Thumbnail strip */}
                    {pendingImages.length > 0 && (
                      <div className="flex gap-2 overflow-x-auto modern-scrollbar pb-1">
                        {pendingImages.map(img => (
                          <div key={img.id} className="relative group shrink-0">
                            <div className="w-10 h-10 rounded-lg border border-border overflow-hidden">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={img.localUrl} alt={img.file.name} className="w-full h-full object-cover" />
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveImage(img.id)}
                              className="absolute -top-1.5 -right-1.5 flex items-center justify-center size-4 rounded-full bg-elevated border border-border text-neutral-500 hover:text-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity"
                              aria-label="Remove image"
                            >
                              <IconX size={10} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Controls + send row */}
                    <div className="flex items-center justify-between gap-1.5 sm:gap-2">
                      {/* Left controls */}
                      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                        {/* + button with popover */}
                        <div ref={plusButtonRef} className="relative shrink-0">
                          <button
                            type="button"
                            onClick={() => setShowPlusPopover(v => !v)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-elevated shadow-sm shadow-soft hover:border-transparent hover:bg-accent/15 transition"
                            aria-label="Attach"
                          >
                            <Plus className="h-4 w-4 text-[var(--sand-text)]" />
                          </button>
                          {showPlusPopover && (
                            <div className="absolute bottom-full mb-2 left-0 w-44 rounded-xl border border-border bg-surface shadow-lg overflow-hidden z-20">
                              <button
                                type="button"
                                onClick={() => { setShowPlusPopover(false); fileInputRef.current?.click(); }}
                                disabled={!modelSupportsImages(model)}
                                className={cn(
                                  "flex w-full items-center gap-2.5 px-3 py-2 text-sm transition",
                                  modelSupportsImages(model)
                                    ? "text-[var(--sand-text)] hover:bg-elevated cursor-pointer"
                                    : "text-neutral-400 cursor-not-allowed"
                                )}
                              >
                                <ImagePlus size={15} className="shrink-0" />
                                <span>Attach image</span>
                              </button>
                            </div>
                          )}
                        </div>
                        {process.env.NEXT_PUBLIC_ALLOW_MOBILE_EXP && (
                          <button
                            type="button"
                            onClick={() => setPlatform(platform === "web" ? "mobile" : "web")}
                            className="shrink-0 inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm shadow-soft hover:border-transparent hover:bg-accent/15 transition"
                            title="Toggle platform"
                          >
                            {platform === "web" ? <Laptop className="h-3.5 w-3.5 sm:h-4 sm:w-4" /> : <Smartphone className="h-3.5 w-3.5 sm:h-4 sm:w-4" />}
                            <span className="hidden sm:inline">{platform === "web" ? "Web" : "Mobile App (Experimental)"}</span>
                            <span className="sm:hidden">{platform === "web" ? "Web" : "Mobile"}</span>
                          </button>
                        )}
                        <ModelSelector
                          value={model}
                          onChange={setModel}
                          providerAccess={providerAccess}
                          userTier={userTier}
                          size="md"
                          onTierLocked={() => {
                            toast({
                              title: "Plan required",
                              description: "This model requires a Pro or Max plan. Upgrade or add your own API key in Settings.",
                            });
                          }}
                        />
                      </div>

                      {/* Send button */}
                      <SignedIn>
                        <button
                          onClick={() => start(true)}
                          disabled={!canSend}
                          className={cn(
                            "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-white shadow-md transition",
                            !canSend ? "opacity-50 cursor-not-allowed" : "hover:opacity-90",
                          )}
                        >
                          <ArrowUp className="h-5 w-5" />
                        </button>
                      </SignedIn>
                      <SignedOut>
                        <button
                          onClick={() => start(false)}
                          className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-white shadow-md hover:opacity-90 transition"
                        >
                          <ArrowUp className="h-5 w-5" />
                        </button>
                      </SignedOut>
                    </div>
                  </div>
                </div>
              </div>

              {/* Suggestion pills */}
              {/* <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {[
                  "A SaaS dashboard with auth",
                  "A real-time chat app",
                  "A portfolio website",
                  "A todo app with a backend",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setPrompt(suggestion)}
                    className="rounded-full border border-border bg-elevated px-3.5 py-1.5 text-xs sm:text-sm text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                  >
                    {suggestion}
                  </button>
                ))}
              </div> */}

              {/* OAuth provider pills */}
              <div className="mt-1 sm:mt-2 flex flex-col items-center gap-2">
                {/* <p className="text-xs text-neutral-400">
                  Use Botflow with your Claude or ChatGPT plan
                </p> */}
                <div className="flex items-center justify-center gap-1.5 sm:gap-2 mt-2">
                  <SignedOut>
                    <Link
                      href="/sign-up"
                      className="whitespace-nowrap inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      <Anthropic className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                      Sign in with Claude
                    </Link>
                    <Link
                      href="/sign-up"
                      className="whitespace-nowrap inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      <OpenAI className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                      Sign in with ChatGPT
                    </Link>
                  </SignedOut>
                  <SignedIn>
                    <button
                      type="button"
                      onClick={() => { setSettingsDefaultTab('connections'); setShowSettings(true); }}
                      className="whitespace-nowrap inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      <Anthropic className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                      Sign in with Claude
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSettingsDefaultTab('connections'); setShowSettings(true); }}
                      className="whitespace-nowrap inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      <OpenAI className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                      Sign in with ChatGPT
                    </button>
                  </SignedIn>
                </div>
              </div>

              <p className="text-center text-[var(--sand-text)] text-sm sm:text-lg leading-none mt-2 opacity-75">
                Backend by{" "}
                <span className="inline-flex items-center align-middle -ml-3" style={{ height: "2.8em" }}>
                  <Convex className="h-full w-auto opacity-75" />
                </span>
              </p>


              </div>{/* end max-w-3xl */}
            </div>{/* end hero inner */}
          </section>

          {/* Footer */}
          <footer className="relative mt-auto">
            <div className="mx-auto max-w-7xl px-6 py-12 text-sm text-[var(--sand-text)]">
              <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
                <p>© 2026 Botflow</p>
                <div className="flex items-center gap-6">
                  <a className="hover:text-[var(--sand-text)]" href="#">
                    Privacy
                  </a>
                  <a className="hover:text-[var(--sand-text)]" href="#">
                    Terms
                  </a>
                  <a className="hover:text-[var(--sand-text)]" href="#">
                    Contact
                  </a>
                </div>
              </div>
            </div>
          </footer>
        </div>
      </div>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} defaultTab={settingsDefaultTab} />

      {showAuthDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-neutral-900">
              Sign in to start building
            </h2>
            <p className="mt-2 text-sm text-neutral-600">
              Sign in or sign up to create your project workspace. You&apos;ll
              be able to name it on the next step.
            </p>
            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              <SignInButton
                mode="modal"
                appearance={landingSignInModalAppearance}
              >
                <button className="inline-flex flex-1 items-center justify-center rounded-xl bg-black px-4 py-2.5 text-sm font-medium text-white shadow hover:opacity-90 transition">
                  Sign in / Sign up
                </button>
              </SignInButton>
              <button
                onClick={closeAuthDialog}
                className="inline-flex flex-1 items-center justify-center rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-neutral-50 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showNameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-neutral-900">
              Name your project
            </h2>
            <p className="mt-2 text-sm text-neutral-600">
              Give your project a short name so it&apos;s easy to find later.
            </p>
            <div className="mt-4">
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateProject();
                }}
                placeholder="My new project"
                className="w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-neutral-900 shadow-sm outline-none focus:ring-2 focus:ring-black/10"
              />
            </div>
            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              <button
                onClick={handleCreateProject}
                className="inline-flex flex-1 items-center justify-center rounded-xl bg-black px-4 py-2.5 text-sm font-medium text-white shadow hover:opacity-90 transition"
              >
                Continue to workspace
              </button>
              <button
                onClick={closeNameDialog}
                className="inline-flex flex-1 items-center justify-center rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-neutral-50 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
