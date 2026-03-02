import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { deleteConvexBackend } from '@/lib/convex-platform';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    const [proj] = await db.select().from(projects).where(eq(projects.id, resolvedParams.id));
    if (!proj || proj.userId !== userId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(proj);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to fetch project' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    const [proj] = await db.select().from(projects).where(eq(projects.id, resolvedParams.id));
    if (!proj || proj.userId !== userId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const body = await req.json();
    const { model, thumbnailUrl, htmlSnapshotUrl } = body as {
      model?: string;
      thumbnailUrl?: string;
      htmlSnapshotUrl?: string;
    };
    if (
      model &&
      model !== 'gpt-5.3-codex' &&
      model !== 'gpt-5.2' && // backwards compat
      model !== 'gpt-4.1' && // backwards compat
      model !== 'claude-sonnet-4.6' &&
      model !== 'claude-sonnet-4.5' && // backwards compat
      model !== 'claude-haiku-4.5' &&
      model !== 'claude-opus-4.6' &&
      model !== 'claude-opus-4.5' && // backwards compat
      model !== 'kimi-k2-thinking-turbo' &&
      model !== 'fireworks-minimax-m2p5' &&
      model !== 'fireworks-glm-5'
    ) {
      return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    }
    const updateData: Partial<typeof proj> = {
      updatedAt: new Date(),
    };
    if (model) updateData.model = model;
    if (thumbnailUrl !== undefined) updateData.thumbnailUrl = thumbnailUrl;
    if (htmlSnapshotUrl !== undefined) updateData.htmlSnapshotUrl = htmlSnapshotUrl;

    const [updated] = await db
      .update(projects)
      .set(updateData)
      .where(eq(projects.id, resolvedParams.id))
      .returning();
    return NextResponse.json(updated);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    const [proj] = await db.select().from(projects).where(eq(projects.id, resolvedParams.id));
    if (!proj || proj.userId !== userId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Delete Convex backend if it exists
    if (proj.convexProjectId) {
      try {
        await deleteConvexBackend(proj.convexProjectId);
        console.log(`Convex backend deleted for project ${resolvedParams.id}`);
      } catch (error) {
        // Log error but continue with project deletion
        console.error('Failed to delete Convex backend:', error);
      }
    }

    // Delete Cloudflare Pages project if it exists
    if (proj.cloudflareProjectName) {
      try {
        const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
        const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
        if (CF_ACCOUNT_ID && CF_API_TOKEN) {
          await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${proj.cloudflareProjectName}`,
            {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` },
            }
          );
          console.log(`Cloudflare Pages project deleted for project ${resolvedParams.id}`);
        }
      } catch (error) {
        console.error('Failed to delete Cloudflare Pages project:', error);
      }
    }

    // Delete the project (cascades to chat sessions, messages, and env vars)
    await db.delete(projects).where(eq(projects.id, resolvedParams.id));

    return NextResponse.json({ success: true, message: 'Project deleted' });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 });
  }
}
