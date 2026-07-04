import type { Citation, Confidence, Proposal } from "@magpie/core";

// A gap counts as closed only when the re-asked answer is confident. "low" and
// "unknown" never close a gap, matching the spec's deterministic test.
const CONFIDENT: ReadonlySet<Confidence> = new Set<Confidence>(["high", "medium"]);

// The document paths a merged proposal actually wrote. For a single-file
// proposal that is `targetPath`; for a changeset proposal it is every change
// that writes content (deletes and content-less entries are not new sources a
// citation could resolve into).
export function proposalTargetPaths(proposal: Proposal): Set<string> {
  const paths = new Set<string>();
  if (proposal.targetPath) {
    paths.add(proposal.targetPath);
  }
  for (const change of proposal.changeset ?? []) {
    if (!change.delete && typeof change.content === "string") {
      paths.add(change.path);
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

// The deterministic closure test: a re-asked answer closes its gap iff it is
// confident AND cites the merged document. A missing answer (the re-ask timed
// out / no provider watcher answered) is treated as still-open — we never claim
// a closure we could not verify.
export function evaluateClosure(
  answer: { confidence: Confidence; citations: Citation[] } | undefined,
  targetPaths: Set<string>
): "closed" | "still_open" {
  if (!answer) {
    return "still_open";
  }
  return CONFIDENT.has(answer.confidence) && citesMergedDoc(answer.citations, targetPaths)
    ? "closed"
    : "still_open";
}
