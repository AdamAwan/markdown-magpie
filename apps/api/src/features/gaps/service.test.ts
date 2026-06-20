import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { makeTestContext } from "../../test-support/context.js";
import * as gaps from "./service.js";

test("listClusters reads persisted active clusters and makes no model call", async () => {
  const ctx = makeTestContext();
  let chatCalls = 0;
  ctx.providers.chat = () =>
    ({
      complete: async () => {
        chatCalls += 1;
        return { content: "{}" };
      }
    }) as never;

  const cluster = await ctx.stores.gapClusters.createCluster({
    flowId: "f",
    title: "Cheese",
    rationale: "r",
    revision: 1
  });

  const result = await gaps.listClusters(ctx, 50);
  assert.equal(chatCalls, 0, "no clustering model call on read");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, cluster.id);
  assert.equal(result[0].status, "active");
  assert.equal(result[0].title, "Cheese");
});

test("listClusters surfaces gap summaries, question ids, and the linked proposal", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    executionMode: "direct",
    chatProvider: "mock",
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

test("draftFromCluster creates a proposal, links the cluster, and enqueues a publish action", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    executionMode: "direct",
    chatProvider: "mock",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const gapIds = await ctx.stores.questionLogs.gapIdsForSummary("How to configure X");
  const cluster = await ctx.stores.gapClusters.createCluster({ title: "Configure X", revision: 1 });
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapIds[0]);

  const outcome = await gaps.draftFromCluster(ctx, cluster.id, {});
  assert.equal(outcome.ok, true);

  const proposals = await ctx.stores.proposals.list(50);
  const linked = proposals.find((p) => p.gapClusterId === cluster.id);
  assert.ok(linked, "a proposal is linked to the cluster");

  const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.equal(pending.some((a) => a.proposalId === linked!.id && a.kind === "publish"), true);
});

test("draftFromCluster gives the drafter the flow's open PRs and excludes the cluster's own", async () => {
  // A non-mock provider so the direct draft path actually calls the chat model,
  // letting us capture the serialised job input it is handed.
  const ctx = makeTestContext({
    config: new RuntimeConfigHolder({ aiExecutionMode: "direct", aiProvider: "claude" })
  });
  let captured: string | undefined;
  ctx.providers.chat = () =>
    ({
      complete: async (request: { messages: Array<{ content: string }> }) => {
        captured = request.messages[0]?.content;
        return { content: '{"title":"T","targetPath":"t.md","markdown":"# T\\nbody","rationale":"r"}' };
      }
    }) as never;

  // The cluster we are about to draft for.
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    executionMode: "direct",
    chatProvider: "mock",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary("How to configure X");
  const cluster = await ctx.stores.gapClusters.createCluster({ title: "Configure X", revision: 1 });
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);

  // Another cluster's open PR in the same (default) flow, plus this cluster's own
  // in-flight proposal which the draft must NOT be shown.
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
      { proposalId: other.id, url: "https://github.com/o/r/pull/9", merged: false, state: "open", checkedAt: new Date().toISOString() }
    ]
  });

  const outcome = await gaps.draftFromCluster(ctx, cluster.id, {});
  assert.equal(outcome.ok, true);
  assert.ok(captured, "the drafter was handed an input payload");
  const input = JSON.parse(captured!) as {
    openPullRequests?: Array<{ title: string; url?: string; targetPath?: string; status: string }>;
  };
  assert.equal(input.openPullRequests?.length, 1, "only the other cluster's open PR is surfaced");
  assert.deepEqual(input.openPullRequests?.[0], {
    title: "Other doc",
    url: "https://github.com/o/r/pull/9",
    targetPath: "other.md",
    status: "pr-opened"
  });
});

test("draftFromCluster returns cluster_not_found for an unknown or inactive cluster", async () => {
  const ctx = makeTestContext();
  const outcome = await gaps.draftFromCluster(ctx, "does-not-exist", {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.code : undefined, "cluster_not_found");
});
