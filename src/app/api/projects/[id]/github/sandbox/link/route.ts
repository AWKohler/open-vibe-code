/**
 * Link / unlink a GitHub repository to a sandboxed-web project.
 *
 * On link: clones (if repo is populated) or initializes-and-commits (if empty)
 * the project's sandbox at /vercel/sandbox to track the chosen repo. The
 * sandbox keeps a real `.git` directory; subsequent commit/push/pull use
 * the actual `git` binary.
 *
 * On unlink: clears the project's github_* columns. The sandbox's .git
 * directory is left intact so the working tree keeps working, but no further
 * remote operations happen until re-linked.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { chatMessages, chatSessions, projects } from "@/db/schema";
import { getUserCredentials } from "@/lib/user-credentials";
import {
  cloneRepoIntoSandbox,
  hasGitDir,
  initSandboxAsRepo,
  pushBranch,
} from "@/lib/sandbox-git";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface LinkBody {
  owner: string;
  name: string;
  defaultBranch?: string;
}

interface GitHubRepoInfo {
  default_branch: string;
  size: number;
  private: boolean;
  permissions?: { push?: boolean };
}

interface GitHubUserInfo {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

async function fetchRepoInfo(token: string, owner: string, name: string): Promise<GitHubRepoInfo | { error: string; status: number }> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { error: body.message ?? `GitHub returned ${res.status}`, status: res.status };
  }
  return (await res.json()) as GitHubRepoInfo;
}

async function fetchUserInfo(token: string): Promise<GitHubUserInfo | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as GitHubUserInfo;
  } catch {
    return null;
  }
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
    if (proj.platform !== "sandboxed-web") {
      return NextResponse.json(
        { error: "This endpoint is for sandboxed-web projects only." },
        { status: 400 },
      );
    }

    const creds = await getUserCredentials(userId);
    if (!creds.githubAccessToken) {
      return NextResponse.json({ error: "GitHub not connected" }, { status: 400 });
    }
    const token = creds.githubAccessToken;

    const body = (await req.json()) as LinkBody;
    if (!body.owner || !body.name) {
      return NextResponse.json({ error: "owner and name are required" }, { status: 400 });
    }

    // Verify access and learn the repo's state (empty or populated).
    const repoInfo = await fetchRepoInfo(token, body.owner, body.name);
    if ("error" in repoInfo) {
      return NextResponse.json({ error: repoInfo.error }, { status: repoInfo.status });
    }
    if (repoInfo.permissions?.push === false) {
      return NextResponse.json(
        { error: "You don't have push access to this repository." },
        { status: 403 },
      );
    }

    const branch = body.defaultBranch ?? repoInfo.default_branch ?? "main";

    // Best-effort identity for git commits.
    const user = await fetchUserInfo(token);
    const identity = {
      name: user?.name || user?.login || "Botflow",
      email: user?.email
        || (user?.login ? `${user.id ?? user.login}+${user.login}@users.noreply.github.com` : "agent@botflow.dev"),
    };

    // Ensure the sandbox exists before we touch its filesystem.
    await getOrCreatePersistentSandbox(id);

    let headSha: string | null = null;

    // Strategy:
    //   - If the GitHub repo is empty (size === 0 and never auto-init'd): init
    //     the sandbox in place, commit current tree, push to GitHub.
    //   - Otherwise: wipe the sandbox tree and clone fresh. The user can still
    //     re-seed a template later by creating a new project.
    const repoIsEmpty = repoInfo.size === 0;

    if (repoIsEmpty) {
      const init = await initSandboxAsRepo(id, {
        owner: body.owner,
        name: body.name,
        branch,
        identity,
      });
      if (!init.ok) {
        return NextResponse.json({ error: init.message, stderr: init.stderr }, { status: 500 });
      }
      // Push the initial commit so the repo isn't empty going forward. If
      // there was nothing to commit (sandbox tree was empty), `headSha` is
      // undefined and we skip the push entirely.
      if (init.headSha) {
        const push = await pushBranch(id, {
          token,
          owner: body.owner,
          name: body.name,
          branch,
          setUpstream: true,
        });
        if (!push.ok) {
          return NextResponse.json(
            { error: `Initial push failed: ${push.message}`, stderr: push.stderr },
            { status: 500 },
          );
        }
        headSha = push.newSha ?? init.headSha;
      }
    } else {
      const clone = await cloneRepoIntoSandbox(id, {
        token,
        owner: body.owner,
        name: body.name,
        branch,
        wipe: true,
        identity,
      });
      if (!clone.ok) {
        return NextResponse.json({ error: clone.message, stderr: clone.stderr }, { status: 500 });
      }
      headSha = clone.info?.headSha ?? null;
    }

    // Persist link metadata.
    const [updated] = await db
      .update(projects)
      .set({
        githubRepoOwner: body.owner,
        githubRepoName: body.name,
        githubDefaultBranch: branch,
        githubLastPushedSha: headSha,
        // Reset autonomy so the agent re-asks the user on next turn.
        gitAutonomy: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();

    // Insert a bookkeeping message into the chat so the agent's next turn
    // knows GitHub was just linked and asks the user how they want commits
    // handled. The message is tagged `meta.systemNote: true` so the
    // AgentPanel renders it as a subtle chip rather than a normal user
    // bubble. Errors here are non-fatal — link succeeded, agent simply
    // won't auto-ask.
    try {
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.projectId, id))
        .limit(1);
      const sessionId = session?.id
        ?? (await db.insert(chatSessions).values({ projectId: id }).returning())[0].id;
      const segmentId = updated?.currentSegmentId ?? null;
      const messageText = [
        `[system-note] The user just linked the GitHub repo \`${body.owner}/${body.name}\` to this project.`,
        "",
        "Your first task: use the askQuestion tool to ask the user how they want git commits handled. Provide three options:",
        " (a) autonomous — you commit and push on your own after meaningful changes;",
        " (b) manual — you never run git; the user pushes from the panel;",
        " (c) ask-each-time — you confirm with askQuestion before every commit.",
        "",
        "Then call setGitAutonomy with the value they picked ('autonomous', 'manual', or 'ask-each-time').",
        "Do not perform any other work until autonomy is set.",
      ].join("\n");

      await db.insert(chatMessages).values({
        sessionId,
        messageId: `system-github-linked-${randomUUID()}`,
        role: "user",
        content: {
          parts: [{ type: "text", text: messageText }],
          meta: { systemNote: true, kind: "github-linked" },
        },
        segmentId,
      });
    } catch (e) {
      console.warn("[github/sandbox/link] Failed to insert bookkeeping message:", e);
    }

    return NextResponse.json({
      ok: true,
      project: updated,
      repo: {
        owner: body.owner,
        name: body.name,
        defaultBranch: branch,
        wasEmpty: repoIsEmpty,
      },
    });
  } catch (err) {
    console.error("POST /github/sandbox/link failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Link failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = getDb();
    const [proj] = await db.select().from(projects).where(eq(projects.id, id));
    if (!proj || proj.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [updated] = await db
      .update(projects)
      .set({
        githubRepoOwner: null,
        githubRepoName: null,
        githubDefaultBranch: "main",
        githubLastPushedSha: null,
        gitAutonomy: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();

    // The sandbox's .git directory is intentionally NOT removed — if the user
    // re-links to the same repo later they can keep their local history.
    const stillHasGit = await hasGitDir(id).catch(() => false);

    return NextResponse.json({ ok: true, project: updated, gitDirPreserved: stillHasGit });
  } catch (err) {
    console.error("DELETE /github/sandbox/link failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unlink failed" },
      { status: 500 },
    );
  }
}
