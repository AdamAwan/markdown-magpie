import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import type { SourceWorkspace } from "./source-workspace.js";

// Read-only filesystem tools for the HTTP-provider tool loop. Everything here is
// deliberately boring and bounded: string in, rendered string out, SourceToolError
// on misuse. The loop converts errors to tool results so the model can recover;
// nothing a model passes as an argument can reach outside a workspace root.

export class SourceToolError extends Error {}

export interface ToolBudget {
  remainingBytes: number;
}

const READ_CAP_BYTES = 32_000;
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

export async function listDir(workspaces: SourceWorkspace[], requested: string): Promise<string> {
  if (requested.trim() === "") {
    return workspaces.map((ws) => `${ws.sourceId}/  (${ws.name})`).join("\n");
  }
  const { absolutePath } = resolveSourcePath(workspaces, requested);
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .slice(0, LIST_MAX_ENTRIES)
    .map((entry) => {
      if (entry.isDirectory()) {
        return `${entry.name}/`;
      }
      const size = statSync(path.join(absolutePath, entry.name)).size;
      return `${entry.name}  (${size} bytes)`;
    });
  return entries.length > 0 ? entries.join("\n") : "(empty directory)";
}

export async function readFile(
  workspaces: SourceWorkspace[],
  requested: string,
  budget: ToolBudget,
  offset = 0
): Promise<string> {
  const { absolutePath } = resolveSourcePath(workspaces, requested);
  if (!TEXT_FILE.test(absolutePath)) {
    throw new SourceToolError(`not a readable text file: ${requested}`);
  }
  if (budget.remainingBytes <= 0) {
    throw new SourceToolError("read budget exhausted; answer from what you have already read");
  }
  const content = await fsReadFile(absolutePath, "utf8");
  const slice = content.slice(offset, offset + Math.min(READ_CAP_BYTES, budget.remainingBytes));
  budget.remainingBytes -= slice.length;
  const suffix = offset + slice.length < content.length
    ? `\n\n[truncated at ${offset + slice.length} of ${content.length} chars; re-call with offset=${offset + slice.length} if needed]`
    : "";
  return slice + suffix;
}

export async function grepWorkspaces(
  workspaces: SourceWorkspace[],
  pattern: string,
  glob?: string
): Promise<string> {
  const regex = new RegExp(pattern, "i");
  const globRegex = glob ? globToRegex(glob) : undefined;
  const hits: string[] = [];
  for (const workspace of workspaces) {
    walk(workspace.rootDir, (absolute) => {
      if (hits.length >= GREP_MAX_MATCHES) {
        return;
      }
      const relative = `${workspace.sourceId}/${path.relative(workspace.rootDir, absolute).replaceAll("\\", "/")}`;
      if (!TEXT_FILE.test(absolute) || (globRegex && !globRegex.test(relative))) {
        return;
      }
      let content: string;
      try {
        content = readFileSync(absolute, "utf8");
      } catch {
        return;
      }
      for (const line of content.split("\n")) {
        if (regex.test(line)) {
          hits.push(`${relative}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= GREP_MAX_MATCHES) {
            return;
          }
        }
      }
    });
  }
  return hits.length > 0 ? hits.join("\n") : "(no matches)";
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
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
