import { tool } from "ai";
import { z } from "zod";
import {
  sandboxBash,
  sandboxGlob,
  sandboxGrep,
  sandboxListFiles,
  sandboxReadFile,
  sandboxWriteFile,
} from "@/lib/vercel-sandbox";
import { applyDiff } from "@/lib/agent/diff";

// Server-side tool execution for the persistent (Vercel Sandbox) platform.
// Each tool's execute() runs in the Next.js route handler and talks directly
// to the user's persistent sandbox. The browser never sees these calls.

const MAX_OUTPUT = 60_000; // truncate large outputs to keep context reasonable

function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.8));
  const tail = s.slice(-Math.floor(max * 0.2));
  return `${head}\n\n…(truncated ${s.length - max} chars)…\n\n${tail}`;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// Wrap an async tool body so any thrown error is returned as a JSON string
// the model can read and recover from, rather than aborting the stream.
function safe<T>(fn: () => Promise<T>): Promise<string> {
  return fn().then(
    (result) =>
      typeof result === "string" ? result : JSON.stringify(result),
    (e) => JSON.stringify({ ok: false, error: errMsg(e) }),
  );
}

export function getPersistentTools(projectId: string) {
  return {
    bash: tool({
      description:
        "Run a shell command in the persistent sandbox (bash -lc). Working directory is the project root (/vercel/sandbox). " +
        "Returns stdout, stderr, and exit code. Use for git operations, quick file inspection (cat/wc/head), JSON/YAML queries with jq/yq, " +
        "or any task the dedicated tools (read/write/edit/grep/glob) don't already cover. " +
        "Always pass a short `description` so the user can see what's running.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute (passed to `bash -lc`)."),
        description: z
          .string()
          .describe("5-10 word summary of what the command does, e.g. 'list staged git changes'."),
        cwd: z.string().optional().describe("Working directory inside the sandbox (default: /vercel/sandbox)."),
      }),
      async execute({ command, cwd }) {
        return safe(async () => {
          const res = await sandboxBash(projectId, command, cwd ? { cwd } : {});
          return {
            exitCode: res.exitCode,
            stdout: truncate(res.stdout),
            stderr: truncate(res.stderr),
          };
        });
      },
    }),

    glob: tool({
      description:
        "Find files by glob pattern (bash globstar). Examples: '*.swift', 'Sources/**/*.swift', '**/*.{json,yml}'. " +
        "Excludes node_modules and .git. Returns project-relative paths.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern, e.g. '**/*.swift'"),
        path: z
          .string()
          .optional()
          .describe("Project-relative directory to search inside (default: '/')"),
      }),
      async execute({ pattern, path }) {
        return safe(async () => {
          const matches = await sandboxGlob(projectId, pattern, { path });
          return { count: matches.length, files: matches };
        });
      },
    }),

    grep: tool({
      description:
        "Recursive content search (ripgrep). Pattern can be regex. Use to find symbols, references, or text across the project. " +
        "Excludes node_modules and .git. Returns up to 200 matches as { file, line, text }.",
      inputSchema: z.object({
        pattern: z.string().describe("Search pattern (regex)."),
        path: z.string().optional().describe("Project-relative path to search (default: '/')"),
        glob: z.string().optional().describe("Filter by file glob, e.g. '*.swift', '*.ts'"),
        caseInsensitive: z.boolean().optional().describe("Case-insensitive match (default: false)"),
      }),
      async execute({ pattern, path, glob, caseInsensitive }) {
        return safe(async () => {
          const results = await sandboxGrep(projectId, pattern, { path, glob, caseInsensitive });
          return { count: results.length, matches: results };
        });
      },
    }),

    read: tool({
      description:
        "Read a UTF-8 text file. Use project-relative paths starting with '/'. " +
        "For binary files (images, etc.) the response will indicate binary content.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path, e.g. '/Sources/Views/ContentView.swift'"),
      }),
      async execute({ path }) {
        return safe(async () => {
          const result = await sandboxReadFile(projectId, path);
          if (!result) return { ok: false, error: "File not found", path };
          if (result.binary) return { ok: true, binary: true, path };
          return { ok: true, path, content: truncate(result.content) };
        });
      },
    }),

    write: tool({
      description:
        "Write a file (creates or completely overwrites). Use for new files or full rewrites. " +
        "For surgical edits to existing files, prefer `edit` or `applyDiff`.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path, e.g. '/Sources/Views/NewView.swift'"),
        content: z.string().describe("Full file contents to write."),
      }),
      async execute({ path, content }) {
        return safe(async () => {
          await sandboxWriteFile(projectId, path, content);
          return { ok: true, path, bytes: content.length };
        });
      },
    }),

    edit: tool({
      description:
        "Exact-string replacement in an existing file. `oldString` MUST be unique in the file (include surrounding " +
        "context if the literal text appears more than once) — otherwise pass `replaceAll: true` for symbol renames. " +
        "Always `read` the file first to know the exact contents.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path of the file to edit."),
        oldString: z.string().describe("The exact text to replace (whitespace-sensitive)."),
        newString: z.string().describe("The replacement text."),
        replaceAll: z
          .boolean()
          .optional()
          .describe("Replace every occurrence (use for renames). Default: false."),
      }),
      async execute({ path, oldString, newString, replaceAll }) {
        return safe(async () => {
          const file = await sandboxReadFile(projectId, path);
          if (!file) return { ok: false, error: "File not found", path };
          if (file.binary) return { ok: false, error: "Cannot edit binary file", path };

          const original = file.content;
          if (!original.includes(oldString)) {
            return {
              ok: false,
              error: "oldString not found in file. Read the file again and retry with exact contents.",
              path,
            };
          }

          let updated: string;
          let count = 0;
          if (replaceAll) {
            const parts = original.split(oldString);
            count = parts.length - 1;
            updated = parts.join(newString);
          } else {
            const occurrences = original.split(oldString).length - 1;
            if (occurrences > 1) {
              return {
                ok: false,
                error: `oldString matched ${occurrences} times — make it unique by adding surrounding context, or pass replaceAll=true.`,
                path,
                occurrences,
              };
            }
            count = 1;
            updated = original.replace(oldString, newString);
          }

          await sandboxWriteFile(projectId, path, updated);
          return { ok: true, path, replacements: count };
        });
      },
    }),

    applyDiff: tool({
      description:
        "Apply one or more SEARCH/REPLACE blocks to a single file using fuzzy matching (85% similarity). " +
        "Use when several non-adjacent regions need editing in one shot. For a single edit, prefer `edit`. " +
        "Format: <<<<<<< SEARCH\\n[content]\\n=======\\n[replacement]\\n>>>>>>> REPLACE",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path."),
        diff: z.string().describe("One or more SEARCH/REPLACE blocks."),
      }),
      async execute({ path, diff }) {
        return safe(async () => {
          const file = await sandboxReadFile(projectId, path);
          if (!file) return { ok: false, error: "File not found", path };
          if (file.binary) return { ok: false, error: "Cannot edit binary file", path };

          const result = applyDiff(file.content, diff);
          if (!result.success || !result.content) {
            return {
              ok: false,
              applied: result.appliedCount,
              failed: result.failedBlocks.length,
              error: result.error ?? "Diff failed",
              failedBlocks: result.failedBlocks.map(b => ({
                index: b.index,
                reason: b.reason,
                searchPreview: b.searchPreview,
                bestMatch: b.bestMatch,
              })),
            };
          }

          await sandboxWriteFile(projectId, path, result.content);
          return { ok: true, applied: result.appliedCount, path };
        });
      },
    }),

    listFiles: tool({
      description:
        "List entries in a directory. Set `recursive: true` to walk subtrees. " +
        "Excludes node_modules, .git, and .DS_Store. Prefer `glob` or `grep` for targeted lookups.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative directory, e.g. '/Sources'"),
        recursive: z.boolean().optional().describe("Walk subdirectories (default: false)"),
      }),
      async execute({ path, recursive }) {
        return safe(async () => {
          const entries = await sandboxListFiles(projectId, path, Boolean(recursive));
          return { count: entries.length, entries };
        });
      },
    }),

    endTurn: tool({
      description:
        "Call this tool when you have completed the user's request. You MUST call this when you are done with your task.",
      inputSchema: z.object({
        summary: z.string().describe("A brief summary of what you accomplished."),
      }),
      async execute({ summary }) {
        return summary;
      },
    }),
  } as const;
}
