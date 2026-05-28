/**
 * Convex deployment admin helpers.
 *
 * Talks to a project's Convex *deployment* HTTP API (NOT the management API in
 * convex-platform.ts) using the deploy key as an admin bearer. The deploy key
 * never enters the sandbox — these helpers run host-side and resolve creds
 * from the project row, exactly like setStripeConvexEnv / scaffoldStripeIntoProject.
 *
 * Endpoints used (verified against a live deployment):
 *   GET  /api/stream_function_logs?cursor=<ms>   → { entries, newCursor }
 *   POST /api/query   { path, args, format }      → { status, value | errorMessage }
 *   POST /api/mutation/ /api/action               → same shape
 *
 * Reads/lists use Convex's built-in system UDFs so no user code needs to be
 * deployed:
 *   _system/cli/tables    { paginationOpts }              → { page: [{name}], ... }
 *   _system/cli/tableData { table, order, paginationOpts } → { page: [doc...], continueCursor, isDone }
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects } from '@/db/schema';

interface ConvexCreds {
  deployUrl: string;
  deployKey: string;
}

/** Resolve the deployment URL + admin/deploy key for a project, or an error. */
export async function resolveConvexCreds(
  projectId: string,
): Promise<{ ok: true; creds: ConvexCreds } | { ok: false; error: string }> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return { ok: false, error: 'Project not found' };
  if (project.backendType === 'none') {
    return { ok: false, error: 'This project has no Convex backend.' };
  }
  const deployUrl =
    project.backendType === 'user' ? project.userConvexUrl : project.convexDeployUrl;
  const deployKey =
    project.backendType === 'user' ? project.userConvexDeployKey : project.convexDeployKey;
  if (!deployUrl || !deployKey) {
    return { ok: false, error: 'Convex deployment is not configured for this project (no URL/key). Deploy the backend first.' };
  }
  return { ok: true, creds: { deployUrl, deployKey } };
}

function authHeaders(deployKey: string): Record<string, string> {
  return { Authorization: `Convex ${deployKey}`, 'Content-Type': 'application/json' };
}

// ───────────────────────── logs ──────────────────────────

export interface ConvexLogEntry {
  /** epoch ms */
  timestampMs: number;
  /** "Query" | "Mutation" | "Action" | "HttpAction" | ... */
  udfType: string | null;
  /** e.g. "products:getProducts" */
  identifier: string | null;
  /** true | false | null (null = a non-completion record) */
  success: boolean | null;
  /** error string when the function threw */
  error: string | null;
  /** console.* output lines emitted during the call */
  logLines: string[];
  executionTimeMs: number | null;
}

export interface GetConvexLogsResult {
  ok: boolean;
  error?: string;
  entries?: ConvexLogEntry[];
  /** Pass back as `cursor` next call to page forward (only newer entries). */
  newCursor?: number;
  truncated?: boolean;
}

/**
 * Fetch recent function-execution logs for a project's Convex deployment.
 *
 * @param opts.cursor    ms cursor from a previous call; omit/0 for the full
 *                       in-memory buffer (deployment keeps a bounded window).
 * @param opts.limit     max entries to return (most recent), default 50.
 * @param opts.onlyErrors return only entries where the function threw.
 */
