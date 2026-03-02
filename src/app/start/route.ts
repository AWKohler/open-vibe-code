import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { provisionConvexBackend } from '@/lib/convex-platform';

export async function GET(request: Request) {
  const { userId, redirectToSignIn } = await auth();
  const url = new URL(request.url);
  const prompt = url.searchParams.get('prompt')?.slice(0, 4000) ?? '';
  const visibility = url.searchParams.get('visibility') ?? 'public';
  const platform = (url.searchParams.get('platform') === 'mobile' ? 'mobile' : 'web') as 'web' | 'mobile';
  const modelParam = url.searchParams.get('model');
  const model = (
    modelParam === 'gpt-5.3-codex' ? 'gpt-5.3-codex' :
    modelParam === 'gpt-5.2' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'gpt-4.1' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'claude-sonnet-4.6' ? 'claude-sonnet-4.6' :
    modelParam === 'claude-sonnet-4.5' ? 'claude-sonnet-4.6' : // migrate legacy
    modelParam === 'claude-haiku-4.5' ? 'claude-haiku-4.5' :
    modelParam === 'claude-opus-4.6' ? 'claude-opus-4.6' :
    modelParam === 'claude-opus-4.5' ? 'claude-opus-4.6' : // migrate legacy
    modelParam === 'kimi-k2-thinking-turbo' ? 'kimi-k2-thinking-turbo' :
    modelParam === 'fireworks-minimax-m2p5' ? 'fireworks-minimax-m2p5' :
    modelParam === 'fireworks-glm-5' ? 'fireworks-glm-5' :
    'gpt-5.3-codex'
  ) as 'gpt-5.3-codex' | 'claude-sonnet-4.6' | 'claude-haiku-4.5' | 'claude-opus-4.6' | 'kimi-k2-thinking-turbo' | 'fireworks-minimax-m2p5' | 'fireworks-glm-5';

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
    const [project] = await db
      .insert(projects)
      .values({ name, userId, platform, model })
      .returning();

    // For web projects, provision a Convex backend
    if (platform === 'web') {
      try {
        const convexProjectName = `ide-${project.id.slice(0, 8)}`;
        const convex = await provisionConvexBackend(convexProjectName);

        // Update project with Convex details
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
          // Quota reached — redirect with a visible error rather than silently
          // creating a project with no backend.
          console.error('Convex quota reached, cannot create project:', msg);
          const errUrl = new URL('/', request.url);
          errUrl.searchParams.set('error', 'convex_quota');
          return NextResponse.redirect(errUrl);
        }
        // For other provisioning errors, allow the project to be created without
        // a Convex backend — the deploy route will retry provisioning on first deploy.
        console.error('Failed to provision Convex backend:', error);
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
