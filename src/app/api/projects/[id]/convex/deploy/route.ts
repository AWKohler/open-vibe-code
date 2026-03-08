import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { provisionConvexBackend, getConvexPlatformClient } from '@/lib/convex-platform';
import { getUserTierAndLimits } from '@/lib/tier';
import { countUserConvexProjects } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';

const FLY_WORKER_URL = process.env.FLY_WORKER_URL;
const WORKER_AUTH_TOKEN = process.env.FLY_WORKER_AUTH_TOKEN ?? process.env.WORKER_AUTH_TOKEN ?? "";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 1. Verify authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;

    // 2. Verify project ownership and get deploy key
    const db = getDb();
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Auto-provision Convex backend if missing (handles projects created before
    // Convex integration or where provisioning silently failed at creation time).
    if (!project.convexDeployKey) {
      // Enforce per-user Convex project limit before provisioning a new one
      if (!project.convexProjectId) {
        const [limits, currentConvex] = await Promise.all([
          getUserTierAndLimits(userId),
          countUserConvexProjects(userId),
        ]);
        if (currentConvex >= limits.maxConvexProjects) {
          return limitReachedResponse({
            limitType: 'convex_project_count',
            current: currentConvex,
            limit: limits.maxConvexProjects,
            tier: limits.tier,
          });
        }
      }

      try {
        let deployKey: string;

        if (project.convexDeploymentId) {
          // Deployment exists but key was lost — create a new deploy key
          const client = getConvexPlatformClient();
          deployKey = await client.createDeployKey(project.convexDeploymentId);
          await db.update(projects)
            .set({ convexDeployKey: deployKey, updatedAt: new Date() })
            .where(eq(projects.id, projectId));
          project.convexDeployKey = deployKey;
        } else {
          // No Convex backend at all — provision one now
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
            .where(eq(projects.id, projectId));
          project.convexDeployKey = convex.deployKey;
        }
      } catch (provisionErr) {
        const msg = provisionErr instanceof Error ? provisionErr.message : String(provisionErr);
        const isQuota = msg.includes('ProjectQuotaReached');
        return NextResponse.json(
          {
            error: isQuota
              ? 'Convex project quota reached (20/20). Delete unused projects or upgrade your Convex plan at https://www.convex.dev/plans to continue.'
              : `Failed to provision Convex backend: ${msg}`,
          },
          { status: isQuota ? 402 : 500 }
        );
      }
    }

    // 3. Get the zip blob from request body
    const zipBlob = await request.blob();

    if (zipBlob.size === 0) {
      return NextResponse.json(
        { error: 'No deployment package provided' },
        { status: 400 }
      );
    }

    // 4. Send to fly.io worker
    if (!FLY_WORKER_URL) {
      return NextResponse.json(
        { ok: false, output: '', error: 'FLY_WORKER_URL is not configured' },
        { status: 500 }
      );
    }

    const response = await fetch(FLY_WORKER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WORKER_AUTH_TOKEN}`,
        'X-Convex-Deploy-Key': project.convexDeployKey,
      },
      body: zipBlob,
    });

    // 5. Parse JSON response from fly.io
    const result = await response.json();

    if (!response.ok || !result.success) {
      return NextResponse.json(
        {
          ok: false,
          output: result.logs || '',
          error: result.error || `Deployment failed with status ${response.status}`,
          generatedFiles: [],
        },
        { status: response.status }
      );
    }

    // 6. Return success with logs and generated files
    return NextResponse.json({
      ok: true,
      output: result.logs || '',
      generatedFiles: result.generatedFiles || [],
    });
  } catch (error) {
    console.error('Convex deployment error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        output: '',
        error: `Deployment error: ${errorMessage}`,
      },
      { status: 500 }
    );
  }
}
