import type { ChangeIntent, ChangeIntentTrace, ChangeIntentTraceOutcome } from "@magpie/core";
import type { OpenPullRequestSummary, ReconciliationDecision } from "./reconcile-gate.js";
import { sharedTargets } from "./reconcile-gate.js";

export function buildChangeIntentTrace(
  intent: ChangeIntent,
  openPrs: OpenPullRequestSummary[],
  decision: ReconciliationDecision,
  outcome?: ChangeIntentTraceOutcome
): ChangeIntentTrace {
  return {
    createdAt: new Date().toISOString(),
    intent,
    decision,
    candidatePullRequests: openPrs.map((pr) => ({
      proposalId: pr.proposalId,
      targets: pr.targets,
      touchable: pr.touchable,
      overlapTargets: sharedTargets(intent.targets, pr.targets)
    })),
    outcome: outcome ?? defaultOutcome(decision)
  };
}

function defaultOutcome(decision: ReconciliationDecision): ChangeIntentTraceOutcome | undefined {
  if (decision.kind === "defer") {
    return {
      proposalId: decision.behindProposalId,
      reason: `Deferred behind locked proposal ${decision.behindProposalId}.`
    };
  }
  if (decision.kind === "fold") {
    return { proposalId: decision.intoProposalId };
  }
  if (decision.kind === "drop") {
    return { reason: decision.reason };
  }
  return undefined;
}
