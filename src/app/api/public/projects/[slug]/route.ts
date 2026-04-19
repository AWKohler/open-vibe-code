import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects, projectFiles, projectAssets, projectStars } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { auth, clerkClient } from '@clerk/nextjs/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const db = getDb();
    const [proj] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.publicSlug, slug), eq(projects.isPublic, true)));

    if (!proj) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const textFiles = await db
      .select({ path: projectFiles.path, content: projectFiles.content, hash: projectFiles.hash })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, proj.id));

    const binaryAssets = await db
      .select({ path: projectAssets.path, url: projectAssets.uploadThingUrl, hash: projectAssets.hash })
      .from(projectAssets)
      .where(eq(projectAssets.projectId, proj.id));

    // Resolve author
    let author: { name: string; imageUrl: string | null } = { name: 'Anonymous', imageUrl: null };
    try {
      const client = await clerkClient();
      const u = await client.users.getUser(proj.userId);
      const name =
        u.firstName || u.lastName
          ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
          : u.username ?? (u.emailAddresses[0]?.emailAddress?.split('@')[0] ?? 'Anonymous');
      author = { name, imageUrl: u.imageUrl ?? null };
    } catch (err) {
      console.error('Clerk user lookup failed:', err);
    }

    // Has the current viewer starred this?
    let hasStarred = false;
    const { userId } = await auth();
    if (userId) {
      const [starRow] = await db
        .select({ id: projectStars.id })
        .from(projectStars)
        .where(and(eq(projectStars.projectId, proj.id), eq(projectStars.userId, userId)));
      hasStarred = Boolean(starRow);
    }

    return NextResponse.json({
      project: {
        id: proj.id,
        name: proj.name,
        platform: proj.platform,
        publicSlug: proj.publicSlug,
        publicDescription: proj.publicDescription,
        thumbnailUrl: proj.thumbnailUrl,
        htmlSnapshotUrl: proj.htmlSnapshotUrl,
        starCount: proj.starCount,
        publishedAt: proj.publishedAt,
        createdAt: proj.createdAt,
        author,
        hasStarred,
        isOwner: userId === proj.userId,
      },
      files: [
        ...textFiles.map((f) => ({ path: f.path, content: f.content, type: 'file' as const, hash: f.hash })),
        ...binaryAssets.map((a) => ({ path: a.path, url: a.url, type: 'asset' as const, hash: a.hash })),
      ],
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to load project' }, { status: 500 });
  }
}
