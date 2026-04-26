import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function getAuthorizedProject(projectId: string, userId: string) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) return null;
  if (project.platform !== "persistent") return null;
  return project;
}

// GET: get current sandbox status / info
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const sandbox = await getOrCreatePersistentSandbox(project.id);
    return NextResponse.json({
      sandboxName: sandbox.name,
      status: sandbox.status,
      runtime: sandbox.runtime,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get sandbox" },
      { status: 500 },
    );
  }
}

// POST: ensure sandbox is running (creates if needed)
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const sandbox = await getOrCreatePersistentSandbox(project.id);
    return NextResponse.json({
      sandboxName: sandbox.name,
      status: sandbox.status,
      runtime: sandbox.runtime,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start sandbox" },
      { status: 500 },
    );
  }
}
