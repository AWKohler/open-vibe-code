// In-memory map of simulator sessionId → {userId, projectId}. Used by the
// swift-preview rebuild/release endpoints to authorize follow-up calls without
// chasing the controller for ownership data.
//
// Trade-off: lost on Next.js function cold-start. Acceptable for PoC — the
// controller GCs orphaned sessions after their browser WS disconnects.

interface Ownership {
  userId: string;
  projectId: string;
  createdAt: number;
}

const store = new Map<string, Ownership>();

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

let sweeper: NodeJS.Timeout | null = null;
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, o] of store) {
      if (now - o.createdAt > TTL_MS) store.delete(sid);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

export function recordSwiftPreviewSession(
  sessionId: string,
  userId: string,
  projectId: string,
): void {
  ensureSweeper();
  store.set(sessionId, { userId, projectId, createdAt: Date.now() });
}

/** Returns true iff the store has a positive record matching. */
export function ownsSwiftPreviewSession(
  sessionId: string,
  userId: string,
  projectId: string,
): boolean {
  const o = store.get(sessionId);
  if (!o) return false;
  return o.userId === userId && o.projectId === projectId;
}

/** Returns true if the store knows about this session (regardless of owner). */
export function hasSwiftPreviewSession(sessionId: string): boolean {
  return store.has(sessionId);
}

export function dropSwiftPreviewSession(sessionId: string): void {
  store.delete(sessionId);
}
