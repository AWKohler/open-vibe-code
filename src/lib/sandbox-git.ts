/**
 * Server-side git operations for the sandboxed-web platform.
 *
 * The Vercel Sandbox has a real Linux runtime, so we delegate to the actual
 * `git` binary instead of reconstructing tree/blob/commit semantics over the
 * GitHub REST API (which is what the legacy webcontainer flow has to do).
 *
 * Token handling: the user's GitHub OAuth token is fetched from
 * user-credentials, injected into the remote URL just-in-time for push/pull,
 * and stripped immediately after. It is never persisted to the sandbox's
 * `.env`, `.git/config`, or any process env across calls.
 */
import { sandboxBash, sandboxRun } from "@/lib/vercel-sandbox";

const SANDBOX_ROOT = "/vercel/sandbox";

// ── Types ───────────────────────────────────────────────────────────────────

export type GitOk = { ok: true; stdout?: string; stderr?: string };
export type GitErr = { ok: false; message: string; stderr?: string; code?: string };
export type GitResult = GitOk | GitErr;

export interface ClonedRepoInfo {
  branch: string;
  headSha: string;
}

export interface GitStatusSummary {
  branch: string;
  ahead: number;
  behind: number;
  hasMerging: boolean;
  files: {
    added: string[];
    modified: string[];
    deleted: string[];
    untracked: string[];
    renamed: Array<{ from: string; to: string }>;
    conflicted: string[];
  };
  isClean: boolean;
}

