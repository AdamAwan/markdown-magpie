import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { backfillGapClusters } from "./gap-backfill.js";

// Records a question with a single manual gap and returns the synthetic gap id.
async function recordGap(ctx: ReturnType<typeof makeTestContext>, question: string, summary: string) {
  const log = await ctx.stores.questionLogs.record({
    question,
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, summary);
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary(summary);
  return { logId: log.id, gapId };
}

test("backfill: active proposal claims a shared gap, merged proposal's cluster is frozen", async () => {
  const ctx = makeTestContext();
  const shared = await recordGap(ctx, "How do I configure X?", "How to configure X");

  const active = await ctx.stores.proposals.create({
    title: "Active proposal",
    targetPath: "a.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: [shared.logId]
  });
  const mergedDraft = await ctx.stores.proposals.create({
    title: "Merged proposal",
    targetPath: "m.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: [shared.logId]
  });
  await ctx.stores.proposals.updateStatus(mergedDraft.id, "merged");

  await backfillGapClusters(ctx);

  const activeAfter = await ctx.stores.proposals.get(active.id);
  const mergedAfter = await ctx.stores.proposals.get(mergedDraft.id);
  assert.ok(activeAfter?.gapClusterId, "active proposal is linked to a cluster");
  assert.ok(mergedAfter?.gapClusterId, "merged proposal is linked to a cluster");

  const activeCluster = await ctx.stores.gapClusters.getCluster(activeAfter!.gapClusterId!);
  const mergedCluster = await ctx.stores.gapClusters.getCluster(mergedAfter!.gapClusterId!);
  assert.equal(activeCluster?.status, "active", "active proposal's cluster stays active");
  assert.equal(mergedCluster?.status, "frozen", "merged proposal's cluster is frozen");

  // The shared gap's single active membership belongs to the active cluster.
  const activeMemberships = await ctx.stores.gapClusters.listActiveMemberships();
  const forGap = activeMemberships.filter((m) => m.gapId === shared.gapId);
  assert.equal(forGap.length, 1, "shared gap has exactly one active membership");
  assert.equal(forGap[0].clusterId, activeCluster!.id, "the active cluster wins the shared gap");
});

test("backfill: every gap lands in exactly one active cluster", async () => {
  const ctx = makeTestContext();
  const g1 = await recordGap(ctx, "Q1?", "Gap one");
  const g2 = await recordGap(ctx, "Q2?", "Gap two");

  await ctx.stores.proposals.create({
    title: "P1",
    targetPath: "p1.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapSummary: "Gap one",
    triggeringQuestionIds: [g1.logId]
  });
  await ctx.stores.proposals.create({
    title: "P2",
    targetPath: "p2.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapSummary: "Gap two",
    triggeringQuestionIds: [g2.logId]
  });

  await backfillGapClusters(ctx);

  const active = await ctx.stores.gapClusters.listActiveMemberships();
  const byGap = new Map<string, number>();
  for (const m of active) {
    byGap.set(m.gapId, (byGap.get(m.gapId) ?? 0) + 1);
  }
  assert.equal(byGap.get(g1.gapId), 1);
  assert.equal(byGap.get(g2.gapId), 1);
});

test("backfill is idempotent: a second run creates no new clusters", async () => {
  const ctx = makeTestContext();
  const g = await recordGap(ctx, "Q?", "Gap");
  await ctx.stores.proposals.create({
    title: "P",
    targetPath: "p.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapSummary: "Gap",
    triggeringQuestionIds: [g.logId]
  });

  await backfillGapClusters(ctx);
  const afterFirst = (await ctx.stores.gapClusters.listActiveClusters()).length;
  await backfillGapClusters(ctx);
  const afterSecond = (await ctx.stores.gapClusters.listActiveClusters()).length;
  assert.equal(afterSecond, afterFirst, "no clusters created on the second run");
});
