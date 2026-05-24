/**
 * GET the working-tree status of a sandboxed-web project's git checkout.
 * Returns the current branch, ahead/behind counts, lists of added/modified/
 * deleted/untracked files, and whether a merge is currently in progress.
 *
 * Returns 400 if the project doesn't have a GitHub repo linked.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getStatus, hasGitDir } from "@/lib/sandbox-git";

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

    if (!proj.githubRepoOwner || !proj.githubRepoName) {
      return NextResponse.json({ error: "No GitHub repository linked." }, { status: 400 });
    }

    const gitDirExists = await hasGitDir(id);
    if (!gitDirExists) {
      return NextResponse.json(
        { error: "The sandbox has no .git directory. Re-link the repository to re-clone." },
        { status: 409 },
      );
    }

    const res = await getStatus(id);
    if (!res.ok) {
      return NextResponse.json({ error: res.message, stderr: res.stderr }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status: res.status });
  } catch (err) {
    console.error("POST /github/sandbox/status failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status failed" },
      { status: 500 },
    );
  }
}
