import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import type { SourceWorkspace } from "./source-workspace.js";

// Read-only filesystem tools for the HTTP-provider tool loop. Everything here is
// deliberately boring and bounded: string in, rendered string out, SourceToolError
// on misuse. The loop converts errors to tool results so the model can recover;
// nothing a model passes as an argument can reach outside a workspace root, and
// no raw fs error (ENOENT, EISDIR, EACCES…) may escape a tool — the loop rethrows
// anything that isn't a SourceToolError, crashing the job.

export class SourceToolError extends Error {}

export interface ToolBudget {
  remainingBytes: number;
}

const READ_CAP_BYTES = 32_000;
// Above this, reading whole files into memory is wasteful and the model should
// grep for the relevant sections instead of paging through with offsets.
const READ_MAX_FILE_BYTES = 5 * 1024 * 1024;
const GREP_MAX_MATCHES = 50;
const LIST_MAX_ENTRIES = 200;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", ".turbo"]);
// Same text-file gate the old sampler used (source-context.ts) — binary content
// is never useful to the model and wrecks budgets.
const TEXT_FILE = /\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|py|go|rs|cs|java|kt|swift|php|rb|css|scss|html|sql|sh|ps1|xml|csv)$/i;

// Tool paths are "<sourceId>/<relative posix path>"; "" or "<sourceId>" address the
// root. realpath containment catches both `..` traversal and symlink escapes.
export function resolveSourcePath(
  workspaces: SourceWorkspace[],
  requested: string
): { workspace: SourceWorkspace; absolutePath: string } {
  const normalized = requested.replaceAll("\\", "/").replace(/^\/+/, "");
  if (path.isAbsolute(requested)) {
    throw new SourceToolError(`absolute paths are not allowed: ${requested}`);
  }
  const [head, ...rest] = normalized.split("/").filter(Boolean);
  const workspace = workspaces.find((ws) => ws.sourceId === head);
  if (!workspace) {
    throw new SourceToolError(
      `unknown source "${head ?? ""}". Paths start with a source id: ${workspaces.map((ws) => `${ws.sourceId}/`).join(", ")}`
    );
  }
  const rootReal = realpathSync(workspace.rootDir);
  const candidate = path.resolve(rootReal, ...rest);
  const candidateReal = safeRealpath(candidate);
  if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep)) {
    throw new SourceToolError(`path escapes the source workspace: ${requested}`);
  }
  return { workspace, absolutePath: candidateReal };
}

// realpath of the deepest existing ancestor, so a not-yet-checked path still gets
// containment-checked (the fs call on it will produce the not-found error).
function safeRealpath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return path.join(safeRealpath(path.dirname(candidate)), path.basename(candidate));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function listDir(workspaces: SourceWorkspace[], requested: string): Promise<string> {
  if (requested.trim() === "") {
    return workspaces.map((ws) => `${ws.sourceId}/  (${ws.name})`).join("\n");
  }
  const { absolutePath } = resolveSourcePath(workspaces, requested);
  let dirents: Dirent[];
  try {
    if (!statSync(absolutePath).isDirectory()) {
      throw new SourceToolError(`not a directory: ${requested}`);
    }
    dirents = readdirSync(absolutePath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof SourceToolError) {
      throw error;
    }
    throw new SourceToolError(`cannot list ${requested}: ${reasonOf(error)}`);
  }
  const visible = dirents.filter((entry) => !IGNORED_DIRS.has(entry.name));
  const entries = visible.slice(0, LIST_MAX_ENTRIES).map((entry) => {
    if (entry.isDirectory()) {
      return `${entry.name}/`;
    }
    // The stat can race with a concurrent delete; the name alone is still useful.
    try {
      return `${entry.name}  (${statSync(path.join(absolutePath, entry.name)).size} bytes)`;
    } catch {
      return entry.name;
    }
  });
  if (visible.length > LIST_MAX_ENTRIES) {
    entries.push(`… (${LIST_MAX_ENTRIES} of ${visible.length} entries shown)`);
  }
  return entries.length > 0 ? entries.join("\n") : "(empty directory)";
}

