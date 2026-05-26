/**
 * Cloudflare Zones API helpers — used by the managed-domains feature.
 *
 * Requires CLOUDFLARE_API_TOKEN to have Zone:Edit + Zone:Read + DNS:Edit
 * scopes (in addition to the Pages scopes the publish flow needs).
 */

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export interface CfResult<T> {
  result: T;
  result_info?: unknown;
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
}

function getCfConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set');
  }
  return { accountId, apiToken };
}

async function cfFetch<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<CfResult<T>> {
  const { apiToken } = getCfConfig();
  const headers: Record<string, string> = { Authorization: `Bearer ${apiToken}` };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(CF_BASE + path, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  });
  return (await res.json()) as CfResult<T>;
}

export type ZoneStatus = 'initializing' | 'pending' | 'active' | 'moved' | 'deactivated' | 'read only';

export interface CfZone {
  id: string;
  name: string;
  status: ZoneStatus;
  name_servers: string[];
  original_name_servers?: string[];
  paused: boolean;
  type: string;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied: boolean;
  zone_id: string;
}

export interface CreateDnsRecordInput {
  type: string;
  name: string;
  content: string;
  ttl?: number;     // 1 = auto
  priority?: number; // MX only
  proxied?: boolean;
  comment?: string;
}

export type UpdateDnsRecordInput = Partial<CreateDnsRecordInput>;

// ─── Zones ────────────────────────────────────────────────────────────────

/** Create a new zone (apex domain) under the configured CF account. */
export async function createZone(apexDomain: string): Promise<CfZone> {
  const { accountId } = getCfConfig();
  const res = await cfFetch<CfZone>('/zones', {
    body: {
      name: apexDomain,
      account: { id: accountId },
      type: 'full',
    },
  });
  if (!res.success) {
    // 1061 = "An A, AAAA, or CNAME record with that host already exists"
    // 1097 = "Invalid zone name"
    // 1099 = zone already exists in another account
    throw new Error(`CF createZone failed: ${JSON.stringify(res.errors)}`);
  }
  return res.result;
}

export async function getZone(zoneId: string): Promise<CfZone> {
  const res = await cfFetch<CfZone>(`/zones/${zoneId}`);
  if (!res.success) throw new Error(`CF getZone failed: ${JSON.stringify(res.errors)}`);
  return res.result;
}

export async function deleteZone(zoneId: string): Promise<void> {
  const res = await cfFetch(`/zones/${zoneId}`, { method: 'DELETE' });
  if (!res.success) {
    // ignore 81044 (zone not found / already deleted)
    const onlyMissing = res.errors?.every(e => e.code === 81044 || e.code === 7003);
    if (!onlyMissing) throw new Error(`CF deleteZone failed: ${JSON.stringify(res.errors)}`);
  }
}

/** Ask CF to re-check the registrar's NS records and activate the zone. */
export async function activationCheck(zoneId: string): Promise<void> {
  await cfFetch(`/zones/${zoneId}/activation_check`, { method: 'PUT' });
  // Best-effort — ignore failures; status will still update on next getZone.
}

// ─── DNS records ──────────────────────────────────────────────────────────

export async function listDnsRecords(zoneId: string): Promise<CfDnsRecord[]> {
  // CF paginates by default at 100 — plenty for our use case.
  const res = await cfFetch<CfDnsRecord[]>(`/zones/${zoneId}/dns_records?per_page=100`);
  if (!res.success) throw new Error(`CF listDnsRecords failed: ${JSON.stringify(res.errors)}`);
  return res.result;
}

export async function createDnsRecord(zoneId: string, input: CreateDnsRecordInput): Promise<CfDnsRecord> {
  const res = await cfFetch<CfDnsRecord>(`/zones/${zoneId}/dns_records`, { body: input });
  if (!res.success) throw new Error(`CF createDnsRecord failed: ${JSON.stringify(res.errors)}`);
  return res.result;
}

export async function updateDnsRecord(
  zoneId: string,
  recordId: string,
  input: UpdateDnsRecordInput,
): Promise<CfDnsRecord> {
  const res = await cfFetch<CfDnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PATCH',
    body: input,
  });
  if (!res.success) throw new Error(`CF updateDnsRecord failed: ${JSON.stringify(res.errors)}`);
  return res.result;
}

export async function deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
  const res = await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  if (!res.success) {
    const onlyMissing = res.errors?.every(e => e.code === 81044 || e.code === 81012);
    if (!onlyMissing) throw new Error(`CF deleteDnsRecord failed: ${JSON.stringify(res.errors)}`);
  }
}

/** Upsert: find a record matching {type,name}, update its content/ttl/proxied; create if missing. */
export async function upsertDnsRecord(zoneId: string, input: CreateDnsRecordInput): Promise<CfDnsRecord> {
  const all = await listDnsRecords(zoneId);
  const fullName = input.name.includes('.') ? input.name : input.name; // CF stores fully-qualified
  const match = all.find(r => r.type === input.type && (r.name === fullName || r.name.startsWith(input.name + '.')));
  if (match) return updateDnsRecord(zoneId, match.id, input);
  return createDnsRecord(zoneId, input);
}

// ─── Pages custom-domain attach ───────────────────────────────────────────
// Attach a managed hostname to a CF Pages project so the SSL cert + routing
// just work. This is the bit that hooks a user's managed domain to their
// deployed app.
export async function attachPagesCustomDomain(pagesProjectName: string, hostname: string): Promise<void> {
  const { accountId } = getCfConfig();
  const res = await cfFetch(`/accounts/${accountId}/pages/projects/${pagesProjectName}/domains`, {
    body: { name: hostname },
  });
  if (!res.success) {
    // 8000040 = "domain already attached" — treat as success
    const ok = res.errors?.some(e => e.code === 8000040 || e.message?.toLowerCase().includes('already'));
    if (!ok) throw new Error(`CF attachPagesCustomDomain failed: ${JSON.stringify(res.errors)}`);
  }
}

export async function detachPagesCustomDomain(pagesProjectName: string, hostname: string): Promise<void> {
  const { accountId } = getCfConfig();
  const res = await cfFetch(
    `/accounts/${accountId}/pages/projects/${pagesProjectName}/domains/${encodeURIComponent(hostname)}`,
    { method: 'DELETE' },
  );
  if (!res.success) {
    const ok = res.errors?.every(e => e.code === 8000007 || e.code === 8000040);
    if (!ok) {
      // Non-fatal — log only.
      console.warn(`CF detachPagesCustomDomain warn: ${JSON.stringify(res.errors)}`);
    }
  }
}
