import type { ChangesetChange, Proposal } from "@magpie/core";

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
