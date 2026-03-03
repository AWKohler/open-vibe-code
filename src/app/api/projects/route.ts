import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    const allProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, userId))
      .orderBy(desc(projects.lastOpened), desc(projects.createdAt));
    return NextResponse.json(allProjects);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to fetch projects' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const { name, platform, model } = body as {
      name?: string;
      platform?: 'web' | 'mobile';
      model?:
        | 'gpt-5.3-codex'
        | 'claude-sonnet-4.6'
        | 'claude-haiku-4.5'
        | 'claude-opus-4.6'
        | 'kimi-k2.5'
        | 'fireworks-minimax-m2p5'
        | 'fireworks-glm-5';
    };

    if (!name) {
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 });
    }

    const db = getDb();
    const [newProject] = await db
      .insert(projects)
      .values({
        name,
        userId,
        platform: platform === 'mobile' ? 'mobile' : 'web',
        model:
          model === 'claude-sonnet-4.6'
            ? 'claude-sonnet-4.6'
            : model === 'claude-haiku-4.5'
            ? 'claude-haiku-4.5'
            : model === 'claude-opus-4.6'
            ? 'claude-opus-4.6'
            : model === 'kimi-k2.5'
            ? 'kimi-k2.5'
            : model === 'fireworks-minimax-m2p5'
            ? 'fireworks-minimax-m2p5'
            : model === 'fireworks-glm-5'
            ? 'fireworks-glm-5'
            : 'gpt-5.3-codex',
      })
      .returning();

    return NextResponse.json(newProject, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