export async function getConvexLogs(
  projectId: string,
  opts: { cursor?: number; limit?: number; onlyErrors?: boolean } = {},
): Promise<GetConvexLogsResult> {
  const resolved = await resolveConvexCreds(projectId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { deployUrl, deployKey } = resolved.creds;

  const cursor = opts.cursor ?? 0;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

  let res: Response;
  try {
    res = await fetch(
      `${deployUrl}/api/stream_function_logs?cursor=${encodeURIComponent(String(cursor))}`,
      { headers: authHeaders(deployKey) },
    );
  } catch (err) {
    return { ok: false, error: `Failed to reach Convex deployment: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Convex logs returned HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  const data = (await res.json()) as {
    entries?: Array<Record<string, unknown>>;
    newCursor?: number;
  };
  const raw = data.entries ?? [];

  let entries: ConvexLogEntry[] = raw.map((e) => ({
    timestampMs: typeof e.timestamp === 'number' ? Math.round(e.timestamp * 1000) : 0,
    udfType: (e.udfType as string) ?? null,
    identifier: (e.identifier as string) ?? null,
    success: (e.success as boolean | null) ?? null,
    error: (e.error as string | null) ?? null,
    logLines: Array.isArray(e.logLines) ? (e.logLines as unknown[]).map(String) : [],
    executionTimeMs:
      typeof e.executionTime === 'number' ? Math.round(e.executionTime * 1000) : null,
  }));

  if (opts.onlyErrors) {
    entries = entries.filter((e) => e.error != null || e.success === false);
  }

  const truncated = entries.length > limit;
  // Most recent `limit` entries (the buffer is chronological).
  entries = entries.slice(-limit);

  return {
    ok: true,
    entries,
    ...(typeof data.newCursor === 'number' ? { newCursor: data.newCursor } : {}),
    truncated,
  };
}

// ───────────────── data browse + function run (scoped; used by DB tooling) ─────────────────

/** Run a deployed function or a system UDF. type defaults to 'query'. */
export async function runConvexFunction(
  projectId: string,
  opts: { path: string; args?: Record<string, unknown>; type?: 'query' | 'mutation' | 'action' },
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const resolved = await resolveConvexCreds(projectId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { deployUrl, deployKey } = resolved.creds;
  const endpoint = opts.type ?? 'query';

  let res: Response;
  try {
    res = await fetch(`${deployUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: authHeaders(deployKey),
      body: JSON.stringify({ path: opts.path, args: opts.args ?? {}, format: 'json' }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const data = (await res.json().catch(() => null)) as
    | { status?: string; value?: unknown; errorMessage?: string }
    | null;
  if (!res.ok || !data) {
    return { ok: false, error: `Convex ${endpoint} HTTP ${res.status}` };
  }
  if (data.status !== 'success') {
    return { ok: false, error: data.errorMessage ?? `Convex ${endpoint} failed` };
  }
  return { ok: true, value: data.value };
}

/** List the deployment's user tables (uses the built-in _system UDF). */
export async function listConvexTables(
  projectId: string,
): Promise<{ ok: true; tables: string[] } | { ok: false; error: string }> {
  const r = await runConvexFunction(projectId, {
    path: '_system/cli/tables',
    args: { paginationOpts: { numItems: 1000, cursor: null } },
  });
  if (!r.ok) return r;
  const page = (r.value as { page?: Array<{ name: string }> })?.page ?? [];
  return { ok: true, tables: page.map((t) => t.name) };
}

/** Read a page of documents from a table (most-recent first by default). */
export async function readConvexTable(
  projectId: string,
  opts: { table: string; limit?: number; order?: 'asc' | 'desc'; cursor?: string | null },
): Promise<
  | { ok: true; documents: unknown[]; continueCursor: string; isDone: boolean }
  | { ok: false; error: string }
> {
  const r = await runConvexFunction(projectId, {
    path: '_system/cli/tableData',
    args: {
      table: opts.table,
      order: opts.order ?? 'desc',
      paginationOpts: { numItems: Math.max(1, Math.min(opts.limit ?? 20, 200)), cursor: opts.cursor ?? null },
    },
  });
  if (!r.ok) return r;
  const v = r.value as { page?: unknown[]; continueCursor?: string; isDone?: boolean };
  return {
    ok: true,
    documents: v.page ?? [],
    continueCursor: v.continueCursor ?? 'end',
    isDone: v.isDone ?? true,
  };
}

// ───────────────── Tier 2: confirmation-gated direct writes ─────────────────
//
// These use Convex's built-in dashboard mutations (the same ones the Convex
// web dashboard calls), so NO user code needs to be deployed to edit data.
// Exact validator shapes were confirmed against a live deployment:
//   _system/frontend/addDocument        { table: string, documents: any[] }
//   _system/frontend/patchDocumentsFields { table: string, ids: string[], fields: any }
//   _system/frontend/replaceDocument    { id: string, document: any }
//   _system/frontend/deleteDocuments    { toDelete: { id: string, tableName: string }[] }
//
// Every write is GATED: callers must pass `confirmed: true`. Without it we
// return a preview and DO NOT touch the database — the agent is expected to
// show the preview and get explicit user approval (askQuestion) first.

export type ConvexWriteOp = 'insert' | 'patch' | 'replace' | 'delete';

export interface WriteConvexDataInput {
  operation: ConvexWriteOp;
  /** Target table. Required for insert / patch / delete (and used for display on replace). */
  table?: string;
  /** insert: documents to add. */
  documents?: unknown[];
  /** patch: ids of documents to patch. */
  ids?: string[];
  /** patch: fields to merge into each id (same fields applied to all). */
  fields?: Record<string, unknown>;
  /** replace: id of the single document to fully overwrite. */
  id?: string;
  /** replace: the full replacement document. */
  document?: Record<string, unknown>;
  /** Must be true to actually write; otherwise a preview is returned. */
  confirmed?: boolean;
}

export interface WriteConvexDataResult {
  ok: boolean;
  /** 'needs-confirmation' (no write happened) | 'applied' | 'error' */
  status?: 'needs-confirmation' | 'applied' | 'error';
  error?: string;
  /** Human-readable summary of what will / did happen. */
  preview?: string;
  /** When status==='needs-confirmation', what the agent must do next. */
  instruction?: string;
  /** Raw Convex mutation return value on success. */
  result?: unknown;
}

/**
 * Validate + (optionally) execute a direct data write against a project's
 * Convex deployment. Confirmation-gated: returns a preview unless
 * `input.confirmed === true`.
 */
export async function writeConvexData(
  projectId: string,
  input: WriteConvexDataInput,
): Promise<WriteConvexDataResult> {
  const { operation } = input;

  // ── validate per-operation and build a human preview ──
  let preview: string;
  let path: string;
  let args: Record<string, unknown>;

  switch (operation) {
    case 'insert': {
      if (!input.table) return { ok: false, status: 'error', error: 'insert requires `table`.' };
      if (!Array.isArray(input.documents) || input.documents.length === 0) {
        return { ok: false, status: 'error', error: 'insert requires a non-empty `documents` array.' };
      }
      preview = `Insert ${input.documents.length} document(s) into table "${input.table}".`;
      path = '_system/frontend/addDocument';
      args = { table: input.table, documents: input.documents };
      break;
    }
    case 'patch': {
      if (!input.table) return { ok: false, status: 'error', error: 'patch requires `table`.' };
      if (!Array.isArray(input.ids) || input.ids.length === 0) {
        return { ok: false, status: 'error', error: 'patch requires a non-empty `ids` array.' };
      }
      if (!input.fields || typeof input.fields !== 'object' || Object.keys(input.fields).length === 0) {
        return { ok: false, status: 'error', error: 'patch requires a non-empty `fields` object.' };
      }
      preview = `Patch field(s) [${Object.keys(input.fields).join(', ')}] on ${input.ids.length} document(s) in table "${input.table}". Other fields are left unchanged.`;
      path = '_system/frontend/patchDocumentsFields';
      args = { table: input.table, ids: input.ids, fields: input.fields };
      break;
    }
    case 'replace': {
      if (!input.id) return { ok: false, status: 'error', error: 'replace requires `id`.' };
      if (!input.document || typeof input.document !== 'object') {
        return { ok: false, status: 'error', error: 'replace requires a `document` object.' };
      }
      preview = `Replace (full overwrite) document ${input.id}${input.table ? ` in table "${input.table}"` : ''}. Fields not present in the new document will be removed.`;
      path = '_system/frontend/replaceDocument';
      args = { id: input.id, document: input.document };
      break;
    }
    case 'delete': {
      if (!input.table) return { ok: false, status: 'error', error: 'delete requires `table`.' };
      if (!Array.isArray(input.ids) || input.ids.length === 0) {
        return { ok: false, status: 'error', error: 'delete requires a non-empty `ids` array.' };
      }
      preview = `Permanently DELETE ${input.ids.length} document(s) from table "${input.table}". This cannot be undone.`;
      path = '_system/frontend/deleteDocuments';
      args = { toDelete: input.ids.map((id) => ({ id, tableName: input.table })) };
      break;
    }
    default:
      return { ok: false, status: 'error', error: `Unknown operation "${String(operation)}".` };
  }

  // ── confirmation gate: no write until confirmed:true ──
  if (input.confirmed !== true) {
    return {
      ok: true,
      status: 'needs-confirmation',
      preview,
      instruction:
        'This write was NOT performed. Show the user exactly what will change (the preview above), ask for their explicit approval with askQuestion, and only if they approve, call this tool again with the identical arguments plus confirmed: true.',
    };
  }

  // ── execute ──
  const r = await runConvexFunction(projectId, { path, args, type: 'mutation' });
  if (!r.ok) return { ok: false, status: 'error', error: r.error, preview };
  return { ok: true, status: 'applied', preview, result: r.value };
}
