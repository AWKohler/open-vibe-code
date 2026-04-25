import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { desc, eq, isNull, and } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { getUserTierAndLimits } from '@/lib/tier';
import { countUserProjects } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    const allProjects = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)))
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
      platform?: 'web' | 'mobile' | 'multiplatform';
      model?:
        | 'gpt-5.3-codex'
        | 'gpt-5.4'
        | 'claude-sonnet-4-0'
        | 'claude-opus-4-1'
        | 'fireworks-minimax-m2p5'
        | 'fireworks-glm-5p1'
        | 'fireworks-kimi-k2p6'
        | 'gemini-3.1-pro-preview';
    };

    if (!name) {
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 });
    }

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

    const db = getDb();
    const [newProject] = await db
      .insert(projects)
      .values({
        name,
        userId,
        platform: platform === 'mobile' ? 'mobile' : 'web',
        model:
          model === 'gpt-5.4'
            ? 'gpt-5.4'
          : model === 'claude-sonnet-4-0'
            ? 'claude-sonnet-4-0'
            : model === 'claude-opus-4-1'
            ? 'claude-opus-4-1'
            : model === 'fireworks-minimax-m2p5'
            ? 'fireworks-minimax-m2p5'
            : model === 'fireworks-glm-5p1'
            ? 'fireworks-glm-5p1'
            : model === 'fireworks-kimi-k2p6'
            ? 'fireworks-kimi-k2p6'
            : model === 'gemini-3.1-pro-preview'
            ? 'gemini-3.1-pro-preview'
            : 'gpt-5.3-codex',
      })
      .returning();

    return NextResponse.json(newProject, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
