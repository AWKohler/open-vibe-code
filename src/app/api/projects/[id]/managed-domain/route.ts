import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects, userDomains } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getUserTierAndLimits } from '@/lib/tier';
import {
  attachPagesCustomDomain,
  detachPagesCustomDomain,
  upsertDnsRecord,
  deleteDnsRecord,
  listDnsRecords,
} from '@/lib/cloudflare-zones';

async function getProject(userId: string, projectId: string) {
  const db = getDb();
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return p ?? null;
}

// POST /api/projects/[id]/managed-domain { domainId, subdomain? }
// Attach a managed domain (and optional subdomain) to this project's CF Pages site.
//   subdomain: "" or "@" → apex (myapp.com)
//              "www"      → www.myapp.com (default)
//              "app"      → app.myapp.com
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: projectId } = await params;
  const project = await getProject(userId, projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (!project.cloudflareProjectName) {
    return NextResponse.json(
      { error: 'Project is not published. Publish first, then assign a domain.' },
      { status: 400 },
    );
  }

  const limits = await getUserTierAndLimits(userId);
  if (!limits.managedDomains) {
    return NextResponse.json({ error: 'Managed domains require Pro or Max.', upgrade: true }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { domainId?: string; subdomain?: string };
  if (!body.domainId) {
    return NextResponse.json({ error: 'domainId required' }, { status: 400 });
  }

  const db = getDb();
  const [domain] = await db
    .select()
    .from(userDomains)
    .where(and(eq(userDomains.id, body.domainId), eq(userDomains.userId, userId)))
    .limit(1);
  if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
  if (domain.status !== 'active' || !domain.cfZoneId) {
    return NextResponse.json(
      { error: 'Domain is not active yet. Update your registrar nameservers and wait for activation.' },
      { status: 400 },
    );
  }

  const sub = (body.subdomain ?? 'www').trim().toLowerCase();
  const hostname = !sub || sub === '@' || sub === domain.apexDomain
    ? domain.apexDomain
    : sub.endsWith(`.${domain.apexDomain}`)
      ? sub
      : `${sub}.${domain.apexDomain}`;

  // If the project was previously attached to a different managed hostname, detach first.
  if (project.managedDomainHostname && project.managedDomainHostname !== hostname) {
    await detachPagesCustomDomain(project.cloudflareProjectName, project.managedDomainHostname).catch(() => {});
  }

  // Create the DNS record in the user's managed zone.
  // For apex (root) we use a proxied CNAME to *.pages.dev — CF supports CNAME flattening.
  // For subdomain we use a regular proxied CNAME.
  const pagesTarget = `${project.cloudflareProjectName}.pages.dev`;
  const recordName = hostname === domain.apexDomain ? '@' : hostname.replace(`.${domain.apexDomain}`, '');
  try {
    await upsertDnsRecord(domain.cfZoneId, {
      type: 'CNAME',
      name: recordName,
      content: pagesTarget,
      proxied: true,
      ttl: 1,
      comment: 'Managed by Botflow',
    });
  } catch (err) {
    return NextResponse.json(
      { error: `DNS record creation failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // Tell CF Pages about the custom hostname so it provisions a cert + routes traffic.
  try {
    await attachPagesCustomDomain(project.cloudflareProjectName, hostname);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to attach domain to Pages project: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const deploymentUrl = `https://${hostname}`;
  await db
    .update(projects)
    .set({
      managedDomainId: domain.id,
      managedDomainHostname: hostname,
      cloudflareDeploymentUrl: deploymentUrl,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id));

  return NextResponse.json({ ok: true, hostname, url: deploymentUrl });
}

// DELETE — detach managed domain from this project.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: projectId } = await params;
  const project = await getProject(userId, projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (!project.managedDomainId || !project.managedDomainHostname) {
    return NextResponse.json({ ok: true }); // nothing to do
  }

  const db = getDb();
  const [domain] = await db
    .select()
    .from(userDomains)
    .where(eq(userDomains.id, project.managedDomainId))
    .limit(1);

  if (domain?.cfZoneId) {
    // Detach the Pages binding.
    if (project.cloudflareProjectName) {
      await detachPagesCustomDomain(project.cloudflareProjectName, project.managedDomainHostname).catch(() => {});
    }
    // Remove the CNAME record we created.
    try {
      const records = await listDnsRecords(domain.cfZoneId);
      const recordName = project.managedDomainHostname; // fully-qualified in CF
      const match = records.find(
        (r) => r.type === 'CNAME' && r.name === recordName && r.content.endsWith('.pages.dev'),
      );
      if (match) await deleteDnsRecord(domain.cfZoneId, match.id).catch(() => {});
    } catch { /* best-effort cleanup */ }
  }

  await db
    .update(projects)
    .set({
      managedDomainId: null,
      managedDomainHostname: null,
      cloudflareDeploymentUrl: project.cloudflareProjectName ? `https://${project.cloudflareProjectName}.pages.dev` : null,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id));

  return NextResponse.json({ ok: true });
}
