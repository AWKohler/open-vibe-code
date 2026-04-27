import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  getOrCreatePersistentSandbox,
  sandboxListFiles,
  sandboxReadFile,
  sandboxWriteFile,
} from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function getAuthorizedProject(projectId: string, userId: string) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) return null;
  if (project.platform !== "persistent") return null;
  return project;
}

// GET: list all files recursively, or read a single file when ?path= is present
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filePath = req.nextUrl.searchParams.get("path");

  try {
    if (filePath) {
      const result = await sandboxReadFile(project.id, filePath);
      if (!result) return NextResponse.json({ error: "File not found" }, { status: 404 });
      return NextResponse.json({ content: result.content, binary: result.binary });
    }

    // Ensure the sandbox is up before listing
    await getOrCreatePersistentSandbox(project.id);
    const entries = await sandboxListFiles(project.id, "/", true);
    const files: Record<string, { type: "file" | "folder" }> = {};
    for (const entry of entries) {
      files[entry.path] = { type: entry.type };
    }
    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read sandbox" },
      { status: 500 },
    );
  }
}

// PUT: write a file (creates parent dirs as needed)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { path: filePath, content } = await req.json() as { path: string; content: string };
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    await sandboxWriteFile(project.id, filePath, content);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to write file" },
      { status: 500 },
    );
  }
}
