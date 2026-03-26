import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getUserCredentials, setUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// OAuth tokens use the /api/ endpoints (CLI API), NOT /v1/ (Platform Management API)
const CONVEX_API = 'https://api.convex.dev/api';

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
    // Step 1: get the team slug
    let teamSlug: string | null = creds.convexTeamId ?? null;

    if (!teamSlug) {
      // Team-scoped OAuth tokens have format: "team:<slug>|<jwt>"
      const tokenStr = creds.convexOAuthAccessToken!;
      const teamMatch = tokenStr.match(/^team:([^|]+)\|/);
      if (teamMatch) {
        teamSlug = teamMatch[1];
      } else {
        // Fallback: try GET /api/teams (works for user-level tokens)
        const teamsRes = await fetch(`${CONVEX_API}/teams`, {
          method: 'GET',
          headers,
        });
        if (teamsRes.status === 401) {
          return NextResponse.json({ error: 'convex_token_revoked', message: 'Your Convex connection has expired. Please reconnect.' }, { status: 401 });
        }
        if (!teamsRes.ok) {
          const errText = await teamsRes.text();
          throw new Error(`Failed to get teams: ${teamsRes.status} ${errText}`);
        }

        const teams = await teamsRes.json() as Array<{ id: number; slug: string; name: string }>;
        if (teams.length === 0) {
          throw new Error('No teams found for this Convex account');
        }
        teamSlug = teams[0].slug;
      }
      await setUserCredentials(userId, { convexTeamId: teamSlug });
    }

    // Step 2: create a project in user's team
    const convexProjectName = projectName ? `bf-${projectName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}` : `bf-${projectId.slice(0, 8)}`;
    const createRes = await fetch(`${CONVEX_API}/create_project`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        team: teamSlug,
        projectName: convexProjectName,
        deploymentType: 'prod',
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      if (errText.includes('ProjectQuotaReached')) {
        return NextResponse.json({ error: 'convex_quota', message: 'Your Convex account has reached its project quota. Delete unused projects at dashboard.convex.dev or upgrade your Convex plan.' }, { status: 402 });
      }
      throw new Error(`Failed to create project: ${createRes.status} ${errText}`);
    }

    const createData = await createRes.json() as {
      projectSlug?: string;
      teamSlug?: string;
      projectsRemaining?: number;
      deploymentName?: string;
      prodUrl?: string;
      adminKey?: string;
    };

    const projectSlug = createData.projectSlug;
    if (!projectSlug) {
      throw new Error('No projectSlug in create_project response: ' + JSON.stringify(createData));
    }

    // create_project with deploymentType already provisions the deployment
    const deploymentName = createData.deploymentName || '';
    const deploymentUrl = createData.prodUrl || `https://${deploymentName}.convex.cloud`;
    const deployKey = createData.adminKey || '';

    // Step 4: update the project
    await db.update(projects)
      .set({
        userConvexUrl: deploymentUrl,
        userConvexDeployKey: deployKey,
        convexProjectId: projectSlug,
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
