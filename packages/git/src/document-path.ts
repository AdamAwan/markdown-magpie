import type { ChangesetChange } from "@magpie/core";

// The ONE policy for which files Magpie may write or delete in a destination
// repository. Model output chooses the paths of multi-file changesets (dedupe,
// split, fold_changeset_proposal), so a prompt-injected document could otherwise
// steer a change at `.github/workflows/x.yml`, `package.json`, or anything outside
// the destination's configured subpath — and that branch is pushed and a PR opened
// automatically. Shared by the API (rejects an offending changeset before any
// proposal exists) and the publisher in this package (refuses it again just
// before touching the working tree), so the two checks can never drift apart.
//
// The check is deliberately strict rather than normalising: a path is accepted
// only when it is ALREADY a canonical, relative, posix document path. Anything
// that would need rewriting to become safe (`./a.md`, `a//b.md`, `a\\b.md`,
// `/a.md`) is rejected outright, because a rewrite is exactly where a
// lookalike slips through.

export type DocumentPathCheck = { ok: true; path: string } | { ok: false; reason: string };

// Matches what the indexer accepts (`findMarkdownFiles`: a case-insensitive
// `.md` suffix). Nothing in Magpie produces `.mdx`/`.markdown` documents.
const DOCUMENT_EXTENSION = ".md";
// Never indexed (findMarkdownFiles skips it), so never a legitimate target.
const RESERVED_SEGMENTS = new Set(["node_modules"]);
const FORMAT_CHARACTER = /\p{Cf}/u;

// Validates one destination document path and, when `subtree` is given, returns
// it as a repository-root-relative path that lies inside that subtree.
//
// `rawPath` is in the destination's document path space: relative to the
// indexed subtree (the destination's configured subpath), or already carrying
// that subtree as its prefix (resolveProposalTargetPath's shape). `subtree` is
// the indexed subtree relative to the git work-tree root (the publisher's
// `relativePathFromRoot`; `.`/empty/undefined for a repository-root index). The
// API omits it: its paths are already subtree-relative, so a path that passes the
// structural rules cannot leave the subtree.
export function checkDocumentPath(rawPath: string, subtree?: string): DocumentPathCheck {
  const structural = checkStructure(rawPath);
  if (!structural.ok) {
    return structural;
  }
  const prefix = normalizeSubtree(subtree);
  if (prefix === undefined) {
    return { ok: true, path: rawPath };
  }
  const resolved = rawPath === prefix || rawPath.startsWith(`${prefix}/`) ? rawPath : `${prefix}/${rawPath}`;
  // Re-asserted after the join rather than assumed: the prefix comes from
  // configuration, so the joined path must still sit strictly under it.
  if (!resolved.startsWith(`${prefix}/`)) {
    return { ok: false, reason: `path must stay inside the destination subpath "${prefix}"` };
  }
  return { ok: true, path: resolved };
}

// The first changeset entry whose path breaks the policy, or undefined when the
// whole file-set is publishable. Every path-bearing field is checked: a change is
// `{ path, content?, delete? }`, and `path` is both the write target and the
// delete target (there is no rename field — a move is a delete plus a write, so
// both halves are checked here).
export function findUnsafeChangesetPath(
  changes: readonly ChangesetChange[],
  subtree?: string
): { path: string; reason: string } | undefined {
  for (const change of changes) {
    const check = checkDocumentPath(change.path, subtree);
    if (!check.ok) {
      return { path: change.path, reason: check.reason };
    }
  }
  return undefined;
}

function checkStructure(rawPath: string): DocumentPathCheck {
  if (rawPath.length === 0) {
    return { ok: false, reason: "path is empty" };
  }
  if (hasControlCharacter(rawPath)) {
    return { ok: false, reason: "path contains a control character" };
  }
  // Zero-width joiners, bidi overrides and other invisible format characters: some
  // filesystems (HFS+) ignore them when comparing names, so `.git\u200c` can alias
  // `.git`. No legitimate document name carries one.
  if (FORMAT_CHARACTER.test(rawPath)) {
    return { ok: false, reason: "path contains an invisible Unicode format character" };
  }
  if (rawPath.includes("\\")) {
    return { ok: false, reason: "path must use forward slashes (backslash found)" };
  }
  // Covers drive letters (`C:`), Windows alternate data streams (`a.md:x`), and
  // URL-ish schemes (`file:`).
  if (rawPath.includes(":")) {
    return { ok: false, reason: "path must not contain a colon (drive letter or stream)" };
  }
  if (rawPath.startsWith("/")) {
    return { ok: false, reason: "path must be relative, not absolute" };
  }
  if (rawPath.startsWith("~")) {
    return { ok: false, reason: "path must not start with a home-directory shorthand" };
  }
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (segment === "") {
      return { ok: false, reason: "path has an empty segment (doubled or trailing slash)" };
    }
    if (segment === "..") {
      return { ok: false, reason: "path must not contain a `..` segment" };
    }
    if (segment.startsWith(".")) {
      return { ok: false, reason: `path must not contain a dot-segment ("${segment}")` };
    }
    // Windows silently strips trailing dots/spaces (so `.. ` resolves as `..`);
    // reject them everywhere rather than reason about which host strips what.
    if (segment.endsWith(".") || segment !== segment.trim()) {
      return { ok: false, reason: `path segment "${segment}" has surrounding whitespace or a trailing dot` };
    }
    if (RESERVED_SEGMENTS.has(segment.toLowerCase())) {
      return { ok: false, reason: `path must not enter "${segment}"` };
    }
  }
  const fileName = segments[segments.length - 1];
  if (!fileName.toLowerCase().endsWith(DOCUMENT_EXTENSION) || fileName.length <= DOCUMENT_EXTENSION.length) {
    return { ok: false, reason: `path must name a Markdown document ending in ${DOCUMENT_EXTENSION}` };
  }
  return { ok: true, path: rawPath };
}

// C0 controls (incl. NUL), DEL, and C1 controls.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function normalizeSubtree(subtree: string | undefined): string | undefined {
  const normalized = (subtree ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized === "" || normalized === "." ? undefined : normalized;
}
