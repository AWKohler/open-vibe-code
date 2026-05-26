import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { userDomains } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getUserTierAndLimits } from '@/lib/tier';
import { createZone } from '@/lib/cloudflare-zones';

// GET /api/domains — list user's managed domains
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const rows = await db
    .select()
    .from(userDomains)
    .where(eq(userDomains.userId, userId))
    .orderBy(desc(userDomains.createdAt));

  const limits = await getUserTierAndLimits(userId);
  return NextResponse.json({
    domains: rows,
    canAdd: limits.managedDomains && rows.length < limits.maxManagedDomains,
    tier: limits.tier,
    managedDomainsEnabled: limits.managedDomains,
    maxManagedDomains: limits.maxManagedDomains,
  });
}

// POST /api/domains { apexDomain } — create new zone in CF, return nameservers
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limits = await getUserTierAndLimits(userId);
  if (!limits.managedDomains) {
    return NextResponse.json(
      { error: 'Managed domains require a Pro or Max plan.', upgrade: true },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { apexDomain?: string };
  const raw = (body.apexDomain ?? '').trim().toLowerCase();
  // Strip protocol, leading "www.", trailing slashes.
  const apex = raw
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(apex)) {
    return NextResponse.json({ error: 'Invalid domain name' }, { status: 400 });
  }

  const db = getDb();
  const existing = await db.select().from(userDomains).where(eq(userDomains.userId, userId));
  if (existing.length >= limits.maxManagedDomains) {
    return NextResponse.json(
      { error: `You've reached your managed-domain limit (${limits.maxManagedDomains}).` },
      { status: 403 },
    );
  }
  if (existing.some((d) => d.apexDomain === apex)) {
    return NextResponse.json({ error: 'Domain already added.' }, { status: 409 });
  }

  let zone;
  try {
    zone = await createZone(apex);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const [row] = await db
    .insert(userDomains)
    .values({
      userId,
      apexDomain: apex,
      cfZoneId: zone.id,
      status: zone.status === 'active' ? 'active' : 'pending_ns',
      nameservers: zone.name_servers,
    })
    .returning();

  return NextResponse.json({ domain: row });
}
