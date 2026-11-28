import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readFile as fsReadFile, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { SourceWorkspace } from "./source-workspace.js";

// Read-only filesystem tools for the HTTP-provider tool loop. Everything here is
// deliberately boring and bounded: string in, rendered string out, SourceToolError
// on misuse. The loop shows SourceToolError to the model as an error result so it
// can recover; nothing a model passes as an argument can reach outside a workspace
// root, and no raw fs error (ENOENT, EISDIR, EACCES…) may reach the model — the
// loop treats anything that isn't a SourceToolError as an infrastructure fault
// and fails the job.

export class SourceToolError extends Error {}

export interface ToolBudget {
  remainingBytes: number;
}

const READ_CAP_BYTES = 32_000;
// Above this, reading whole files into memory is wasteful and the model should
// grep for the relevant sections instead of paging through with offsets.
const READ_MAX_FILE_BYTES = 5 * 1024 * 1024;
const GREP_MAX_MATCHES = 50;
// grep scan bounds (see grepWorkspaces): files examined, bytes read from any one
// file, and bytes read across the whole search.
const GREP_MAX_FILES = 5_000;
const GREP_MAX_FILE_BYTES = 1024 * 1024;
const GREP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const LIST_MAX_ENTRIES = 200;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", ".turbo"]);
// The text-file gate (inherited from the corpus sampler this path replaced) —
// binary content is never useful to the model and wrecks budgets.
const TEXT_FILE =
  /\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|py|go|rs|cs|java|kt|swift|php|rb|css|scss|html|sql|sh|ps1|xml|csv)$/i;

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

// Node fs errors embed the ABSOLUTE host path in their `.message` (e.g.
// "ENOENT: no such file or directory, stat '/srv/checkouts/<sha>/x.md'"). These
// reasons are rendered into model-visible tool-error strings and sent to the
// provider on the next turn, so surface only the errno `code` — never the raw
// message. The model-supplied path is echoed by the caller for context.
function reasonOf(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "read failed";
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
  const suffix =
    offset + slice.length < content.length
      ? `\n\n[truncated at ${offset + slice.length} of ${content.length} chars; re-call with offset=${offset + slice.length} if needed]`
      : "";
  return slice + suffix;
}

// Literal, case-insensitive substring search — deliberately not a regex. A
// model-supplied pattern can backtrack catastrophically (ReDoS) and a synchronous
// regex hang cannot be aborted, whereas literal matching is linear-time by
// construction. The glob filter uses the same principle: an iterative wildcard
// matcher, never a RegExp compiled from model input.
//
// Bounded on every axis (TM32 in docs/threat-model.md, J87 in docs/ai-jobs.md): a checkout can be huge, so
// the walk is async (it never blocks the event loop the heartbeat and abort run
// on), stops after GREP_MAX_FILES files or GREP_MAX_TOTAL_BYTES scanned, reads
// at most GREP_MAX_FILE_BYTES of any one file, skips binary content, honours the
// abort signal between files, and charges the rendered result against the same
// read budget read_file and fetch_url draw from.
interface GrepLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
  maxMatches: number;
}

const DEFAULT_GREP_LIMITS: GrepLimits = {
  maxFiles: GREP_MAX_FILES,
  maxBytesPerFile: GREP_MAX_FILE_BYTES,
  maxTotalBytes: GREP_MAX_TOTAL_BYTES,
  maxMatches: GREP_MAX_MATCHES
};

interface GrepOptions {
  // The loop's shared read budget. The rendered result is charged against it and
  // a grep is refused once it is exhausted, exactly like read_file.
  budget?: ToolBudget;
  signal?: AbortSignal;
  // Test seam: tighter caps so the bounds are exercisable on a small fixture.
  limits?: Partial<GrepLimits>;
}

