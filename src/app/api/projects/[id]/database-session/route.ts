import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const [proj] = await db.select().from(projects).where(eq(projects.id, id));

  if (!proj || proj.userId !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Resolve Convex URL and key — prefer user (BYOC) fields, fall back to platform fields
  const deploymentUrl = proj.userConvexUrl || proj.convexDeployUrl;
  const adminKey = proj.userConvexDeployKey || proj.convexDeployKey;
  const deploymentName = proj.convexDeploymentId;

  if (!deploymentUrl || !adminKey) {
    return NextResponse.json({ error: 'No Convex backend for this project' }, { status: 404 });
  }

  return NextResponse.json({
    deploymentUrl,
    deploymentName,
    adminKey,
  });
}
