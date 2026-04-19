import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects, projectFiles, projectAssets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { getUserTierAndLimits } from '@/lib/tier';
import { countUserProjects } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { name: overrideName } = body as { name?: string };

    const db = getDb();

    // Enforce project count limit
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

    // Find source public project
    const [source] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.publicSlug, slug), eq(projects.isPublic, true)));
    if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const newName = (overrideName && overrideName.trim().length > 0)
      ? overrideName.trim().slice(0, 100)
      : `${source.name} (copy)`;

    // Create new project under current user — platform + model carried over,
    // but all backend / deployment / github / public metadata reset.
    const [newProject] = await db
      .insert(projects)
      .values({
        name: newName,
        userId,
        platform: source.platform,
        model: source.model,
        thumbnailUrl: source.thumbnailUrl,
        htmlSnapshotUrl: source.htmlSnapshotUrl,
        forkedFromProjectId: source.id,
        backendType: 'platform',
      })
      .returning();

    // Copy text files
    const srcFiles = await db
      .select({ path: projectFiles.path, content: projectFiles.content, hash: projectFiles.hash, size: projectFiles.size, mimeType: projectFiles.mimeType })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, source.id));

    if (srcFiles.length > 0) {
      await db.insert(projectFiles).values(
        srcFiles.map((f) => ({
          projectId: newProject.id,
          path: f.path,
          content: f.content,
          hash: f.hash,
          size: f.size,
          mimeType: f.mimeType ?? null,
        }))
      );
    }

    // Copy binary assets (reference the same UploadThing URL — we're not re-uploading)
    const srcAssets = await db
      .select()
      .from(projectAssets)
      .where(eq(projectAssets.projectId, source.id));

    if (srcAssets.length > 0) {
      await db.insert(projectAssets).values(
        srcAssets.map((a) => ({
          projectId: newProject.id,
          path: a.path,
          uploadThingUrl: a.uploadThingUrl,
          uploadThingKey: a.uploadThingKey,
          hash: a.hash,
          size: a.size,
          mimeType: a.mimeType ?? null,
        }))
      );
    }

    return NextResponse.json({ projectId: newProject.id }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to fork project' }, { status: 500 });
  }
}
