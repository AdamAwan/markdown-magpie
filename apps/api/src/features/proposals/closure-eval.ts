import type { Citation, Confidence, Proposal } from "@magpie/core";

// A gap counts as closed only when the re-asked answer is confident. "low" and
// "unknown" never close a gap, matching the spec's deterministic test.
const CONFIDENT: ReadonlySet<Confidence> = new Set<Confidence>(["high", "medium"]);

// Normalize to POSIX separators and strip leading/trailing slashes so a
// destination subpath and a document path compare in the same shape.
function normalizeSubtreePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

// Re-express a destination-root-relative document path in the indexed-subtree
// path space by removing the destination's configured `subpath` prefix.
//
// The two path spaces we bridge here:
//   - A proposal's `targetPath` (and changeset paths) are destination-root-
//     relative and INCLUDE the subpath — `resolveProposalTargetPath` prefixes the
//     folder, so subpath `kb` yields `kb/configure-x.md`.
//   - Citations carry indexed-subtree-relative paths with the subpath STRIPPED —
//     the post-merge re-index roots at `localPath + subpath`, so the same file is
//     cited as `configure-x.md`.
// Stripping the subpath here puts both in one space so gap-closure verification
// can actually match them. A path that does not sit under the subpath (defensive;
// shouldn't happen for our own writes) is returned normalized but otherwise
// unchanged. When no subpath is configured, the path passes through untouched.
function stripSubpath(path: string, subpath: string): string {
  const normalizedSubpath = normalizeSubtreePath(subpath);
  if (!normalizedSubpath) {
    return path;
  }
  const normalizedPath = normalizeSubtreePath(path);
  const prefix = `${normalizedSubpath}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

// The document paths a merged proposal actually wrote, expressed in the same
// indexed-subtree path space citations use. For a single-file proposal that is
// `targetPath`; for a changeset proposal it is every change that writes content
// (deletes and content-less entries are not new sources a citation could resolve
// into). Pass the destination's `subpath` so the returned paths are stripped of
// it to match citation paths; omit it (or pass undefined) for a subpath-less
// destination, where the paths pass through unchanged.
export function proposalTargetPaths(proposal: Proposal, subpath?: string): Set<string> {
  const paths = new Set<string>();
  if (proposal.targetPath) {
    paths.add(stripSubpath(proposal.targetPath, subpath ?? ""));
  }
  for (const change of proposal.changeset ?? []) {
    if (!change.delete && typeof change.content === "string") {
      paths.add(stripSubpath(change.path, subpath ?? ""));
    }
  }
  return paths;
}

// True when at least one citation resolves into one of the merged proposal's
// documents (matched by path — the stable, human-meaningful key both citations
// and proposals carry).
export function citesMergedDoc(citations: Citation[], targetPaths: Set<string>): boolean {
  return citations.some((citation) => targetPaths.has(citation.path));
}

export interface ClosureEvaluation {
  verdict: "closed" | "still_open";
  // Whether the answer cited the merged document — computed once here (via
  // citesMergedDoc) so callers that also need this fact (e.g. to build a
  // human-readable verification detail) read it off the result instead of
  // recomputing it and risking drift from the verdict itself.
  cited: boolean;
}

// The deterministic closure test: a re-asked answer closes its gap iff it is
// confident AND cites the merged document. A missing answer (the re-ask timed
// out / no provider watcher answered) is treated as still-open — we never claim
// a closure we could not verify.
export function evaluateClosure(
  answer: { confidence: Confidence; citations: Citation[] } | undefined,
  targetPaths: Set<string>
): ClosureEvaluation {
  if (!answer) {
    return { verdict: "still_open", cited: false };
  }
  const cited = citesMergedDoc(answer.citations, targetPaths);
  return { verdict: CONFIDENT.has(answer.confidence) && cited ? "closed" : "still_open", cited };
}
