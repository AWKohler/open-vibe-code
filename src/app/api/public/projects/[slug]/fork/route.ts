import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { getUserTierAndLimits } from '@/lib/tier';
import { countUserProjects } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';

/**
 * "Use as template" — fork a public project into the current user's account.
 *
 * Creates a fresh sandbox (sandboxed-web) project that carries the source
 * project's published bundle in `seedBundleUrl`. The sandbox is NOT booted here
 * (cost-aware) — it lazily extracts the bundle on first open (see the sandbox
 * seed route). All deploy / public / GitHub metadata is reset.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { name: overrideName } = body as { name?: string };

    const db = getDb();

    const [limits, currentCount] = await Promise.all([
      getUserTierAndLimits(userId),
      countUserProjects(userId),
    ]);
    if (currentCount >= limits.maxProjects) {
      return limitReachedResponse({
        limitType: 'project_count',
        current: currentCount,
        limit: limits.maxProjects,
        tier: limits.tier,
      });
    }

    const [source] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.publicSlug, slug), eq(projects.isPublic, true)));
    if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const newName = (overrideName && overrideName.trim().length > 0)
      ? overrideName.trim().slice(0, 100)
      : `${source.name} (copy)`;

    // Forks of BYOC ('user') projects fall back to platform-managed Convex —
    // we don't have the forker's Convex OAuth token at fork time.
    const forkedBackendType: 'platform' | 'none' =
      source.backendType === 'none' ? 'none' : 'platform';
    const sandboxTemplate = forkedBackendType === 'none' ? 'vite' : 'viteConvex';

    const [newProject] = await db
      .insert(projects)
      .values({
        name: newName,
        userId,
        platform: 'sandboxed-web',
        model: source.model,
        backendType: forkedBackendType,
        sandboxTemplate,
        forkedFromProjectId: source.id,
        // Seed the new sandbox from the source bundle on first open. If the
        // source has no bundle (legacy), the seed falls back to the template.
        seedBundleUrl: source.publicSourceUrl ?? null,
      })
      .returning();

    return NextResponse.json({ projectId: newProject.id }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to fork project' }, { status: 500 });
  }
}
