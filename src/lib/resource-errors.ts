export type ResourceErrorType = 'oom' | 'storage' | 'boot';

const OOM_PATTERNS = [
  'out of memory',
  'javascript heap out of memory',
  'enomem',
  'cannot allocate memory',
  'allocation failed',
  'wasm memory',
  'webassembly.instantiate',
  'wasm compile',
];

const STORAGE_PATTERNS = [
  'enospc',
  'no space left',
  'quota exceeded',
  'quotaexceedederror',
];

/**
 * Scan a string (process output, error message, etc.) for resource-related
 * failure signals and return a classification.
 */
export function detectResourceError(text: string): ResourceErrorType | null {
  const lower = text.toLowerCase();
  if (OOM_PATTERNS.some((p) => lower.includes(p))) return 'oom';
  if (STORAGE_PATTERNS.some((p) => lower.includes(p))) return 'storage';
  return null;
}

export const RESOURCE_ERROR_MESSAGES: Record<
  ResourceErrorType,
  { title: string; description: string }
> = {
  oom: {
    title: 'Ran out of memory',
    description:
      'Package installation failed because your browser ran out of memory. WebContainer needs roughly 1–2 GB of free RAM. Try closing other browser tabs or applications, then reload this page. If the problem persists, try using a computer with more memory.',
  },
  storage: {
    title: 'Not enough storage',
    description:
      'Your browser does not have enough storage to install dependencies. Try clearing site data for this site (Settings → Privacy → Site Data), freeing disk space, or using a different browser profile.',
  },
  boot: {
    title: 'WebContainer failed to start',
    description:
      'Your browser may not have enough resources to run WebContainer. Try closing other tabs, reloading the page, or using a different browser (Chrome or Edge recommended). On low-memory devices this environment may not be able to run.',
  },
};
