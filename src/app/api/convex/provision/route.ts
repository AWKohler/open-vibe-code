import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONVEX_API_BASE = 'https://api.convex.dev/v1';

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

  const headers = {
    'Authorization': `Bearer ${creds.convexOAuthAccessToken}`,
    'Content-Type': 'application/json',
  };

  try {
    // Step 1: get the team this OAuth token is scoped to
    const teamRes = await fetch(`${CONVEX_API_BASE}/get_team`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    if (!teamRes.ok) {
      if (teamRes.status === 401) {
        return NextResponse.json({ error: 'convex_token_revoked', message: 'Your Convex connection has expired. Please reconnect.' }, { status: 401 });
      }
      const errText = await teamRes.text();
      throw new Error(`Failed to get team: ${teamRes.status} ${errText}`);
    }
    const team = await teamRes.json() as { id: number; slug: string; name: string };

    // Step 2: create a project in user's team
    const convexProjectName = projectName ? `bf-${projectName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}` : `bf-${projectId.slice(0, 8)}`;
    const createRes = await fetch(`${CONVEX_API_BASE}/teams/${team.id}/create_project`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectName: convexProjectName, deploymentType: 'prod' }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      if (errText.includes('ProjectQuotaReached')) {
        return NextResponse.json({ error: 'convex_quota', message: 'Your Convex account has reached its project quota. Delete unused projects at dashboard.convex.dev or upgrade your Convex plan.' }, { status: 402 });
      }
      throw new Error(`Failed to create project: ${createRes.status} ${errText}`);
    }

    const createData = await createRes.json();
    const deployment = createData.prodDeployment || createData.deployment || createData;
    const createdProject = createData.project || createData;

    const deploymentName = deployment.name || deployment.deploymentName;
    const deploymentUrl = `https://${deploymentName}.convex.cloud`;
    const convexProjectId = String(createdProject.id || createdProject.projectId);

    // Step 3: create a deploy key
    const keyRes = await fetch(`${CONVEX_API_BASE}/deployments/${deploymentName}/create_deploy_key`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: `botflow-${Date.now()}` }),
    });

    if (!keyRes.ok) {
      const errText = await keyRes.text();
      throw new Error(`Failed to create deploy key: ${keyRes.status} ${errText}`);
    }

    const keyData = await keyRes.json();
    const deployKey = keyData.key || keyData.deployKey || keyData.accessToken || '';

    // Step 4: update the project
    await db.update(projects)
      .set({
        userConvexUrl: deploymentUrl,
        userConvexDeployKey: deployKey,
        convexProjectId,
        convexDeploymentId: deploymentName,
        convexDeployUrl: deploymentUrl,
        backendType: 'user',
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    return NextResponse.json({ ok: true, deployUrl: deploymentUrl });
  } catch (e) {
    console.error('Convex provision via OAuth failed:', e);
    return NextResponse.json({ error: 'provision_failed', message: e instanceof Error ? e.message : 'Failed to provision Convex backend.' }, { status: 500 });
  }
}
