import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getUserCredentials, setUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONVEX_CLI_API = 'https://api.convex.dev/api';

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId, projectName } = await req.json() as { projectId: string; projectName: string };
  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

  const creds = await getUserCredentials(userId);
  if (!creds.convexOAuthAccessToken) {
    return NextResponse.json({ error: 'convex_not_connected', message: 'Please connect your Convex account first.' }, { status: 401 });
  }

  const db = getDb();
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  try {
    // Resolve team slug from stored value or token prefix ("team:<slug>|<jwt>")
    let teamSlug = creds.convexTeamId ?? null;
    if (!teamSlug) {
      const match = creds.convexOAuthAccessToken.match(/^team:([^|]+)\|/);
      if (!match) throw new Error('Cannot determine Convex team from OAuth token');
      teamSlug = match[1];
      await setUserCredentials(userId, { convexTeamId: teamSlug });
    }

    const headers = {
      'Authorization': `Bearer ${creds.convexOAuthAccessToken}`,
      'Content-Type': 'application/json',
    };

    const convexProjectName = projectName
      ? `bf-${projectName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}`
      : `bf-${projectId.slice(0, 8)}`;

    const res = await fetch(`${CONVEX_CLI_API}/create_project`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ team: teamSlug, projectName: convexProjectName, deploymentType: 'prod' }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (errText.includes('ProjectQuotaReached')) {
        return NextResponse.json({
          error: 'convex_quota',
          message: 'Your Convex account has reached its project quota. Delete unused projects at dashboard.convex.dev or upgrade your Convex plan.',
        }, { status: 402 });
      }
      throw new Error(`Convex create_project failed: ${res.status} ${errText}`);
    }

    const data = await res.json() as {
      projectSlug?: string; deploymentName?: string; prodUrl?: string; adminKey?: string;
    };

    if (!data.projectSlug || !data.adminKey) {
      throw new Error('Incomplete create_project response from Convex API');
    }

    const deploymentUrl = data.prodUrl || `https://${data.deploymentName}.convex.cloud`;

    await db.update(projects)
      .set({
        userConvexUrl: deploymentUrl,
        userConvexDeployKey: data.adminKey,
        convexProjectId: data.projectSlug,
        convexDeploymentId: data.deploymentName || '',
        convexDeployUrl: deploymentUrl,
        backendType: 'user',
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    return NextResponse.json({ ok: true, deployUrl: deploymentUrl });
  } catch (e) {
    console.error('Convex BYOC provision failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({
      error: 'provision_failed',
      message: e instanceof Error ? e.message : 'Failed to provision Convex backend.',
    }, { status: 500 });
  }
}
