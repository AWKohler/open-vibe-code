import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { provisionConvexBackend } from '@/lib/convex-platform';
import { getUserTierAndLimits } from '@/lib/tier';
import { getUserCredentials, setUserCredentials, type UserCredentials } from '@/lib/user-credentials';
import { normalizeProjectPlatform, type ProjectPlatform } from '@/lib/project-platform';

const CONVEX_CLI_API = 'https://api.convex.dev/api';

/**
 * Resolve the Convex team slug from stored credentials or the OAuth token.
 * Team-scoped tokens have format "team:<slug>|<jwt>".
 */
function resolveTeamSlug(creds: UserCredentials): string | null {
  if (creds.convexTeamId) return creds.convexTeamId;
  const match = creds.convexOAuthAccessToken?.match(/^team:([^|]+)\|/);
  return match ? match[1] : null;
}

/**
 * Provision a Convex project in the user's own account via their OAuth token.
 * Uses the Convex CLI API (/api/) which accepts OAuth access tokens.
 */
async function provisionUserConvex(
  creds: UserCredentials,
  projectDisplayName: string,
  userId: string,
): Promise<{ projectSlug: string; deploymentName: string; deploymentUrl: string; adminKey: string }> {
  const teamSlug = resolveTeamSlug(creds);
  if (!teamSlug) throw new Error('Cannot determine Convex team from OAuth token');

  // Cache team slug for future requests
  if (!creds.convexTeamId) {
    await setUserCredentials(userId, { convexTeamId: teamSlug });
  }

  const headers = {
    'Authorization': `Bearer ${creds.convexOAuthAccessToken}`,
    'Content-Type': 'application/json',
  };

  const convexProjectName = `bf-${projectDisplayName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}`;
  const res = await fetch(`${CONVEX_CLI_API}/create_project`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ team: teamSlug, projectName: convexProjectName, deploymentType: 'prod' }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Convex create_project failed: ${res.status} ${errText}`);
  }

  const data = await res.json() as {
    projectSlug?: string; deploymentName?: string; prodUrl?: string; adminKey?: string;
  };

  if (!data.projectSlug || !data.adminKey) {
    throw new Error('Incomplete create_project response from Convex API');
  }

  return {
    projectSlug: data.projectSlug,
    deploymentName: data.deploymentName || '',
    deploymentUrl: data.prodUrl || `https://${data.deploymentName}.convex.cloud`,
    adminKey: data.adminKey,
  };
}

export async function GET(request: Request) {
  const { userId, redirectToSignIn } = await auth();
  const url = new URL(request.url);
  const prompt = url.searchParams.get('prompt')?.slice(0, 30000) ?? '';
  const visibility = url.searchParams.get('visibility') ?? 'public';
  const platformParam = url.searchParams.get('platform');
  const platform = normalizeProjectPlatform(platformParam) as ProjectPlatform;
  const backendTypeParam = url.searchParams.get('backendType');
  const modelParam = url.searchParams.get('model');
  const model = (
    modelParam === 'gpt-5.3-codex' ? 'gpt-5.3-codex' :
    modelParam === 'gpt-5.4' ? 'gpt-5.4' :
    modelParam === 'gpt-5.2' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'gpt-4.1' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'claude-sonnet-4-0' ? 'claude-sonnet-4-0' :
    modelParam === 'claude-sonnet-4.6' ? 'claude-sonnet-4-0' :
    modelParam === 'claude-sonnet-4.5' ? 'claude-sonnet-4-0' : // migrate legacy
    modelParam === 'claude-haiku-4.5' ? 'claude-sonnet-4-0' : // removed model
    modelParam === 'claude-opus-4-7' ? 'claude-opus-4-7' :
    modelParam === 'claude-opus-4.7' ? 'claude-opus-4-7' :
    modelParam === 'claude-opus-4.6' ? 'claude-opus-4-7' : // migrate legacy
    modelParam === 'claude-opus-4.5' ? 'claude-opus-4-7' : // migrate legacy
    modelParam === 'kimi-k2.5' ? 'fireworks-minimax-m2p5' : // removed model
    modelParam === 'kimi-k2-thinking-turbo' ? 'fireworks-minimax-m2p5' : // removed model
    modelParam === 'fireworks-minimax-m2p5' ? 'fireworks-minimax-m2p5' :
    modelParam === 'fireworks-glm-5p1' ? 'fireworks-glm-5p1' :
    modelParam === 'fireworks-kimi-k2p6' ? 'fireworks-kimi-k2p6' :
    modelParam === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro-preview' :
    'gpt-5.3-codex'
  ) as 'gpt-5.3-codex' | 'gpt-5.4' | 'claude-sonnet-4-0' | 'claude-opus-4-7' | 'fireworks-minimax-m2p5' | 'fireworks-glm-5p1' | 'fireworks-kimi-k2p6' | 'gemini-3.1-pro-preview';

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

    // Resolve backend type from server-side credential store (authoritative)
    const creds = await getUserCredentials(userId);
    const userWantsBYOC =
      creds.convexBackendPreference === 'user' || backendTypeParam === 'user';
    const backendType: 'platform' | 'user' = userWantsBYOC ? 'user' : 'platform';

    // BYOC hard gate: if user selected BYOC, they MUST have a valid OAuth token.
    // Never fall through to platform provisioning — that would consume platform resources.
    if (backendType === 'user' && !creds.convexOAuthAccessToken) {
      const errUrl = new URL('/', request.url);
      errUrl.searchParams.set('error', 'convex_not_connected');
      return NextResponse.redirect(errUrl);
    }

    const [project] = await db
      .insert(projects)
      .values({ name, userId, platform, model, backendType })
      .returning();

    if (backendType === 'user') {
      // BYOC: provision in the user's own Convex account via their OAuth token.
      // If this fails, delete the project and redirect with an error — never fall through.
      try {
        const convexResult = await provisionUserConvex(creds, name, userId);

        await db.update(projects)
          .set({
            userConvexUrl: convexResult.deploymentUrl,
            userConvexDeployKey: convexResult.adminKey,
            convexProjectId: convexResult.projectSlug,
            convexDeploymentId: convexResult.deploymentName,
            convexDeployUrl: convexResult.deploymentUrl,
            backendType: 'user',
            updatedAt: new Date(),
          })
          .where(eq(projects.id, project.id));
      } catch (error) {
        // BYOC failed — clean up the project row and redirect with error
        await db.delete(projects).where(eq(projects.id, project.id));
        const msg = error instanceof Error ? error.message : String(error);
        console.error('BYOC Convex provisioning failed:', msg);
        const errUrl = new URL('/', request.url);
        if (msg.includes('ProjectQuotaReached')) {
          errUrl.searchParams.set('error', 'convex_quota');
        } else {
          errUrl.searchParams.set('error', 'convex_provision_failed');
        }
        return NextResponse.redirect(errUrl);
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
