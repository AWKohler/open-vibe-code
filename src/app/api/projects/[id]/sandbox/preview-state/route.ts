/**
 * GET /api/projects/[id]/sandbox/preview-state
 *
 * Lightweight polling endpoint the SandboxedWebWorkspace hits every ~2 seconds
 * while the preview tab is active. Returns the timestamp of the latest agent-
 * initiated preview refresh request (or null if none).
 *
 * The client tracks the last-seen `refreshAt`; when it changes, it bumps its
 * `previewReloadKey` to remount the iframe. This is how the agent's
 * `refreshPreview` tool reaches the user's browser — server pushes the signal
 * into Redis, the client picks it up on the next poll.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getPreviewRefreshAt } from "@/lib/workspace-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project || project.userId !== userId || project.platform !== "sandboxed-web") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const refreshAt = await getPreviewRefreshAt(project.id);
  return NextResponse.json({ refreshAt });
}
