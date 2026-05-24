/**
 * Escape hatch: abandon an in-progress merge with `git merge --abort`.
 * Resets HEAD to pre-merge state and clears conflict markers.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { abortMerge, hasGitDir } from "@/lib/sandbox-git";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = getDb();
    const [proj] = await db.select().from(projects).where(eq(projects.id, id));
    if (!proj || proj.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!(await hasGitDir(id))) {
      return NextResponse.json(
        { error: "Sandbox has no .git directory." },
        { status: 409 },
      );
    }

    const res = await abortMerge(id);
    if (!res.ok) {
      return NextResponse.json({ error: res.message, stderr: res.stderr }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /github/sandbox/abort-merge failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Abort failed" },
      { status: 500 },
    );
  }
}
