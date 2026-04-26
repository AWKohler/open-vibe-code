import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  getPersistentSandboxName,
  runPersistentSandboxSmokeTest,
} from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, id));

    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (project.platform !== "persistent") {
      return NextResponse.json(
        { error: "Project is not using the persistent runtime" },
        { status: 400 },
      );
    }

    const result = await runPersistentSandboxSmokeTest(project.id);

    return NextResponse.json({
      ok: result.exitCode === 0,
      projectId: project.id,
      sandboxName: result.sandboxName,
      expectedSandboxName: getPersistentSandboxName(project.id),
      runtime: result.runtime,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    });
  } catch (error) {
    console.error("Persistent sandbox smoke test failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Persistent sandbox smoke test failed",
      },
      { status: 500 },
    );
  }
}