export interface ConflictFileBlobs {
  /** Working-tree text after the failed merge — includes `<<<<<<<` markers. */
  marked: string;
  /** "ours" side (stage 2 — what we had locally before merging). */
  ours: string | null;
  /** "theirs" side (stage 3 — what came in from the remote). */
  theirs: string | null;
  /** Common ancestor (stage 1) — useful for three-way merge tooling. */
  base: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function authedUrl(owner: string, name: string, token: string): string {
  // Vercel reference uses <token>:x-oauth-basic@ — works the same way as bare
  // token-as-username. We use the bare form for simplicity. Token must be URL-
  // encoded since GitHub OAuth tokens are ASCII but defensive escaping is cheap.
  return `https://${encodeURIComponent(token)}@github.com/${owner}/${name}.git`;
}

function bareUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

function gitErr(stderr: string, message?: string, code?: string): GitErr {
  const trimmed = stderr.trim();
  return {
    ok: false,
    message: message ?? (trimmed || "git command failed"),
    stderr: trimmed || undefined,
    code,
  };
}

/**
 * Run a git invocation inside the project root. Always returns shape-stable
 * `{ exitCode, stdout, stderr }`. Caller decides how to interpret.
 */
async function git(
  projectId: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return sandboxRun(projectId, "git", args, { cwd: SANDBOX_ROOT });
}

// ── Identity ────────────────────────────────────────────────────────────────

async function setLocalIdentity(
  projectId: string,
  opts: { name?: string; email?: string },
): Promise<void> {
  const name = opts.name?.trim() || "Botflow";
  const email = opts.email?.trim() || "agent@botflow.dev";
  await git(projectId, ["config", "user.name", name]);
  await git(projectId, ["config", "user.email", email]);
}

// ── Clone / init ────────────────────────────────────────────────────────────

/**
 * Clone the user's GitHub repo into the persistent sandbox at /vercel/sandbox.
 *
 * Pre-conditions:
 *   - The sandbox exists (caller has run getOrCreatePersistentSandbox).
 *   - The sandbox may have template files in it; this function will refuse to
 *     overwrite them. Caller decides whether to wipe + clone, or `initAndPull`
 *     to layer the remote on top of existing files.
 *
 * Post-conditions:
 *   - `/vercel/sandbox/.git` exists.
 *   - `origin` remote is set to the bare HTTPS URL (no token).
 *   - HEAD is at the tip of `branch`.
 */
export async function cloneRepoIntoSandbox(
  projectId: string,
  opts: {
    token: string;
    owner: string;
    name: string;
    branch: string;
    /**
     * How to reconcile existing sandbox contents with the cloned tree:
     *   - "wipe": remove everything in the sandbox first, then clone fresh.
     *     Use only when caller knows the sandbox has no work to preserve.
     *   - "preserve-local": clone the repo elsewhere, then copy the .git
     *     directory plus any remote-only files into the sandbox while
     *     keeping the sandbox's existing files untouched on conflicts.
     *     The result: the sandbox's template/work files become uncommitted
     *     changes the user can save with a single "Save to GitHub" click.
     */
    strategy?: "wipe" | "preserve-local";
    /** Identity to set as git user.name / user.email after clone. */
    identity?: { name?: string; email?: string };
  },
): Promise<GitResult & { info?: ClonedRepoInfo }> {
  const { token, owner, name, branch, identity } = opts;
  const strategy = opts.strategy ?? "preserve-local";
  const auth = authedUrl(owner, name, token);
  const tmp = `/tmp/botflow-clone-${Date.now()}`;
  const escapedAuth = auth.replace(/'/g, "'\"'\"'");

  // Always clone to a temp dir first — git refuses to clone into a non-empty
  // directory, and we want full control over how the result lands in the
  // sandbox.
  const cloneScript = [
    "set -e",
    `rm -rf ${tmp}`,
    `git clone --depth 1 --branch '${branch.replace(/'/g, "'\\''")}' '${escapedAuth}' ${tmp}`,
  ].join(" && ");
  const cloneRes = await sandboxBash(projectId, cloneScript);
  if (cloneRes.exitCode !== 0) {
    return gitErr(cloneRes.stderr, "git clone failed");
  }

  if (strategy === "wipe") {
    // Wipe sandbox root, then move the cloned tree (including .git and
    // dotfiles) into place.
    const wipeRes = await sandboxBash(
      projectId,
      [
        "set -e",
        `find ${SANDBOX_ROOT} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
        `cp -a ${tmp}/. ${SANDBOX_ROOT}/`,
        `rm -rf ${tmp}`,
      ].join(" && "),
    );
    if (wipeRes.exitCode !== 0) {
      return gitErr(wipeRes.stderr, "Failed to install clone into sandbox");
    }
  } else {
    // preserve-local: move only the .git directory and any files that don't
    // already exist locally. Existing local files become uncommitted
    // modifications relative to HEAD; the user can save them with one click.
    //
    // `cp -a -n` (--no-clobber) skips files that exist; we use that for the
    // working-tree copy. The .git directory itself we always replace —
    // otherwise we'd end up with two .git folders.
    const layerRes = await sandboxBash(
      projectId,
      [
        "set -e",
        `rm -rf ${SANDBOX_ROOT}/.git`,
        `cp -a ${tmp}/.git ${SANDBOX_ROOT}/.git`,
        // Copy remote-only files into the sandbox without overwriting local
        // edits. `find -mindepth 1 -maxdepth 1` excludes the temp dir
        // itself and the cloned .git (already moved).
        `for src in ${tmp}/* ${tmp}/.[!.]* ${tmp}/..?*; do`,
        `  [ -e "$src" ] || continue`,
        `  base=$(basename "$src")`,
        `  [ "$base" = ".git" ] && continue`,
        `  if [ ! -e "${SANDBOX_ROOT}/$base" ]; then cp -a "$src" "${SANDBOX_ROOT}/$base"; fi`,
        `done`,
        `rm -rf ${tmp}`,
      ].join("\n"),
    );
    if (layerRes.exitCode !== 0) {
      return gitErr(layerRes.stderr, "Failed to layer clone over sandbox");
    }
  }

  // Strip the auth token from the remote URL and replace with the bare HTTPS URL.
  await git(projectId, ["remote", "set-url", "origin", bareUrl(owner, name)]);

  // Set identity for future commits.
  await setLocalIdentity(projectId, identity ?? {});

  // Capture HEAD SHA so the caller can persist it.
  const head = await git(projectId, ["rev-parse", "HEAD"]);
  const headSha = head.stdout.trim();

  return { ok: true, info: { branch, headSha } };
}

/**
 * Initialize a git repo on top of an existing sandbox tree and connect it to
 * a remote. Used when linking a repo to a sandbox that already has template
 * files: we want to keep the template files AND start tracking them.
 *
 * - If the repo on GitHub is empty: just `git init`, add the remote, commit
 *   the working tree as the initial commit (callers will push afterwards).
 * - If the repo on GitHub has content: this would conflict; caller should
 *   detect emptiness up front and call `cloneRepoIntoSandbox` with `wipe=true`
 *   for the non-empty case (or build a smarter reconciliation later).
 */
export async function initSandboxAsRepo(
  projectId: string,
  opts: {
    owner: string;
    name: string;
    branch: string;
    identity?: { name?: string; email?: string };
  },
): Promise<GitResult & { headSha?: string }> {
  const { owner, name, branch, identity } = opts;

  // Idempotent init: `git init` is safe to re-run.
  const init = await git(projectId, ["init", "-b", branch]);
  if (init.exitCode !== 0) {
    return gitErr(init.stderr, "git init failed");
  }

  // Add or update the remote.
  const url = bareUrl(owner, name);
  const hasRemote = await git(projectId, ["remote", "get-url", "origin"]);
  if (hasRemote.exitCode === 0) {
    await git(projectId, ["remote", "set-url", "origin", url]);
  } else {
    await git(projectId, ["remote", "add", "origin", url]);
  }

  await setLocalIdentity(projectId, identity ?? {});

  // Commit existing working tree as the initial commit.
  await git(projectId, ["add", "-A"]);
  // Stage check — if there's nothing to commit, skip.
  const staged = await git(projectId, ["diff", "--cached", "--name-only"]);
  if (staged.stdout.trim().length > 0) {
    const commit = await git(projectId, ["commit", "-m", "Initial commit from template"]);
    if (commit.exitCode !== 0) {
      return gitErr(commit.stderr, "Initial commit failed");
    }
  }

  const head = await git(projectId, ["rev-parse", "HEAD"]);
  return { ok: true, headSha: head.stdout.trim() };
}

// ── Status / diff ───────────────────────────────────────────────────────────

/**
 * Parse `git status --porcelain=v1 --branch` output into a structured summary.
 *
 * Porcelain v1 format reference: each line is `XY <path>` where:
 *   X = staged status, Y = working-tree status
 *   M = modified, A = added, D = deleted, R = renamed, ? = untracked, U = unmerged
 *
 * The first line, when --branch is passed, looks like:
 *   ## <branch>...<upstream> [ahead N, behind M]
 */
export async function getStatus(projectId: string): Promise<GitResult & { status?: GitStatusSummary }> {
  const res = await git(projectId, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]);
  if (res.exitCode !== 0) {
    return gitErr(res.stderr, "git status failed");
  }

  // Detect ongoing merge by the presence of .git/MERGE_HEAD.
  const mergeCheck = await sandboxBash(projectId, `test -f ${SANDBOX_ROOT}/.git/MERGE_HEAD && echo y || echo n`);
  const hasMerging = mergeCheck.stdout.trim() === "y";

  const summary: GitStatusSummary = {
    branch: "",
    ahead: 0,
    behind: 0,
    hasMerging,
    files: {
      added: [],
      modified: [],
      deleted: [],
      untracked: [],
      renamed: [],
      conflicted: [],
    },
    isClean: true,
  };

  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      // Branch line: "## main...origin/main [ahead 1, behind 2]"
      const rest = line.slice(3);
      const branchMatch = rest.match(/^([^.\s]+)(?:\.\.\.([^\s]+))?/);
      summary.branch = branchMatch?.[1] ?? rest.split(" ")[0] ?? "";
      const ahead = rest.match(/ahead (\d+)/);
      const behind = rest.match(/behind (\d+)/);
      if (ahead) summary.ahead = parseInt(ahead[1], 10);
      if (behind) summary.behind = parseInt(behind[1], 10);
      continue;
    }

    summary.isClean = false;
    const code = line.slice(0, 2);
    const rest = line.slice(3);

    // Conflict cases — both index and worktree carry U, or specific AA/DD combos
    if (code.includes("U") || code === "AA" || code === "DD") {
      summary.files.conflicted.push(rest);
      continue;
    }

    // Untracked
    if (code === "??") {
      summary.files.untracked.push(rest);
      continue;
    }

    // Renames: "R  oldpath -> newpath"
    if (code.startsWith("R")) {
      const arrow = rest.indexOf(" -> ");
      if (arrow >= 0) {
        summary.files.renamed.push({ from: rest.slice(0, arrow), to: rest.slice(arrow + 4) });
        continue;
      }
    }

    // Single-letter classify: union of staged + worktree state. Prefer the
    // strongest signal (D > A > M).
    const all = code.replace(/\s/g, "");
    if (all.includes("D")) summary.files.deleted.push(rest);
    else if (all.includes("A")) summary.files.added.push(rest);
    else if (all.includes("M")) summary.files.modified.push(rest);
  }

  return { ok: true, status: summary };
}

export async function getDiff(
  projectId: string,
  opts: { path?: string; staged?: boolean } = {},
): Promise<GitResult & { diff?: string }> {
  const args = ["diff", "--no-color"];
  if (opts.staged) args.push("--staged");
  if (opts.path) args.push("--", opts.path);
  const res = await git(projectId, args);
  if (res.exitCode !== 0) return gitErr(res.stderr, "git diff failed");
  return { ok: true, diff: res.stdout };
}

// ── Commit / push / pull ────────────────────────────────────────────────────

export async function commitAll(
  projectId: string,
  message: string,
  identity?: { name?: string; email?: string },
): Promise<GitResult & { sha?: string; nothingToCommit?: boolean }> {
  if (identity) await setLocalIdentity(projectId, identity);

  const add = await git(projectId, ["add", "-A"]);
  if (add.exitCode !== 0) return gitErr(add.stderr, "git add failed");

  // Check whether there's anything to commit.
  const staged = await git(projectId, ["diff", "--cached", "--name-only"]);
  if (staged.stdout.trim().length === 0) {
    return { ok: true, nothingToCommit: true };
  }

  const commit = await git(projectId, ["commit", "-m", message]);
  if (commit.exitCode !== 0) {
    return gitErr(commit.stderr, "git commit failed");
  }

  const head = await git(projectId, ["rev-parse", "HEAD"]);
  return { ok: true, sha: head.stdout.trim() };
}

/**
 * Run a closure with origin's URL temporarily rewritten to include the auth
 * token, restoring the bare URL afterwards no matter what. The token is never
 * persisted across calls.
 */
async function withAuthRemote<T>(
  projectId: string,
  opts: { token: string; owner: string; name: string },
  fn: () => Promise<T>,
): Promise<T> {
  const authedUrlStr = authedUrl(opts.owner, opts.name, opts.token);
  const bare = bareUrl(opts.owner, opts.name);
  await git(projectId, ["remote", "set-url", "origin", authedUrlStr]);
  try {
    return await fn();
  } finally {
    await git(projectId, ["remote", "set-url", "origin", bare]).catch(() => undefined);
  }
}

/**
 * Run `git fetch origin <branch>` so the cached `origin/<branch>` ref reflects
 * the latest commits on GitHub. Cheap, side-effect-only — does not touch the
 * working tree or local branches. Use before `getStatus` when you want
 * accurate behind counts.
 */
export async function fetchOrigin(
  projectId: string,
  opts: { token: string; owner: string; name: string; branch: string },
): Promise<GitResult> {
  return withAuthRemote(projectId, opts, async () => {
    const res = await git(projectId, ["fetch", "origin", opts.branch]);
    if (res.exitCode !== 0) return gitErr(res.stderr, "git fetch failed");
    return { ok: true };
  });
}

export async function pushBranch(
  projectId: string,
  opts: { token: string; owner: string; name: string; branch: string; force?: boolean; setUpstream?: boolean },
): Promise<GitResult & { newSha?: string; code?: "non-fast-forward" | "auth" }> {
  return withAuthRemote(projectId, opts, async () => {
    const args = ["push"];
    if (opts.force) args.push("--force-with-lease");
    if (opts.setUpstream) args.push("-u");
    args.push("origin", opts.branch);

    const res = await git(projectId, args);
    if (res.exitCode !== 0) {
      const stderr = res.stderr.trim();
      if (/non-fast-forward|fetch first|rejected/i.test(stderr)) {
        return { ok: false as const, message: "Remote has changes not in your local branch. Pull first or force-push.", stderr, code: "non-fast-forward" as const };
      }
      if (/Authentication failed|Invalid username or password|403|denied/i.test(stderr)) {
        return { ok: false as const, message: "GitHub denied the push. Check repo access.", stderr, code: "auth" as const };
      }
      return { ok: false as const, message: "git push failed", stderr };
    }

    const head = await git(projectId, ["rev-parse", "HEAD"]);
    return { ok: true as const, newSha: head.stdout.trim() };
  });
}

/**
 * Fetch + merge. Pre-commits uncommitted local changes as a "WIP" commit
 * before merging so that conflicts have the user-expected ours/theirs
 * semantics ("ours" = my local edits, "theirs" = what GitHub has).
 *
 * We previously used `git stash push` / `git stash pop`, but that inverts
 * the semantics during a pop conflict: stash content lands as `theirs` and
 * post-merge HEAD as `ours`. That made "Use GitHub's" in the conflict
 * modal silently apply the local edits.
 *
 * Returns:
 *   - `{ ok: true, clean: true, changed }` on a clean merge / fast-forward.
 *     `changed` indicates whether HEAD moved (so the UI can distinguish
 *     "pulled new commits" from "already up to date").
 *   - `{ ok: true, clean: false, conflicts }` when files conflict.
 *   - `GitErr` for unrecoverable failures.
 */
export async function pullBranch(
  projectId: string,
  opts: { token: string; owner: string; name: string; branch: string },
): Promise<
  | (GitOk & { clean: true; changed: boolean })
  | (GitOk & { clean: false; conflicts: string[] })
  | GitErr
> {
  return withAuthRemote(projectId, opts, async () => {
    const fetch = await git(projectId, ["fetch", "origin", opts.branch]);
    if (fetch.exitCode !== 0) {
      return gitErr(fetch.stderr, "git fetch failed");
    }

    const before = await git(projectId, ["rev-parse", "HEAD"]);
    const beforeSha = before.exitCode === 0 ? before.stdout.trim() : "";

    // Pre-commit any pending changes so the merge sees them on `ours`.
    const dirty = await git(projectId, ["status", "--porcelain"]);
    const hasDirty = dirty.stdout.trim().length > 0;
    if (hasDirty) {
      // Ensure an identity exists; without it `git commit` fails. The
      // link/clone path sets one, but be defensive for older sandboxes.
      await setLocalIdentity(projectId, {});
      const add = await git(projectId, ["add", "-A"]);
      if (add.exitCode !== 0) {
        return gitErr(add.stderr, "Could not stage your pending changes before pulling.");
      }
      const wip = await git(projectId, [
        "commit",
        "-m",
        "Local changes (pre-pull snapshot)",
        "--allow-empty",
        "--no-verify",
      ]);
      if (wip.exitCode !== 0) {
        return gitErr(wip.stderr, "Could not commit your pending changes before pulling.");
      }
    }

    const merge = await git(projectId, ["merge", "--no-edit", `origin/${opts.branch}`]);

    if (merge.exitCode === 0) {
      const after = await git(projectId, ["rev-parse", "HEAD"]);
      const afterSha = after.exitCode === 0 ? after.stdout.trim() : "";
      return {
        ok: true as const,
        clean: true as const,
        changed: afterSha !== beforeSha,
      };
    }

    // Merge produced conflicts. With the WIP commit approach, ours = local
    // changes (the WIP commit on the current branch) and theirs = remote —
    // matching what the conflict modal labels.
    const status = await getStatus(projectId);
    if (status.ok && status.status && status.status.files.conflicted.length > 0) {
      return {
        ok: true as const,
        clean: false as const,
        conflicts: status.status.files.conflicted,
      };
    }

    return gitErr(merge.stderr, "git merge failed");
  });
}

// ── Conflict resolution ─────────────────────────────────────────────────────

/**
 * Pull the three stages of a conflicted file from the index, so the conflict
 * UI can show side-by-side content. Stages:
 *   1 = common ancestor
 *   2 = "ours" (the local branch's version)
 *   3 = "theirs" (the incoming version)
 *
 * Plus the working-tree text which contains the `<<<<<<<` markers.
 *
 * Returns null content for stages that don't exist (e.g. file was newly
 * added on one side — the ancestor doesn't have it).
 */
export async function getConflictBlobs(
  projectId: string,
  path: string,
): Promise<GitResult & { blobs?: ConflictFileBlobs }> {
  async function show(stage: 1 | 2 | 3): Promise<string | null> {
    const res = await git(projectId, ["show", `:${stage}:${path}`]);
    if (res.exitCode !== 0) return null;
    return res.stdout;
  }

  async function readWorkingTree(): Promise<string> {
    const res = await sandboxBash(projectId, `cat ${SANDBOX_ROOT}/${path.replace(/^\//, "").replace(/'/g, "'\\''")}`);
    return res.stdout;
  }

  const [base, ours, theirs, marked] = await Promise.all([
    show(1),
    show(2),
    show(3),
    readWorkingTree(),
  ]);

  return { ok: true, blobs: { marked, ours, theirs, base } };
}

export async function resolveWithSide(
  projectId: string,
  path: string,
  side: "ours" | "theirs",
): Promise<GitResult> {
  const checkout = await git(projectId, ["checkout", `--${side}`, "--", path]);
  if (checkout.exitCode !== 0) {
    return gitErr(checkout.stderr, "git checkout --ours/--theirs failed");
  }
  const add = await git(projectId, ["add", "--", path]);
  if (add.exitCode !== 0) {
    return gitErr(add.stderr, "git add after resolve failed");
  }
  return { ok: true };
}

export async function resolveWithContent(
  projectId: string,
  path: string,
  content: string,
): Promise<GitResult> {
  // Write directly; sandboxWriteFile handles parent dirs.
  const { sandboxWriteFile } = await import("@/lib/vercel-sandbox");
  await sandboxWriteFile(projectId, path, content);
  const add = await git(projectId, ["add", "--", path]);
  if (add.exitCode !== 0) {
    return gitErr(add.stderr, "git add after resolve failed");
  }
  return { ok: true };
}

export async function finalizeMerge(
  projectId: string,
  message?: string,
  identity?: { name?: string; email?: string },
): Promise<GitResult & { sha?: string }> {
  if (identity) await setLocalIdentity(projectId, identity);

  // If conflict markers remain (`git diff --check` non-zero), refuse.
  const check = await git(projectId, ["diff", "--check"]);
  if (check.exitCode !== 0) {
    return gitErr(check.stdout || check.stderr, "Conflict markers still present in working tree");
  }

  const args = ["commit"];
  if (message) args.push("-m", message);
  else args.push("--no-edit"); // Use git's default merge commit message
  const commit = await git(projectId, args);
  if (commit.exitCode !== 0) return gitErr(commit.stderr, "Finalize merge commit failed");

  const head = await git(projectId, ["rev-parse", "HEAD"]);
  return { ok: true, sha: head.stdout.trim() };
}

export async function abortMerge(projectId: string): Promise<GitResult> {
  const res = await git(projectId, ["merge", "--abort"]);
  if (res.exitCode !== 0) return gitErr(res.stderr, "git merge --abort failed");

  // If the last commit is the pre-pull WIP snapshot we created in
  // pullBranch, undo it so the user is restored to their pre-pull state
  // with local edits as uncommitted changes (what they expect from
  // "Discard my changes").
  const lastMsg = await git(projectId, ["log", "-1", "--pretty=%s"]);
  if (lastMsg.exitCode === 0 && lastMsg.stdout.trim() === "Local changes (pre-pull snapshot)") {
    const undo = await git(projectId, ["reset", "--mixed", "HEAD~1"]);
    if (undo.exitCode !== 0) {
      return gitErr(undo.stderr, "Merge aborted but couldn't restore local edits.");
    }
  }
  return { ok: true };
}

// ── Misc utilities for the agent ────────────────────────────────────────────

export async function gitLog(
  projectId: string,
  opts: { limit?: number; branch?: string } = {},
): Promise<GitResult & { entries?: Array<{ sha: string; subject: string; author: string; date: string }> }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const args = ["log", `-${limit}`, "--pretty=format:%H%x00%s%x00%an%x00%aI"];
  if (opts.branch) args.push(opts.branch);
  const res = await git(projectId, args);
  if (res.exitCode !== 0) return gitErr(res.stderr, "git log failed");

  const entries = res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, date] = line.split("\x00");
      return { sha, subject, author, date };
    });
  return { ok: true, entries };
}

export async function getCurrentBranch(projectId: string): Promise<GitResult & { branch?: string }> {
  const res = await git(projectId, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.exitCode !== 0) return gitErr(res.stderr, "Failed to read current branch");
  return { ok: true, branch: res.stdout.trim() };
}

export async function hasGitDir(projectId: string): Promise<boolean> {
  const res = await sandboxBash(projectId, `test -d ${SANDBOX_ROOT}/.git && echo y || echo n`);
  return res.stdout.trim() === "y";
}
