import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";

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

// GET: list all files recursively in the sandbox
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const searchParams = req.nextUrl.searchParams;
  const filePath = searchParams.get("path");

  try {
    const sandbox = await getOrCreatePersistentSandbox(project.id);

    if (filePath) {
      // Read a single file
      const buf = await sandbox.readFileToBuffer({ path: filePath });
      if (!buf) return NextResponse.json({ error: "File not found" }, { status: 404 });

      // Try to decode as UTF-8 text
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        return NextResponse.json({ content, binary: false });
      } catch {
        // Binary file — return base64
        const b64 = Buffer.from(buf).toString("base64");
        return NextResponse.json({ content: b64, binary: true });
      }
    }

    // List files recursively via find
    const result = await sandbox.runCommand("find", [
      "/vercel/sandbox",
      "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/.git/*",
      "-not", "-name", ".DS_Store",
      "-printf", "%y %p\n",
    ]);

    const stdout = await result.stdout();
    const files: Record<string, { type: "file" | "folder" }> = {};

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(" ");
      const kind = trimmed.slice(0, spaceIdx);
      const rawPath = trimmed.slice(spaceIdx + 1);
      // Strip the /vercel/sandbox prefix
      const path = rawPath.replace(/^\/vercel\/sandbox/, "") || "/";
      if (path === "/") continue;
      files[path] = { type: kind === "d" ? "folder" : "file" };
    }

    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list files" },
      { status: 500 },
    );
  }
}

// PUT: write a file
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
    const sandbox = await getOrCreatePersistentSandbox(project.id);
    const sandboxPath = `/vercel/sandbox${filePath}`;

    // Ensure parent directory exists
    const dir = sandboxPath.substring(0, sandboxPath.lastIndexOf("/"));
    if (dir) await sandbox.mkDir(dir);

    await sandbox.writeFiles([{
      path: sandboxPath,
      content: Buffer.from(content, "utf-8"),
    }]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to write file" },
      { status: 500 },
    );
  }
}