export async function readFile(
  workspaces: SourceWorkspace[],
  requested: string,
  budget: ToolBudget,
  offset = 0
): Promise<string> {
  // This module is the boundary — validate arguments here, not in the caller's schema.
  if (!Number.isInteger(offset) || offset < 0) {
    throw new SourceToolError(`offset must be a non-negative integer, got ${offset}`);
  }
  const { absolutePath } = resolveSourcePath(workspaces, requested);
  if (!TEXT_FILE.test(absolutePath)) {
    throw new SourceToolError(`not a readable text file: ${requested}`);
  }
  if (budget.remainingBytes <= 0) {
    throw new SourceToolError("read budget exhausted; answer from what you have already read");
  }
  let content: string;
  try {
    // Stat first: a directory can carry a text-file name (e.g. "docs.md"), and
    // reading whole huge files into memory before slicing is a waste.
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      throw new SourceToolError(`not a file: ${requested}`);
    }
    if (stat.size > READ_MAX_FILE_BYTES) {
      throw new SourceToolError(
        `file too large to read (${stat.size} bytes, limit ${READ_MAX_FILE_BYTES}): ${requested}. Use grep to locate the relevant sections instead.`
      );
    }
    content = await fsReadFile(absolutePath, "utf8");
  } catch (error) {
    if (error instanceof SourceToolError) {
      throw error;
    }
    throw new SourceToolError(`cannot read ${requested}: ${reasonOf(error)}`);
  }
  const slice = content.slice(offset, offset + Math.min(READ_CAP_BYTES, budget.remainingBytes));
  // Slicing is by chars but the budget is bytes, so charge the slice's UTF-8 byte
  // length. A final read can overshoot the byte budget by up to the multibyte
  // factor before the ≤0 refusal above kicks in — acceptable for a soft cap.
  budget.remainingBytes -= Buffer.byteLength(slice, "utf8");
  const suffix = offset + slice.length < content.length
    ? `\n\n[truncated at ${offset + slice.length} of ${content.length} chars; re-call with offset=${offset + slice.length} if needed]`
    : "";
  return slice + suffix;
}

// Literal, case-insensitive substring search — deliberately not a regex. A
// model-supplied pattern can backtrack catastrophically (ReDoS) and a synchronous
// regex hang cannot be aborted, whereas literal matching is linear-time by
// construction. (The glob filter below is built from escaped input, so it is
// backtracking-safe and cannot throw.)
export async function grepWorkspaces(
  workspaces: SourceWorkspace[],
  query: string,
  glob?: string
): Promise<string> {
  if (query.trim() === "") {
    throw new SourceToolError("grep query must not be empty; pass the literal text to search for");
  }
  const needle = query.toLowerCase();
  const globRegex = glob ? globToRegex(glob) : undefined;
  const hits: string[] = [];
  for (const workspace of workspaces) {
    const keepWalking = walk(workspace.rootDir, (absolute) => {
      const relative = `${workspace.sourceId}/${path.relative(workspace.rootDir, absolute).replaceAll("\\", "/")}`;
      if (!TEXT_FILE.test(absolute) || (globRegex && !globRegex.test(relative))) {
        return true;
      }
      let content: string;
      try {
        content = readFileSync(absolute, "utf8");
      } catch {
        return true;
      }
      for (const line of content.split("\n")) {
        if (line.toLowerCase().includes(needle)) {
          hits.push(`${relative}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= GREP_MAX_MATCHES) {
            return false;
          }
        }
      }
      return true;
    });
    if (!keepWalking) {
      break;
    }
  }
  return hits.length > 0 ? hits.join("\n") : "(no matches)";
}

// Depth-first walk; visit returns false to stop the whole traversal (so the grep
// cap ends the walk instead of uselessly readdir-ing the rest of the tree).
function walk(dir: string, visit: (file: string) => boolean): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true; // unreadable subdirectory — skip it, keep walking elsewhere
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!walk(full, visit)) {
        return false;
      }
    } else if (entry.isFile()) {
      if (!visit(full)) {
        return false;
      }
    }
  }
  return true;
}

function globToRegex(glob: string): RegExp {
  // "*" matches within a path segment, "**" across segments. The "\0" placeholder
  // keeps the single-star replacement from mangling double stars.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replace(/\*/g, "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`, "i");
}
