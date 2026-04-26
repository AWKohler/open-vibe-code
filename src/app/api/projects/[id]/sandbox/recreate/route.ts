import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { recreateSandboxWithPorts } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  _req: NextRequest,
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

  try {
    const sandbox = await recreateSandboxWithPorts(project.id);
    return NextResponse.json({ ok: true, sandboxName: sandbox.name });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to recreate sandbox" },
      { status: 500 },
    );
  }
}
