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

test("draftFromGaps records a draftContext capturing the gaps and open PRs the model saw", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    executionMode: "direct",
    chatProvider: "mock",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

  const outcome = await proposals.draftFromGaps(ctx, ["How to configure X"], {
    openPullRequests: [
      { title: "Existing doc", url: "https://github.com/o/r/pull/1", targetPath: "x.md", status: "pr-opened" }
    ]
  });
  if (!outcome.ok || outcome.mode !== "direct") {
    throw new Error("expected a direct-mode proposal");
  }
  const context = outcome.proposal.draftContext;
  assert.ok(context, "the proposal carries a draft context");
  assert.deepEqual(context.gapSummaries, ["How to configure X"]);
  assert.equal(context.evidenceCount, 0);
  assert.equal(context.openPullRequests.length, 1);
  assert.equal(context.openPullRequests[0].url, "https://github.com/o/r/pull/1");
});

test("collectOpenPullRequestContext returns [] when the flow has no snapshot yet", async () => {
  const ctx = makeTestContext();
  assert.deepEqual(await proposals.collectOpenPullRequestContext(ctx, undefined), []);
});

test("collectOpenPullRequestContext maps the snapshot's in-flight proposals to drafting context", async () => {
  const ctx = makeTestContext();
  const opened = await ctx.stores.proposals.create({
    title: "Cheese ageing",
    targetPath: "cheese/ageing.md",
    markdown: "#",
    rationale: "r",
    evidence: []
  });
  const draft = await ctx.stores.proposals.create({
    title: "Cheese pairing",
    targetPath: "cheese/pairing.md",
    markdown: "#",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.snapshots.write({
    flowId: undefined,
    takenAt: new Date().toISOString(),
    catalogRevision: 0,
    gaps: [],
    proposals: [
      { id: opened.id, title: "Cheese ageing", status: "pr-opened", pullRequestUrl: "https://github.com/o/r/pull/7" },
      { id: draft.id, title: "Cheese pairing", status: "draft" }
    ],
    pullRequests: [
      { proposalId: opened.id, url: "https://github.com/o/r/pull/7", merged: false, state: "open", checkedAt: new Date().toISOString() }
    ]
  });

  const context = await proposals.collectOpenPullRequestContext(ctx, undefined);
  assert.equal(context.length, 2, "both the open PR and the in-flight draft are surfaced");
  const openPr = context.find((entry) => entry.status === "pr-opened");
  assert.deepEqual(openPr, {
    title: "Cheese ageing",
    url: "https://github.com/o/r/pull/7",
    targetPath: "cheese/ageing.md",
    status: "pr-opened"
  });
  const draftEntry = context.find((entry) => entry.status === "draft");
  assert.equal(draftEntry?.url, undefined, "an in-flight draft has no PR url yet");
  assert.equal(draftEntry?.targetPath, "cheese/pairing.md");
});

test("collectOpenPullRequestContext excludes the named cluster's own proposal and settled PRs", async () => {
  const ctx = makeTestContext();
  const own = await ctx.stores.proposals.create({
    title: "Own",
    targetPath: "own.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapClusterId: "cluster-1"
  });
  const merged = await ctx.stores.proposals.create({
    title: "Merged",
    targetPath: "merged.md",
    markdown: "#",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.snapshots.write({
    flowId: undefined,
    takenAt: new Date().toISOString(),
    catalogRevision: 0,
    gaps: [],
    proposals: [
      { id: own.id, title: "Own", status: "pr-opened", gapClusterId: "cluster-1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { id: merged.id, title: "Merged", status: "pr-opened", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ],
    // The fetch job recorded pull/2 as already merged — it's no longer open.
    pullRequests: [
      { proposalId: merged.id, url: "https://github.com/o/r/pull/2", merged: true, state: "closed", checkedAt: new Date().toISOString() }
    ]
  });

  const context = await proposals.collectOpenPullRequestContext(ctx, undefined, { excludeClusterId: "cluster-1" });
  assert.deepEqual(context, [], "own-cluster proposal excluded; merged PR dropped as not open");
});
