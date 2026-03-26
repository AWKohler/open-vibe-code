import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { provisionConvexBackend } from '@/lib/convex-platform';
import { getUserTierAndLimits } from '@/lib/tier';
import { getUserCredentials, setUserCredentials } from '@/lib/user-credentials';

export async function GET(request: Request) {
  const { userId, redirectToSignIn } = await auth();
  const url = new URL(request.url);
  const prompt = url.searchParams.get('prompt')?.slice(0, 30000) ?? '';
  const visibility = url.searchParams.get('visibility') ?? 'public';
  const platformParam = url.searchParams.get('platform');
  const platform = (
    platformParam === 'mobile' ? 'mobile' :
    platformParam === 'multiplatform' ? 'multiplatform' :
    'web'
  ) as 'web' | 'mobile' | 'multiplatform';
  const backendTypeParam = url.searchParams.get('backendType');
  const modelParam = url.searchParams.get('model');
  const model = (
    modelParam === 'gpt-5.3-codex' ? 'gpt-5.3-codex' :
    modelParam === 'gpt-5.4' ? 'gpt-5.4' :
    modelParam === 'gpt-5.2' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'gpt-4.1' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'claude-sonnet-4.6' ? 'claude-sonnet-4.6' :
    modelParam === 'claude-sonnet-4.5' ? 'claude-sonnet-4.6' : // migrate legacy
    modelParam === 'claude-haiku-4.5' ? 'claude-sonnet-4.6' : // removed model
    modelParam === 'claude-opus-4.6' ? 'claude-opus-4.6' :
    modelParam === 'claude-opus-4.5' ? 'claude-opus-4.6' : // migrate legacy
    modelParam === 'kimi-k2.5' ? 'fireworks-minimax-m2p5' : // removed model
    modelParam === 'kimi-k2-thinking-turbo' ? 'fireworks-minimax-m2p5' : // removed model
    modelParam === 'fireworks-minimax-m2p5' ? 'fireworks-minimax-m2p5' :
    modelParam === 'fireworks-glm-5' ? 'fireworks-glm-5' :
    'gpt-5.3-codex'
  ) as 'gpt-5.3-codex' | 'gpt-5.4' | 'claude-sonnet-4.6' | 'claude-opus-4.6' | 'fireworks-minimax-m2p5' | 'fireworks-glm-5';

  if (!userId) {
    return redirectToSignIn({ returnBackUrl: request.url });
  }

  try {
    const db = getDb();
    const requestedName = url.searchParams.get('name');
    const name = requestedName?.trim()
      ? requestedName.trim().slice(0, 48)
      : prompt?.trim()
        ? prompt.slice(0, 48)
        : 'New Project';

    // Determine backend type from URL param
    const backendType = backendTypeParam === 'user' ? 'user' : 'platform';
    console.log(`[START] backendTypeParam=${backendTypeParam}, resolved backendType=${backendType}, userId=${userId}`);

    const [project] = await db
      .insert(projects)
      .values({ name, userId, platform, model, backendType })
      .returning();

    if (backendType === 'user') {
      // BYOC: provision in the user's own Convex account via their OAuth token
      console.log(`[START] BYOC branch entered for project ${project.id}`);
      try {
        const creds = await getUserCredentials(userId);
        console.log(`[START] OAuth token present: ${!!creds.convexOAuthAccessToken}, token prefix: ${creds.convexOAuthAccessToken?.slice(0, 20)}..., stored teamId: ${creds.convexTeamId}`);
        if (creds.convexOAuthAccessToken) {
          // The Convex CLI uses /api/ endpoints (not /v1/) with OAuth access tokens.
          // /v1/ is the Platform Management API for team tokens only.
          const CONVEX_API = 'https://api.convex.dev/api';
          const oauthHeaders = {
            'Authorization': `Bearer ${creds.convexOAuthAccessToken}`,
            'Content-Type': 'application/json',
          };

          // Step 1: Get the team slug
          // Team-scoped OAuth tokens have format: "team:<slug>|<jwt>"
          let teamSlug: string | null = creds.convexTeamId ?? null;

          if (!teamSlug) {
            const tokenStr = creds.convexOAuthAccessToken!;
            const teamMatch = tokenStr.match(/^team:([^|]+)\|/);
            if (teamMatch) {
              teamSlug = teamMatch[1];
              console.log(`[START] Extracted team slug from token: ${teamSlug}`);
            } else {
              // Fallback: try GET /api/teams (works for user-level tokens)
              console.log('[START] Token not team-prefixed, trying GET /api/teams...');
              const teamsRes = await fetch(`${CONVEX_API}/teams`, {
                method: 'GET',
                headers: oauthHeaders,
              });
              const teamsResText = await teamsRes.text();
              console.log(`[START] GET /api/teams response: status=${teamsRes.status}, body=${teamsResText.slice(0, 500)}`);

              if (!teamsRes.ok) {
                throw new Error(`Failed to get teams: ${teamsRes.status} ${teamsResText}`);
              }

              const teams = JSON.parse(teamsResText) as Array<{ id: number; slug: string; name: string }>;
              if (teams.length === 0) {
                throw new Error('No teams found for this Convex account');
              }
              teamSlug = teams[0].slug;
            }

            // Store for future use
            await setUserCredentials(userId, { convexTeamId: teamSlug });
          }

          console.log(`[START] Using team slug: ${teamSlug}`);

          // Step 2: Create project in user's team
          const convexProjectName = `bf-${name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}`;
          const createRes = await fetch(`${CONVEX_API}/create_project`, {
            method: 'POST',
            headers: oauthHeaders,
            body: JSON.stringify({
              team: teamSlug,
              projectName: convexProjectName,
              deploymentType: 'prod',
            }),
          });
          if (!createRes.ok) {
            const errText = await createRes.text();
            throw new Error(`Failed to create project: ${createRes.status} ${errText}`);
          }

          const createData = await createRes.json() as {
            projectSlug?: string;
            teamSlug?: string;
            projectsRemaining?: number;
          };
          console.log(`[START] create_project response:`, JSON.stringify(createData).slice(0, 500));

          const projectSlug = createData.projectSlug;
          if (!projectSlug) {
            throw new Error('No projectSlug in create_project response: ' + JSON.stringify(createData));
          }

          // Step 3: Provision a prod deployment and get admin key
          const provisionRes = await fetch(`${CONVEX_API}/deployment/provision_and_authorize`, {
            method: 'POST',
            headers: oauthHeaders,
            body: JSON.stringify({
              teamSlug,
              projectSlug,
              deploymentType: 'prod',
            }),
          });
          if (!provisionRes.ok) {
            const errText = await provisionRes.text();
            throw new Error(`Failed to provision deployment: ${provisionRes.status} ${errText}`);
          }

          const provisionData = await provisionRes.json() as {
            adminKey?: string;
            url?: string;
            deploymentName?: string;
          };
          console.log(`[START] provision_and_authorize response:`, JSON.stringify({
            ...provisionData,
            adminKey: provisionData.adminKey ? `${provisionData.adminKey.slice(0, 20)}...` : null,
          }).slice(0, 500));

          const deploymentName = provisionData.deploymentName;
          const deploymentUrl = provisionData.url || `https://${deploymentName}.convex.cloud`;
          const deployKey = provisionData.adminKey || '';

          await db.update(projects)
            .set({
              userConvexUrl: deploymentUrl,
              userConvexDeployKey: deployKey,
              convexProjectId: projectSlug,
              convexDeploymentId: deploymentName || '',
              convexDeployUrl: deploymentUrl,
              backendType: 'user',
              updatedAt: new Date(),
            })
            .where(eq(projects.id, project.id));

          console.log(`[START] BYOC Convex provisioned for project ${project.id} in user's account: ${deploymentUrl}`);
        } else {
          console.error('[START] BYOC requested but no Convex OAuth token found for user');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('ProjectQuotaReached')) {
          console.error('[START] User Convex quota reached:', msg);
          const errUrl = new URL('/', request.url);
          errUrl.searchParams.set('error', 'convex_quota');
          return NextResponse.redirect(errUrl);
        }
        console.error('[START] BYOC provisioning FAILED:', error);
      }
    } else {
      // Platform-managed: provision under our account
      console.log(`[START] Platform branch entered for project ${project.id}`);
      const limits = await getUserTierAndLimits(userId);
      const cloudConvexForAll = process.env.ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
      console.log(`[START] tier=${limits.tier}, cloudConvexForAll=${cloudConvexForAll}`);
      if (cloudConvexForAll || limits.tier !== 'free') {
        try {
          const convexProjectName = `ide-${project.id.slice(0, 8)}`;
          const convex = await provisionConvexBackend(convexProjectName);

          await db.update(projects)
            .set({
              convexProjectId: convex.projectId,
              convexDeploymentId: convex.deploymentId,
              convexDeployUrl: convex.deployUrl,
              convexDeployKey: convex.deployKey,
              updatedAt: new Date(),
            })
            .where(eq(projects.id, project.id));

          console.log(`Convex backend provisioned for project ${project.id}: ${convex.deployUrl}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('ProjectQuotaReached')) {
            console.error('Convex quota reached, cannot create project:', msg);
            const errUrl = new URL('/', request.url);
            errUrl.searchParams.set('error', 'convex_quota');
            return NextResponse.redirect(errUrl);
          }
          console.error('Failed to provision Convex backend:', error);
        }
      }
    }

    // Redirect to workspace and pass starter prompt for auto-run
    const workspaceUrl = new URL(`${url.origin}/workspace/${project.id}`);
    if (prompt) workspaceUrl.searchParams.set('prompt', prompt);
    workspaceUrl.searchParams.set('platform', platform);
    workspaceUrl.searchParams.set('model', model);
    if (visibility) workspaceUrl.searchParams.set('visibility', visibility);
    return NextResponse.redirect(workspaceUrl);
  } catch (err) {
    console.error('Failed to start project:', err);
    return NextResponse.redirect(new URL('/', request.url));
  }
}
