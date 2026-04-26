import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST: start the dev server
// Returns previewUrl if the sandbox has port forwarding, otherwise a no_port_route error.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));

  if (!project || project.userId !== userId || project.platform !== "persistent") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json() as { port?: number; installFirst?: boolean };
  const port = body.port ?? 5173;
  const installFirst = body.installFirst ?? false;

  try {
    const sandbox = await getOrCreatePersistentSandbox(project.id);

    // Check if port forwarding is available before doing expensive work
    try {
      sandbox.domain(port);
    } catch {
      return NextResponse.json(
        { error: "no_port_route", message: "Live preview requires port forwarding, which must be enabled when the sandbox is created. This sandbox was created without it." },
        { status: 409 },
      );
    }

    if (installFirst) {
      const installResult = await sandbox.runCommand({
        cmd: "pnpm",
        args: ["install"],
        cwd: "/vercel/sandbox",
      });
      if (installResult.exitCode !== 0) {
        const err = await installResult.stderr();
        return NextResponse.json({ error: `pnpm install failed: ${err}` }, { status: 500 });
      }
    }

    await sandbox.runCommand({
      cmd: "pnpm",
      args: ["dev", "--host"],
      cwd: "/vercel/sandbox",
      detached: true,
    });

    await new Promise((r) => setTimeout(r, 3000));

    const previewUrl = sandbox.domain(port);
    return NextResponse.json({ previewUrl, port });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start dev server" },
      { status: 500 },
    );
  }
}
