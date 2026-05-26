"use client";

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

type Toast = { id: number; title?: string; description?: string };

const ToastCtx = createContext<{ toast: (t: Omit<Toast, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    try {
      const label = `[toast] ${t.title ?? ''}${t.description ? ` — ${t.description}` : ''}`;
      const isError = /fail|error|denied|conflict|unable/i.test(`${t.title ?? ''} ${t.description ?? ''}`);
      if (isError) console.error(label); else console.log(label);
    } catch {}
    setToasts((prev) => [...prev, { id, ...t }]);
    // auto dismiss
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 3500);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="min-w-[240px] max-w-[360px] rounded-lg bg-neutral-900 text-white shadow-lg border border-black/10">
            {t.title && <div className="px-3 pt-2 pb-1 text-sm font-medium">{t.title}</div>}
            {t.description && <div className="px-3 pb-2 text-xs text-neutral-300">{t.description}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

