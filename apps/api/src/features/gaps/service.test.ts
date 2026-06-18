import assert from "node:assert/strict";
import { test } from "node:test";
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
