import type { SessionOptions } from "./swift-preview-session-pool";

const ENGINE = "http://127.0.0.1:17321";
const WORKER = "http://127.0.0.1:17322";
export const COMPANION_MAC_DOWNLOAD = process.env.NEXT_PUBLIC_COMPANION_MAC_URL ||
  "https://github.com/AWKohler/botflow-companion-dist/releases/latest/download/BotflowCompanion.dmg";

export interface SetupCheck {
  code: string;
  ready: boolean;
  title: string;
  hint: string;
  url?: string | null;
}
export interface LocalSimulatorHealth {
  ready: boolean;
  protocolVersion: number;
  xcodeVersion?: string;
  checks: SetupCheck[];
}

async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Companion returned HTTP ${response.status}`);
  }
  return response;
}

export async function inspectLocalSimulator(): Promise<LocalSimulatorHealth> {
  let health: { simulator?: { protocolVersion: number } | null; platform?: string };
  try {
    health = await (await checked(await fetch(`${ENGINE}/botflow/v1/health`, {
      signal: AbortSignal.timeout(8000), cache: "no-store",
    }))).json();
  } catch {
    throw new Error("Open Botflow Companion on this Mac and allow local network access in your browser, then check again.");
  }
  if (!health.simulator || health.simulator.protocolVersion !== 1) {
    throw new Error("Local preview requires an Apple Silicon Mac and the updated Botflow Companion. Install the latest Mac version and reopen it.");
  }
  // The worker starts independently; allow a short cold-start window.
  for (let attempt = 0; ; attempt++) {
    try {
      const report = await (await checked(await fetch(`${WORKER}/health`, {
        signal: AbortSignal.timeout(30000), cache: "no-store",
      }))).json() as LocalSimulatorHealth;
      if (report.protocolVersion !== 1) throw new Error("Update Botflow Companion to use local preview.");
      return report;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
}

let connection: Promise<string> | null = null;
const sessionTokens = new Map<string, string>();
async function token(): Promise<string> {
  if (!connection) {
    connection = (async () => {
      const response = await checked(await fetch(`${WORKER}/connect`, {
        method: "POST", signal: AbortSignal.timeout(8000),
      }));
      return ((await response.json()) as { token: string }).token;
    })();
    connection.catch(() => { connection = null; });
  }
  return connection;
}

async function request(path: string, init: RequestInit = {}, sessionToken?: string): Promise<Response> {
  const response = await fetch(`${WORKER}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${sessionToken ?? await token()}` },
    signal: init.signal ?? AbortSignal.timeout(120000),
  });
  if (response.status === 401) connection = null;
  return checked(response);
}

export function resetLocalConnection(): void { connection = null; }

export async function rebuildLocalSession(projectId: string, sessionId: string): Promise<void> {
  const source = await checked(await fetch(`/api/projects/${projectId}/swift-preview/source`, {
    method: "POST", signal: AbortSignal.timeout(120000), cache: "no-store",
  }));
  await request(`/sessions/${sessionId}/build`, {
    method: "POST", headers: { "Content-Type": "application/gzip" }, body: await source.blob(),
  }, sessionTokens.get(sessionId));
}

export async function endLocalSession(sessionId: string): Promise<void> {
  try {
    await request(`/sessions/${sessionId}`, { method: "DELETE", keepalive: true }, sessionTokens.get(sessionId));
  } finally { sessionTokens.delete(sessionId); }
}

export async function startLocalSession(projectId: string, opts: SessionOptions) {
  const ownerToken = await token();
  const response = await request("/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, deviceModel: opts.deviceModel, orientation: opts.orientation,
      codec: "VideoDecoder" in window ? "h264" : "jpeg" }),
  }, ownerToken);
  const session = await response.json() as { sessionId: string; wsUrl: string };
  sessionTokens.set(session.sessionId, ownerToken);
  try {
    await rebuildLocalSession(projectId, session.sessionId);
    return { ...session, provider: "local" as const };
  } catch (error) {
    await endLocalSession(session.sessionId).catch(() => undefined);
    throw error;
  }
}
