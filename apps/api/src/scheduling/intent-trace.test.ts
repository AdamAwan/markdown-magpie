import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeIntent } from "@magpie/core";
import { buildChangeIntentTrace } from "./intent-trace.js";
import type { OpenPullRequestSummary, ReconciliationDecision } from "./reconcile-gate.js";

test("builds an open-new trace with candidate overlap context", () => {
  const intent: ChangeIntent = {
    lens: "verify",
    flowId: "billing",
    targets: ["kb/refunds.md"],
    evidence: ["source/refunds.md"],
    rationale: "Refund window no longer matches source material."
  };
  const openPrs: OpenPullRequestSummary[] = [{ proposalId: "p-existing", targets: ["kb/pricing.md"], touchable: true }];
  const decision: ReconciliationDecision = { kind: "open-new" };

  const trace = buildChangeIntentTrace(intent, openPrs, decision, {
    proposalId: "p-new",
    proposalTitle: "Fix refund window",
    proposalStatus: "draft",
    reason: "No overlapping open proposal touched the target file."
  });

  assert.equal(trace.intent.lens, "verify");
  assert.equal(trace.decision.kind, "open-new");
  assert.deepEqual(trace.candidatePullRequests, [
    { proposalId: "p-existing", targets: ["kb/pricing.md"], touchable: true, overlapTargets: [] }
  ]);
  assert.equal(trace.outcome?.proposalId, "p-new");
});

test("builds fold and defer traces with overlap paths", () => {
  const intent: ChangeIntent = {
    lens: "dedupe",
    targets: ["kb/a.md", "kb/b.md"],
    evidence: [],
    rationale: "Two documents duplicate each other."
  };
  const openPrs: OpenPullRequestSummary[] = [
    { proposalId: "p-fold", targets: ["kb/b.md"], touchable: true },
    { proposalId: "p-locked", targets: ["kb/a.md"], touchable: false }
  ];

  const fold = buildChangeIntentTrace(intent, openPrs, { kind: "fold", intoProposalId: "p-fold" });
  assert.equal(fold.decision.kind, "fold");
  assert.deepEqual(
    fold.candidatePullRequests.map((candidate) => candidate.overlapTargets),
    [["kb/b.md"], ["kb/a.md"]]
  );

  const defer = buildChangeIntentTrace(intent, openPrs, { kind: "defer", behindProposalId: "p-locked" });
  assert.equal(defer.decision.kind, "defer");
  assert.equal(defer.outcome?.reason, "Deferred behind locked proposal p-locked.");
});
