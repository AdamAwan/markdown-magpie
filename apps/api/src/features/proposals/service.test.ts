import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import * as proposals from "./service.js";

test("runMergeCascade resolves the gaps the merged proposal recorded", async () => {
  const ctx = makeTestContext();

  // Record a question and flag a manual gap on it. Manual-gap logs surface as
  // gap candidates regardless of confidence.
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    executionMode: "direct",
    chatProvider: "mock",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

  const before = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(
    before.some((candidate) => candidate.summary === "How to configure X"),
    true,
    "gap should be a candidate before the proposal merges"
  );

  // A merged proposal that closes exactly that gap.
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: [log.id]
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  const merged = await ctx.stores.proposals.get(proposal.id);
  assert.ok(merged);

  const result = await proposals.runMergeCascade(ctx, merged);

  assert.equal(result.resolvedGapCount, 1);

  const after = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(
    after.some((candidate) => candidate.summary === "How to configure X"),
    false,
    "resolved gap should no longer be a candidate"
  );
});
