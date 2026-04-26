'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Monitor } from 'lucide-react';
import { Workspace } from '@/components/workspace';
import { checkDeviceSupport } from '@/lib/device';
import type { ProjectPlatform } from '@/lib/project-platform';

interface Props {
  projectId: string;
  initialPrompt?: string;
  platform?: ProjectPlatform;
}

/**
 * Guards the Workspace component behind:
 * 1. A device support check — blocks unsupported mobile devices
 * 2. A cross-origin isolation check — WebContainer requires SharedArrayBuffer
 */
export function IsolationGuard({ projectId, initialPrompt, platform }: Props) {
  const [deviceBlocked, setDeviceBlocked] = useState<string | null>(null);
  const [ready] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    if (window.crossOriginIsolated) return true;
    return Boolean(sessionStorage.getItem('wc-isolation-reload'));
  });

  useEffect(() => {
    const device = checkDeviceSupport();
    if (!device.supported) {
      setDeviceBlocked(device.reason ?? 'Your device is not supported.');
    }
  }, []);

  useEffect(() => {
    if (deviceBlocked) return;
    if (!ready) {
      sessionStorage.setItem('wc-isolation-reload', '1');
      window.location.reload();
    } else {
      sessionStorage.removeItem('wc-isolation-reload');
    }
  }, [ready, deviceBlocked]);

  if (deviceBlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--sand-bg)] text-[var(--sand-text)] px-4">
        <div className="max-w-md text-center space-y-5 p-8 rounded-2xl border border-border bg-white shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100">
            <Monitor className="h-7 w-7 text-neutral-500" />
          </div>
          <h1 className="text-2xl font-semibold text-neutral-900">Desktop required</h1>
          <p className="text-sm text-neutral-600 leading-relaxed">
            {deviceBlocked}
          </p>
          <p className="text-xs text-neutral-400">
            Botflow uses WebContainer technology that requires a desktop browser to run full development environments.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2">
            <Link
              href="/projects"
              className="inline-flex items-center rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow hover:opacity-90 transition"
            >
              View my projects
            </Link>
            <Link
              href="/"
              className="inline-flex items-center rounded-xl border border-border bg-elevated px-4 py-2 text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-neutral-50 transition"
            >
              Back home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!ready) return null;

  return <Workspace projectId={projectId} initialPrompt={initialPrompt} platform={platform} />;
}