export async function grepWorkspaces(
  workspaces: SourceWorkspace[],
  query: string,
  glob?: string,
  options: GrepOptions = {}
): Promise<string> {
  if (query.trim() === "") {
    throw new SourceToolError("grep query must not be empty; pass the literal text to search for");
  }
  const { budget, signal } = options;
  if (budget && budget.remainingBytes <= 0) {
    throw new SourceToolError("read budget exhausted; answer from what you have already read");
  }
  const limits: GrepLimits = { ...DEFAULT_GREP_LIMITS, ...options.limits };
  const needle = query.toLowerCase();
  const globTokens = glob === undefined ? undefined : tokenizeGlob(glob);
  const hits: string[] = [];
  const scan = { files: 0, bytes: 0, skippedBinary: 0, truncatedFiles: 0 };
  let stopReason: string | undefined;

  const visit = async (workspace: SourceWorkspace, absolute: string): Promise<boolean> => {
    signal?.throwIfAborted();
    const relative = `${workspace.sourceId}/${path.relative(workspace.rootDir, absolute).replaceAll("\\", "/")}`;
    if (!TEXT_FILE.test(absolute) || (globTokens && !matchGlob(globTokens, relative))) {
      return true;
    }
    if (scan.files >= limits.maxFiles) {
      stopReason = `scanned the ${limits.maxFiles}-file limit`;
      return false;
    }
    const remainingTotal = limits.maxTotalBytes - scan.bytes;
    if (remainingTotal <= 0) {
      stopReason = `scanned the ${limits.maxTotalBytes}-byte limit`;
      return false;
    }
    const head = await readHead(absolute, Math.min(limits.maxBytesPerFile, remainingTotal));
    if (!head) {
      return true; // unreadable (raced delete, permissions) — skip, keep walking
    }
    scan.files += 1;
    scan.bytes += head.bytes.length;
    if (head.truncated) {
      scan.truncatedFiles += 1;
    }
    if (looksBinary(head.bytes)) {
      scan.skippedBinary += 1;
      return true;
    }
    for (const line of head.bytes.toString("utf8").split("\n")) {
      if (line.toLowerCase().includes(needle)) {
        hits.push(`${relative}: ${line.trim().slice(0, 200)}`);
        if (hits.length >= limits.maxMatches) {
          stopReason = `reached the ${limits.maxMatches}-match limit`;
          return false;
        }
      }
    }
    return true;
  };

  for (const workspace of workspaces) {
    if (!(await walk(workspace.rootDir, (absolute) => visit(workspace, absolute), signal))) {
      break;
    }
  }

  const notes: string[] = [];
  if (stopReason) {
    notes.push(`search stopped early: ${stopReason}; narrow the query or pass a glob to see more`);
  }
  if (scan.truncatedFiles > 0) {
    notes.push(`only the first ${limits.maxBytesPerFile} bytes of ${scan.truncatedFiles} large file(s) were searched`);
  }
  const body = hits.length > 0 ? hits.join("\n") : "(no matches)";
  const rendered = notes.length > 0 ? `${body}\n\n[${notes.join("; ")}]` : body;
  if (budget) {
    budget.remainingBytes -= Buffer.byteLength(rendered, "utf8");
  }
  return rendered;
}

// Reads at most `cap` bytes from the start of a file. Undefined when the file
// cannot be opened or read — a grep skips such files rather than failing.
async function readHead(absolute: string, cap: number): Promise<{ bytes: Buffer; truncated: boolean } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, "r");
    const size = (await handle.stat()).size;
    const length = Math.min(size, cap);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, 0) : { bytesRead: 0 };
    return { bytes: buffer.subarray(0, bytesRead), truncated: size > cap };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// A NUL byte in the first 8 KB is the conventional (git/grep) binary heuristic: a
// mislabelled or generated ".json"/".txt" blob is never useful match output.
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

// Depth-first async walk; visit resolves false to stop the whole traversal (so a
// grep cap ends the walk instead of uselessly readdir-ing the rest of the tree).
async function walk(
  dir: string,
  visit: (file: string) => Promise<boolean>,
  signal: AbortSignal | undefined
): Promise<boolean> {
  signal?.throwIfAborted();
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return true; // unreadable subdirectory — skip it, keep walking elsewhere
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(await walk(full, visit, signal))) {
        return false;
      }
    } else if (entry.isFile()) {
      if (!(await visit(full))) {
        return false;
      }
    }
  }
  return true;
}

// Glob semantics for the grep path filter: "*" matches within a path segment,
// "**" across segments; everything else is a literal, case-insensitive character.
// Deliberately NOT compiled to a RegExp — a model-supplied glob converted to
// ".*"-style patterns backtracks catastrophically on pathological inputs. The
// dynamic-programming matcher below is O(path length × token count) worst case.
type GlobToken = { kind: "char"; value: string } | { kind: "star" } | { kind: "globstar" };

function tokenizeGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < glob.length) {
    if (glob[i] === "*") {
      let stars = 0;
      while (glob[i] === "*") {
        stars += 1;
        i += 1;
      }
      tokens.push(stars > 1 ? { kind: "globstar" } : { kind: "star" });
    } else {
      tokens.push({ kind: "char", value: glob[i]!.toLowerCase() });
      i += 1;
    }
  }
  return tokens;
}

function matchGlob(tokens: GlobToken[], candidate: string): boolean {
  const text = candidate.toLowerCase();
  // matched[j]: whether tokens[0..j) match the text consumed so far. Rolled
  // forward one character at a time — no backtracking, ever.
  let matched: boolean[] = new Array<boolean>(tokens.length + 1).fill(false);
  matched[0] = true;
  for (let j = 1; j <= tokens.length; j += 1) {
    matched[j] = matched[j - 1]! && tokens[j - 1]!.kind !== "char";
  }
  for (const ch of text) {
    const next: boolean[] = new Array<boolean>(tokens.length + 1).fill(false);
    for (let j = 1; j <= tokens.length; j += 1) {
      const token = tokens[j - 1]!;
      if (token.kind === "char") {
        next[j] = matched[j - 1]! && token.value === ch;
      } else if (token.kind === "star") {
        next[j] = next[j - 1]! || (matched[j]! && ch !== "/");
      } else {
        next[j] = next[j - 1]! || matched[j]!;
      }
    }
    matched = next;
  }
  return matched[tokens.length]!;
}
