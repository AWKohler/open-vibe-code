/**
 * Stage and commit all current changes in the sandbox's working tree.
 *
 * This does NOT push — it only creates a local commit. The push endpoint is
 * the one that hits GitHub. Returning the new SHA lets the UI show what
 * happened; the user's next "push" call uploads it.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { commitAll, hasGitDir } from "@/lib/sandbox-git";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

interface CommitBody {
  message: string;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    if (!(await hasGitDir(id))) {
      return NextResponse.json(
        { error: "Sandbox has no .git directory. Re-link the repository." },
        { status: 409 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as CommitBody;
    const message = (body.message ?? "").trim();
    if (!message) {
      return NextResponse.json({ error: "Commit message is required" }, { status: 400 });
    }

    const res = await commitAll(id, message);
    if (!res.ok) {
      return NextResponse.json({ error: res.message, stderr: res.stderr }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      sha: res.sha ?? null,
      nothingToCommit: Boolean(res.nothingToCommit),
    });
  } catch (err) {
    console.error("POST /github/sandbox/commit failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Commit failed" },
      { status: 500 },
    );
  }
}
