import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedTargets, decideReconciliation, openPullRequestSummaries, type OpenPullRequestSummary } from "./reconcile-gate.js";
import type { ChangeIntent } from "./intent.js";
import type { Proposal } from "@magpie/core";

test("sharedTargets returns the intersection in a's order", () => {
  assert.deepEqual(
    sharedTargets(["kb/refunds.md", "kb/credits.md"], ["kb/credits.md", "kb/refunds.md"]),
    ["kb/refunds.md", "kb/credits.md"]
  );
});

test("sharedTargets is empty when file-sets are disjoint", () => {
  assert.deepEqual(sharedTargets(["kb/a.md"], ["kb/b.md"]), []);
});

test("sharedTargets de-duplicates and ignores empty sets", () => {
  assert.deepEqual(sharedTargets(["kb/a.md", "kb/a.md"], ["kb/a.md"]), ["kb/a.md"]);
  assert.deepEqual(sharedTargets([], ["kb/a.md"]), []);
});

const intent = (targets: string[], lens: ChangeIntent["lens"] = "verify"): ChangeIntent => ({
  lens,
  targets,
  evidence: [],
  rationale: "test"
});
const pr = (
  proposalId: string,
  targets: string[],
  touchable = true
): OpenPullRequestSummary => ({ proposalId, targets, touchable });

test("opens a new PR when nothing overlaps", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [pr("p1", ["kb/b.md"])]);
  assert.deepEqual(d, { kind: "open-new" });
});

test("opens a new PR when the intent has no known targets", () => {
  const d = decideReconciliation(intent([], "gap"), [pr("p1", ["kb/a.md"])]);
  assert.deepEqual(d, { kind: "open-new" });
});

test("folds into an overlapping touchable PR", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [pr("p1", ["kb/a.md"], true)]);
  assert.deepEqual(d, { kind: "fold", intoProposalId: "p1" });
});

test("defers behind an overlapping non-touchable PR", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [pr("p1", ["kb/a.md"], false)]);
  assert.deepEqual(d, { kind: "defer", behindProposalId: "p1" });
});

test("prefers the PR with the most shared targets", () => {
  const d = decideReconciliation(intent(["kb/a.md", "kb/b.md"]), [
    pr("p1", ["kb/a.md"]),
    pr("p2", ["kb/a.md", "kb/b.md"])
  ]);
  assert.deepEqual(d, { kind: "fold", intoProposalId: "p2" });
});

test("breaks overlap ties by proposalId ascending", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [
    pr("p2", ["kb/a.md"]),
    pr("p1", ["kb/a.md"])
  ]);
  assert.deepEqual(d, { kind: "fold", intoProposalId: "p1" });
});

test("folds when a touchable and a non-touchable PR both overlap", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [
    pr("p1", ["kb/a.md"], false),
    pr("p2", ["kb/a.md"], true)
  ]);
  assert.deepEqual(d, { kind: "fold", intoProposalId: "p2" });
});

test("never returns drop", () => {
  for (const prs of [[], [pr("p1", ["kb/a.md"], true)], [pr("p1", ["kb/a.md"], false)]]) {
    assert.notEqual(decideReconciliation(intent(["kb/a.md"]), prs).kind, "drop");
  }
});

// Minimal Proposal fixtures: only the fields the adapter reads. Cast keeps the
// test focused without reconstructing the whole record.
const proposal = (id: string, status: string, targetPath?: string, reviewDecision?: string): Proposal =>
  ({ id, status, targetPath, reviewDecision }) as unknown as Proposal;

test("maps every open status with a target path into summaries", () => {
  // Cover all four touchable statuses so removing any from TOUCHABLE_STATUSES
  // (which deliberately mirrors isOpenProposal) is caught here.
  const out = openPullRequestSummaries([
    proposal("p1", "pr-opened", "kb/a.md"),
    proposal("p2", "draft", "kb/b.md"),
    proposal("p3", "ready", "kb/c.md"),
    proposal("p4", "branch-pushed", "kb/d.md")
  ]);
  assert.deepEqual(out, [
    { proposalId: "p1", targets: ["kb/a.md"], touchable: true },
    { proposalId: "p2", targets: ["kb/b.md"], touchable: true },
    { proposalId: "p3", targets: ["kb/c.md"], touchable: true },
    { proposalId: "p4", targets: ["kb/d.md"], touchable: true }
  ]);
});

test("an approved proposal is non-touchable; every other decision stays touchable", () => {
  const out = openPullRequestSummaries([
    proposal("p1", "pr-opened", "kb/a.md", "approved"),
    proposal("p2", "pr-opened", "kb/b.md", "changes_requested"),
    proposal("p3", "pr-opened", "kb/c.md", "review_required"),
    proposal("p4", "pr-opened", "kb/d.md", "none"),
    proposal("p5", "pr-opened", "kb/e.md")
  ]);
  assert.deepEqual(out, [
    { proposalId: "p1", targets: ["kb/a.md"], touchable: false },
    { proposalId: "p2", targets: ["kb/b.md"], touchable: true },
    { proposalId: "p3", targets: ["kb/c.md"], touchable: true },
    { proposalId: "p4", targets: ["kb/d.md"], touchable: true },
    { proposalId: "p5", targets: ["kb/e.md"], touchable: true }
  ]);
});

test("excludes closed proposals and those without a target path", () => {
  const out = openPullRequestSummaries([
    proposal("p1", "merged", "kb/a.md"),
    proposal("p2", "rejected", "kb/b.md"),
    proposal("p3", "superseded", "kb/c.md"),
    proposal("p4", "pr-opened", undefined)
  ]);
  assert.deepEqual(out, []);
});
