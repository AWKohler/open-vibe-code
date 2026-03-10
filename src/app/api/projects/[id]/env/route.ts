import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects, projectEnvVars } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';

/**
 * GET - List all environment variables for a project
 * Returns both system vars (VITE_CONVEX_URL) and user-defined vars
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();

  // Verify project ownership
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Get user-defined env vars
  const envVars = await db.select().from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, id));

  // Build system env vars (read-only)
  const systemEnvVars: Array<{
    key: string;
    value: string;
    isSystem: true;
    isSecret: false;
  }> = [];

  if (project.convexDeployUrl) {
    // Inject the appropriate env var based on platform
    // Vite uses VITE_ prefix, Expo uses EXPO_PUBLIC_ prefix
    if (project.platform === 'mobile') {
      systemEnvVars.push({
        key: 'EXPO_PUBLIC_CONVEX_URL',
        value: project.convexDeployUrl,
        isSystem: true,
        isSecret: false,
      });
    } else {
      systemEnvVars.push({
        key: 'VITE_CONVEX_URL',
        value: project.convexDeployUrl,
        isSystem: true,
        isSecret: false,
      });
    }
  }

  return NextResponse.json({
    envVars: envVars.map(e => ({
      id: e.id,
      key: e.key,
      value: e.value,
      isSecret: e.isSecret,
      isSystem: false,
    })),
    systemEnvVars,
  });
}

/**
 * POST - Create or update an environment variable
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();

  // Verify project ownership
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await req.json();
  const { key, value, isSecret } = body as {
    key: string;
    value: string;
    isSecret?: boolean;
  };

  // Validate key format (must be valid env var name)
  if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return NextResponse.json(
      { error: 'Invalid variable name. Use letters, numbers, and underscores only. Must start with a letter or underscore.' },
      { status: 400 }
    );
  }

  // Prevent overriding system vars
  const systemVarNames = ['VITE_CONVEX_URL', 'EXPO_PUBLIC_CONVEX_URL'];
  if (systemVarNames.includes(key.toUpperCase())) {
    return NextResponse.json(
      { error: 'Cannot override system variable' },
      { status: 400 }
    );
  }

  // Upsert env var
  const [envVar] = await db.insert(projectEnvVars)
    .values({
      projectId: id,
      key: key.toUpperCase(),
      value,
      isSecret: isSecret ?? false,
    })
    .onConflictDoUpdate({
      target: [projectEnvVars.projectId, projectEnvVars.key],
      set: {
        value,
        isSecret: isSecret ?? false,
        updatedAt: new Date(),
      },
    })
    .returning();

  return NextResponse.json({
    id: envVar.id,
    key: envVar.key,
    value: envVar.value,
    isSecret: envVar.isSecret,
    isSystem: false,
  }, { status: 201 });
}

/**
 * PUT - Bulk import environment variables from .env content
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();

  // Verify project ownership
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { content } = await req.json() as { content: string };

  // System vars that cannot be overridden
  const systemVarNames = ['VITE_CONVEX_URL', 'EXPO_PUBLIC_CONVEX_URL'];

  // Parse .env format
  const lines = content.split('\n');
  const envVars: Array<{ key: string; value: string }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Match KEY=value format (supports quoted values)
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      const key = match[1].toUpperCase();
      let value = match[2];

      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Skip system vars
      if (systemVarNames.includes(key)) continue;

      envVars.push({ key, value });
    }
  }

  // Upsert all parsed env vars
  let imported = 0;
  for (const { key, value } of envVars) {
    await db.insert(projectEnvVars)
      .values({ projectId: id, key, value, isSecret: false })
      .onConflictDoUpdate({
        target: [projectEnvVars.projectId, projectEnvVars.key],
        set: { value, updatedAt: new Date() },
      });
    imported++;
  }

  return NextResponse.json({ imported });
}

/**
 * DELETE - Remove an environment variable by key
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();

  // Verify project ownership
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { key } = await req.json() as { key: string };

  if (!key) {
    return NextResponse.json({ error: 'Key is required' }, { status: 400 });
  }

  await db.delete(projectEnvVars)
    .where(and(
      eq(projectEnvVars.projectId, id),
      eq(projectEnvVars.key, key.toUpperCase())
    ));

  return NextResponse.json({ success: true });
}
