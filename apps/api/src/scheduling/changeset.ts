import type { ChangesetChange, Proposal } from "@magpie/core";
import { findUnsafeChangesetPath } from "@magpie/git";
import type { JobView } from "@magpie/jobs";
import { logger } from "../logger.js";

// The files this proposal writes/deletes — its file-set. A first-class changeset
// wins; otherwise the single target the proposal has always had, expressed as a
// one-entry changeset so every caller sees the same shape.
export function proposalChangeset(proposal: Proposal): ChangesetChange[] {
  return proposal.changeset ?? [{ path: proposal.targetPath, content: proposal.markdown }];
}

// Just the paths, for the reconcile gate's file-set overlap check.
export function proposalTargets(proposal: Proposal): string[] {
  return proposalChangeset(proposal).map((change) => change.path);
}

// The API-side gate on a MODEL-CHOSEN file-set (dedupe, split, fold_changeset,
// source-sync), run when the job output is consumed and before any proposal is
// created or changed. Every path must pass the shared destination document-path
// policy (@magpie/git checkDocumentPath — the same rule the publisher re-applies
// before touching the working tree) and, when `allowedPaths` is given, be one of
// the paths the job was offered. Paths here are relative to the destination's
// indexed subtree (its configured subpath), so a path that passes the structural
// policy cannot leave that subtree.
//
// Returns true when the changeset must be REJECTED, after logging why. A rejected
// output is deterministic model misbehaviour (or prompt injection): the caller
// drops it like any other malformed output — no proposal, no publish, no throw —
// so the completion dispatcher neither 500s nor re-runs a paid generation.
export function rejectUnsafeChangeset(
  job: JobView,
  changeset: readonly ChangesetChange[],
  allowedPaths?: ReadonlySet<string>
): boolean {
  const unsafe = findUnsafeChangesetPath(changeset);
  if (unsafe) {
    logger.warn(
      { jobId: job.id, jobType: job.type, path: unsafe.path, reason: unsafe.reason },
      "changeset rejected: a path breaks the destination document-path policy; no proposal created"
    );
    return true;
  }
  if (allowedPaths) {
    const stray = changeset.find((change) => !allowedPaths.has(change.path));
    if (stray) {
      logger.warn(
        { jobId: job.id, jobType: job.type, path: stray.path },
        "changeset rejected: it touches a path the job was not given; no proposal created"
      );
      return true;
    }
  }
  return false;
}
