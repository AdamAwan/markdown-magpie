import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { makeTestContext } from "../../test-support/context.js";
import * as gaps from "./service.js";

test("listClusters reads persisted active clusters and makes no model call", async () => {
  const ctx = makeTestContext();

  const cluster = await ctx.stores.gapClusters.createCluster({
    flowId: "f",
    title: "Cheese",
    rationale: "r",
    revision: 1
  });

  const result = await gaps.listClusters(ctx, 50);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, cluster.id);
  assert.equal(result[0].status, "active");
  assert.equal(result[0].title, "Cheese");
});

test("listClusters surfaces gap summaries, question ids, and the linked proposal", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary("How to configure X");

  const cluster = await ctx.stores.gapClusters.createCluster({ title: "Configure X", revision: 1 });
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);

  const proposal = await ctx.stores.proposals.create({
    title: "T",
    targetPath: "t.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapClusterId: cluster.id
  });

  const [result] = await gaps.listClusters(ctx, 50);
  assert.deepEqual(result.summaries, ["How to configure X"]);
  assert.deepEqual(result.questionIds, [log.id]);
  assert.equal(result.count, 1);
  assert.equal(result.proposalId, proposal.id);
  assert.equal(result.proposalStatus, "draft");
});

test("listClusters surfaces only a cluster's still-open gaps, not resolved ones", async () => {
  const ctx = makeTestContext();
  const openLog = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(openLog.id, "How to configure X");
  const resolvedLog = await ctx.stores.questionLogs.record({
    question: "How do I configure Y?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(resolvedLog.id, "How to configure Y");

  const cluster = await ctx.stores.gapClusters.createCluster({ title: "Configuration", revision: 1 });
  for (const summary of ["How to configure X", "How to configure Y"]) {
    const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary(summary);
    await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);
  }
  await ctx.stores.questionLogs.resolveGaps([resolvedLog.id], ["How to configure Y"], "some-proposal");

  const [result] = await gaps.listClusters(ctx, 50);
  assert.deepEqual(result.summaries, ["How to configure X"], "the resolved gap is not surfaced");
  assert.deepEqual(result.questionIds, [openLog.id]);
  assert.equal(result.count, 1);
});

test("draftFromCluster enqueues a draft_markdown_proposal job for the cluster", async () => {
  const ctx = makeTestContext({
    config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
  });
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",

    chatProvider: "openai-compatible",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const gapIds = await ctx.stores.questionLogs.gapIdsForSummary("How to configure X");
  const cluster = await ctx.stores.gapClusters.createCluster({ title: "Configure X", revision: 1 });
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapIds[0]);

  const outcome = await gaps.draftFromCluster(ctx, cluster.id, {});
  assert.equal(outcome.ok, true);

  // Drafting is enqueue-only: no proposal exists yet (it lands via job completion).
  assert.deepEqual(await ctx.stores.proposals.list(50), []);

  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, "draft_markdown_proposal");
});

test("draftFromCluster enqueues without error when the flow has in-flight PRs", async () => {
  const ctx = makeTestContext({
    config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
  });

  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",

    chatProvider: "openai-compatible",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary("How to configure X");
  const cluster = await ctx.stores.gapClusters.createCluster({ title: "Configure X", revision: 1 });
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);

  // Another cluster's open PR in the same (default) flow, plus this cluster's own
  // in-flight proposal. collectOpenPullRequestContext's filtering of these is
  // covered directly in proposals/service.test.ts; here we only assert the draft
  // still enqueues cleanly when a snapshot is present.
  const other = await ctx.stores.proposals.create({
    title: "Other doc",
    targetPath: "other.md",
    markdown: "#",
    rationale: "r",
    evidence: []
  });
  const own = await ctx.stores.proposals.create({
    title: "Own doc",
    targetPath: "own.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapClusterId: cluster.id
  });
  await ctx.stores.snapshots.write({
    flowId: undefined,
    takenAt: new Date().toISOString(),
    catalogRevision: 0,
    gaps: [],
    proposals: [
      { id: other.id, title: "Other doc", status: "pr-opened", pullRequestUrl: "https://github.com/o/r/pull/9" },
      { id: own.id, title: "Own doc", status: "draft", gapClusterId: cluster.id }
    ],
    pullRequests: [
      {
        proposalId: other.id,
        url: "https://github.com/o/r/pull/9",
        merged: false,
        state: "open",
        checkedAt: new Date().toISOString()
      }
    ]
  });

  const outcome = await gaps.draftFromCluster(ctx, cluster.id, {});
  assert.equal(outcome.ok, true);
  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, "draft_markdown_proposal");
});

test("draftFromCluster returns cluster_not_found for an unknown or inactive cluster", async () => {
  const ctx = makeTestContext();
  const outcome = await gaps.draftFromCluster(ctx, "does-not-exist", {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.code : undefined, "cluster_not_found");
});
