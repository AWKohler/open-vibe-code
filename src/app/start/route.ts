import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { provisionConvexBackend } from '@/lib/convex-platform';
import { getUserTierAndLimits } from '@/lib/tier';
import { getUserCredentials, setUserCredentials, type UserCredentials } from '@/lib/user-credentials';
import { normalizeProjectPlatform, type ProjectPlatform, type BackendType } from '@/lib/project-platform';
import { resolveModelId } from '@/lib/agent/models';
import { resolveBackends, type AgentBackend } from '@/lib/agent/backend-resolution';
import { randomUUID } from 'node:crypto';

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

  const data = await res.json() as Record<string, unknown>;
  console.log('[BYOC] create_project raw response:', JSON.stringify(data));

  const projectSlug =
    (data.projectSlug as string | undefined) ||
    (data.slug as string | undefined) ||
    ((data.project as Record<string, unknown> | undefined)?.slug as string | undefined);
  const deploymentName =
    (data.deploymentName as string | undefined) ||
    (data.prodDeploymentName as string | undefined) ||
    ((data.prodDeployment as Record<string, unknown> | undefined)?.name as string | undefined) ||
    '';
  const prodUrl =
    (data.prodUrl as string | undefined) ||
    ((data.prodDeployment as Record<string, unknown> | undefined)?.url as string | undefined);

  if (!projectSlug || !deploymentName) {
    throw new Error(`Incomplete create_project response from Convex API — got keys: ${Object.keys(data).join(', ')}`);
  }

  // Convex no longer returns adminKey in create_project — fetch it separately.
  let adminKey =
    (data.adminKey as string | undefined) ||
    (data.deployKey as string | undefined) ||
    ((data.prodDeployment as Record<string, unknown> | undefined)?.adminKey as string | undefined);

  if (!adminKey) {
    const keyRes = await fetch(
      `https://api.convex.dev/v1/deployments/${deploymentName}/create_deploy_key`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `ide-${Date.now()}` }),
      },
    );
    const keyData = await keyRes.json() as Record<string, unknown>;
    console.log('[BYOC] create_deploy_key response:', JSON.stringify(keyData));
    adminKey =
      (keyData.key as string | undefined) ||
      (keyData.deployKey as string | undefined) ||
      (keyData.accessToken as string | undefined);
    if (!adminKey) {
      throw new Error(`Failed to obtain Convex deploy key — got: ${JSON.stringify(keyData)}`);
    }
  }

  return {
    projectSlug,
    deploymentName,
    deploymentUrl: prodUrl || `https://${deploymentName}.convex.cloud`,
    adminKey,
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
    modelParam === 'gpt-5.5' ? 'gpt-5.5' :
    modelParam === 'gpt-5.2' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'gpt-4.1' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'claude-sonnet-4-6' ? 'claude-sonnet-4-6' :
    modelParam === 'claude-sonnet-4.6' ? 'claude-sonnet-4-6' :
    modelParam === 'claude-sonnet-4.5' ? 'claude-sonnet-4-6' : // migrate legacy
    modelParam === 'claude-haiku-4.5' ? 'claude-sonnet-4-6' : // removed model
    modelParam === 'claude-opus-4-7' ? 'claude-opus-4-7' :
    modelParam === 'claude-opus-4.7' ? 'claude-opus-4-7' :
    modelParam === 'claude-opus-4.6' ? 'claude-opus-4-7' : // migrate legacy
    modelParam === 'claude-opus-4.5' ? 'claude-opus-4-7' : // migrate legacy
    modelParam === 'fireworks-minimax-m2p5' ? 'fireworks-minimax-m2p7' : // updated model
    modelParam === 'kimi-k2.5' ? 'fireworks-minimax-m2p7' : // removed model
    modelParam === 'kimi-k2-thinking-turbo' ? 'fireworks-minimax-m2p7' : // removed model
    modelParam === 'fireworks-minimax-m2p7' ? 'fireworks-minimax-m2p7' :
    modelParam === 'fireworks-glm-5p1' ? 'fireworks-glm-5p1' :
    modelParam === 'fireworks-kimi-k2p6' ? 'fireworks-kimi-k2p6' :
    modelParam === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro-preview' :
    'gpt-5.3-codex'
  ) as 'gpt-5.3-codex' | 'gpt-5.4' | 'gpt-5.5' | 'claude-sonnet-4-6' | 'claude-opus-4-7' | 'fireworks-minimax-m2p7' | 'fireworks-glm-5p1' | 'fireworks-kimi-k2p6' | 'gemini-3.1-pro-preview';

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

    // Resolve backend type from server-side credential store (authoritative).
    //   'none'     -> frontend-only project, no Convex provisioning
    //   'user'     -> user-owned (BYOC), provisioned via their OAuth token
    //   'platform' -> Botflow-managed (default)
    const creds = await getUserCredentials(userId);
    let backendType: BackendType;
    // 'No Backend' is supported on the web platforms (web + sandboxed-web) —
    // both have a no-backend Vite template variant. Mobile/multiplatform/swift
    // templates ship with Convex baked in (or don't apply), so silently coerce
    // `none` -> `platform` for those.
    const supportsNoBackend = platform === 'web' || platform === 'sandboxed-web';
    // Honor either the URL param OR the saved user preference for `none`. The
    // page client puts backendType=none in the URL when the user selects it,
    // but if anything strips/loses that param in transit, the saved preference
    // is still our source of truth.
    const userWantsNone =
      backendTypeParam === 'none' || creds.convexBackendPreference === 'none';
    if (userWantsNone && supportsNoBackend) {
      backendType = 'none';
    } else {
      const userWantsBYOC =
        creds.convexBackendPreference === 'user' || backendTypeParam === 'user';
      backendType = userWantsBYOC ? 'user' : 'platform';
    }
    console.log(
      `[start] project creation: platform=${platform} backendTypeParam=${backendTypeParam} ` +
      `pref=${creds.convexBackendPreference ?? 'null'} → backendType=${backendType}`,
    );

    // BYOC hard gate: if user selected BYOC, they MUST have a valid OAuth token.
    // Never fall through to platform provisioning — that would consume platform resources.
    if (backendType === 'user' && !creds.convexOAuthAccessToken) {
      const errUrl = new URL('/', request.url);
      errUrl.searchParams.set('error', 'convex_not_connected');
      return NextResponse.redirect(errUrl);
    }

    // Free users can't get a Botflow-managed Convex backend (unless the global
    // override flag is set). Previously we'd silently insert a project with
    // `backendType='platform'` and no Convex URL — broken state.
    // Now we downgrade to 'none' so the workspace mounts the no-backend
    // template and everything works end-to-end. The UI also gates this, but
    // we re-check on the server in case the client lied.
    if (backendType === 'platform' && supportsNoBackend) {
      const cloudConvexForAll = process.env.ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
      const limits = await getUserTierAndLimits(userId);
      if (!cloudConvexForAll && limits.tier === 'free') {
        backendType = 'none';
      }
    }

    // Resolve the initial agent backend for this project. The user's BYOK
    // preference applies only when both backends are available; OAuth users
    // are locked to claude-code automatically.
    const resolvedModel = resolveModelId(model);
    const backendResolution = resolveBackends({
      model: resolvedModel,
      platform,
      creds: {
        hasClaudeOAuth: Boolean(creds.claudeOAuthAccessToken),
        hasAnthropicKey: Boolean(creds.anthropicApiKey),
      },
    });
    let initialAgentBackend: AgentBackend = backendResolution.defaultBackend;
    if (
      backendResolution.locked === null &&
      backendResolution.available.length >= 2 &&
      creds.preferredAnthropicBackend &&
      backendResolution.available.includes(creds.preferredAnthropicBackend)
    ) {
      initialAgentBackend = creds.preferredAnthropicBackend;
    }

    const [project] = await db
      .insert(projects)
      .values({
        name,
        userId,
        platform,
        model,
        backendType,
        agentBackend: initialAgentBackend,
        currentSegmentId: randomUUID(),
      })
      .returning();

    if (backendType === 'none') {
      // No backend selected — skip provisioning entirely. The project will use
      // the no-backend template (vite_template) and never have a /convex folder.
    } else if (backendType === 'user') {
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
    workspaceUrl.searchParams.set('backendType', backendType);
    if (visibility) workspaceUrl.searchParams.set('visibility', visibility);
    return NextResponse.redirect(workspaceUrl);
  } catch (err) {
    console.error('Failed to start project:', err);
    return NextResponse.redirect(new URL('/', request.url));
  }
}
