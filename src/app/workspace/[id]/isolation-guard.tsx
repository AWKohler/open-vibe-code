'use client';

import { useState, useEffect } from 'react';
import { Workspace } from '@/components/workspace';

interface Props {
  projectId: string;
  initialPrompt?: string;
  platform?: 'web' | 'mobile';
}

/**
 * Guards the Workspace component behind a cross-origin isolation check.
 * WebContainer requires `crossOriginIsolated` (SharedArrayBuffer access).
 * Next.js client-side navigation doesn't re-fetch HTML headers, so navigating
 * to /workspace/* without a full page load won't have the COOP/COEP headers.
 * This component triggers a hard reload when not isolated, then renders
 * Workspace only after isolation is confirmed — preventing the race condition
 * where an initial agent prompt fires before the reload, causing duplicate
 * concurrent API requests and a 429.
 */
export function IsolationGuard({ projectId, initialPrompt, platform }: Props) {
  const [ready] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    if (window.crossOriginIsolated) return true;
    // If we already tried a reload this session, don't loop
    return Boolean(sessionStorage.getItem('wc-isolation-reload'));
  });

  useEffect(() => {
    if (!ready) {
      sessionStorage.setItem('wc-isolation-reload', '1');
      window.location.reload();
    } else {
      sessionStorage.removeItem('wc-isolation-reload');
    }
  }, [ready]);

  if (!ready) return null;

  return <Workspace projectId={projectId} initialPrompt={initialPrompt} platform={platform} />;
}
