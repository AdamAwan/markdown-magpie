import type { ChangeIntent } from "./intent.js";
import type { Proposal } from "@magpie/core";
import { proposalTargets } from "./changeset.js";

// The intersection of two file-sets, de-duplicated and in `a`'s order. Two changes
// overlap (and so must be reconciled rather than raised as rival PRs) exactly when
// this is non-empty.
export function sharedTargets(a: string[], b: string[]): string[] {
  const inB = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of a) {
    if (inB.has(path) && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

// A snapshot of an open PR as the gate sees it: the file-set it touches and
// whether it can still be safely mutated. See openPullRequestSummaries (Task 4)
// for how this is derived from proposals.
export interface OpenPullRequestSummary {
  proposalId: string;
  targets: string[];
  touchable: boolean;
}

// The gate's verdict for one intent. `drop` is part of the shared vocabulary but
// is decided upstream (a superseded/frozen cluster never reaches the gate), so
// decideReconciliation itself never returns it.
export type ReconciliationDecision =
  | { kind: "open-new" }
  | { kind: "fold"; intoProposalId: string }
  | { kind: "defer"; behindProposalId: string }
  | { kind: "drop"; reason: string };

// Decide what to do with an incoming intent given the currently-open PRs in the
// same flow (the caller passes only same-flow PRs). File-path overlap is a cheap
// pre-filter: the actual fold/rewrite is an LLM step performed later by the caller
// (see docs/maintenance-redesign.md §5). An intent with no known targets cannot be
// reconciled by file-set, so it opens a new PR.
export function decideReconciliation(
  intent: ChangeIntent,
  openPrs: OpenPullRequestSummary[]
): ReconciliationDecision {
  if (intent.targets.length === 0) {
    return { kind: "open-new" };
  }

  const overlapping = openPrs
    .map((pr) => ({ pr, overlap: sharedTargets(intent.targets, pr.targets).length }))
    .filter((entry) => entry.overlap > 0);

  if (overlapping.length === 0) {
    return { kind: "open-new" };
  }

  // Most shared targets first; ties by proposalId ascending so the choice is
  // fully deterministic.
  const best = (entries: typeof overlapping) =>
    [...entries].sort((l, r) =>
      l.overlap !== r.overlap
        ? r.overlap - l.overlap
        : l.pr.proposalId < r.pr.proposalId
          ? -1
          : l.pr.proposalId > r.pr.proposalId
            ? 1
            : 0
    )[0].pr;

  const touchable = overlapping.filter((entry) => entry.pr.touchable);
  if (touchable.length > 0) {
    return { kind: "fold", intoProposalId: best(touchable).proposalId };
  }
  // Every overlapping PR is locked (approved / merging). Folding would invalidate
  // a review, so hold this intent for a later round.
  return { kind: "defer", behindProposalId: best(overlapping).proposalId };
}

// Proposal statuses that are still open and therefore safe to fold into. Mirrors
// isOpenProposal() in gap-reconciler.ts — kept in sync deliberately.
const TOUCHABLE_STATUSES = new Set(["draft", "ready", "branch-pushed", "pr-opened"]);

// Derive the gate's view of the open PRs in a flow from its proposals. Only
// still-open proposals that already know their target file participate; a closed
// (merged/rejected/superseded) proposal is not an open PR, and a proposal with no
// targetPath has no file-set to overlap on (Proposal.targetPath is typed
// non-optional, so in practice this guards the empty-string case). touchable is
// true unless the proposal's PR is approved — see Proposal.reviewDecision, polled
// by the refresh_flow_snapshot watcher job.
export function openPullRequestSummaries(proposals: Proposal[]): OpenPullRequestSummary[] {
  const out: OpenPullRequestSummary[] = [];
  for (const proposal of proposals) {
    if (!TOUCHABLE_STATUSES.has(proposal.status) || !proposal.targetPath) {
      continue;
    }
    out.push({
      proposalId: proposal.id,
      // A changeset proposal touches every path in its file-set; a single-file
      // proposal still reports just its targetPath. So an open dedupe PR on [A, B]
      // is detected as overlapping a later intent that touches either A or B.
      targets: proposalTargets(proposal),
      // An approved PR is locked: folding another change into it would invalidate the
      // review. Every other state (and an un-polled proposal) is still touchable.
      touchable: proposal.reviewDecision !== "approved"
    });
  }
  return out;
}
