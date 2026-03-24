import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { provisionConvexBackend } from '@/lib/convex-platform';
import { getUserTierAndLimits } from '@/lib/tier';
import { getUserCredentials } from '@/lib/user-credentials';

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

    const [project] = await db
      .insert(projects)
      .values({ name, userId, platform, model, backendType })
      .returning();

    if (backendType === 'user') {
      // BYOC: provision in the user's own Convex account via their OAuth token
      try {
        const creds = await getUserCredentials(userId);
        if (creds.convexOAuthAccessToken) {
          const CONVEX_API = 'https://api.convex.dev/v1';
          const oauthHeaders = {
            'Authorization': `Bearer ${creds.convexOAuthAccessToken}`,
            'Content-Type': 'application/json',
          };

          // Get user's teams
          const teamsRes = await fetch(`${CONVEX_API}/teams`, { headers: oauthHeaders });
          if (!teamsRes.ok) throw new Error(`Failed to get teams: ${teamsRes.status}`);
          const teams = await teamsRes.json() as Array<{ id: number }>;
          if (!teams.length) throw new Error('No Convex teams found');
          const team = teams[0];

          // Create project in user's team
          const convexProjectName = `bf-${name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}`;
          const createRes = await fetch(`${CONVEX_API}/teams/${team.id}/create_project`, {
            method: 'POST',
            headers: oauthHeaders,
            body: JSON.stringify({ projectName: convexProjectName, deploymentType: 'prod' }),
          });
          if (!createRes.ok) {
            const errText = await createRes.text();
            throw new Error(`Failed to create project: ${createRes.status} ${errText}`);
          }

          const createData = await createRes.json();
          const deployment = createData.prodDeployment || createData.deployment || createData;
          const createdProject = createData.project || createData;
          const deploymentName = deployment.name || deployment.deploymentName;
          const deploymentUrl = `https://${deploymentName}.convex.cloud`;
          const convexProjectId = String(createdProject.id || createdProject.projectId);

          // Create deploy key
          const keyRes = await fetch(`${CONVEX_API}/deployments/${deploymentName}/create_deploy_key`, {
            method: 'POST',
            headers: oauthHeaders,
            body: JSON.stringify({ name: `botflow-${Date.now()}` }),
          });
          if (!keyRes.ok) throw new Error(`Failed to create deploy key: ${keyRes.status}`);
          const keyData = await keyRes.json();
          const deployKey = keyData.key || keyData.deployKey || keyData.accessToken || '';

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
            .where(eq(projects.id, project.id));

          console.log(`BYOC Convex provisioned for project ${project.id} in user's account: ${deploymentUrl}`);
        } else {
          console.error('BYOC requested but no Convex OAuth token found for user');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('ProjectQuotaReached')) {
          console.error('User Convex quota reached:', msg);
          const errUrl = new URL('/', request.url);
          errUrl.searchParams.set('error', 'convex_quota');
          return NextResponse.redirect(errUrl);
        }
        console.error('Failed to provision BYOC Convex backend:', error);
      }
    } else {
      // Platform-managed: provision under our account
      const limits = await getUserTierAndLimits(userId);
      const cloudConvexForAll = process.env.ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
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
