import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppContext } from "../context.js";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";

describe("reconcileGaps revision gate", () => {
  it("does no model work when the catalog revision is unchanged and no actions pending", async () => {
    const ctx = makeTestContext();
    let chatCalls = 0;
    ctx.providers.chat = () =>
      ({
        complete: async () => {
          chatCalls += 1;
          return { content: "{}" };
        }
      }) as never;

    // processed revision already equals the catalog revision (both 0), no actions.
    await reconcileGaps(ctx, { fetchPullRequestStatus: async () => undefined });
    assert.equal(chatCalls, 0, "no model calls when nothing changed");
  });

  it("still runs the PR-state pass even when model work is skipped", async () => {
    const ctx = makeTestContext();
    // A proposal awaiting its PR.
    const proposal = await ctx.stores.proposals.create({
      title: "T",
      targetPath: "t.md",
      markdown: "#",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });
    await ctx.stores.proposals.recordPublication(proposal.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "sha",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });

    let lookups = 0;
    await reconcileGaps(ctx, {
      fetchPullRequestStatus: async () => {
        lookups += 1;
        return { merged: true, state: "closed" };
      }
    });
    assert.equal(lookups, 1, "open PRs are checked even with no gap changes");
    const after = await ctx.stores.proposals.get(proposal.id);
    assert.equal(after?.status, "merged", "merge detected and applied");
  });
});

describe("reconcileGaps clustering", () => {
  it("assigns a brand-new gap to its own cluster when the catalog advances", async () => {
    const ctx = makeTestContext();
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure X?",
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

    // No merges/splits proposed.
    ctx.providers.chat = () => ({ complete: async () => ({ content: '{"merges":[],"splits":[]}' }) }) as never;

    await reconcileGaps(ctx, { fetchPullRequestStatus: async () => undefined });

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 1, "the new gap created one cluster");
    const memberships = await ctx.stores.gapClusters.listActiveMemberships();
    assert.equal(memberships.length, 1);
  });

  it("does not reshape when the critic rejects the proposed merge", async () => {
    const ctx = makeTestContext();
    // Seed two clusters each with a gap.
    await seedTwoClustersWithGaps(ctx);

    let proposeCalls = 0;
    let criticCalls = 0;
    ctx.providers.chat = () =>
      ({
        complete: async (req: { system?: string }) => {
          // The system prompt distinguishes the critic call from the propose call.
          if ((req.system ?? "").includes("strict reviewer")) {
            criticCalls += 1;
            return { content: '{"confirmed":false,"rationale":"weak"}' };
          }
          proposeCalls += 1;
          const [a, b] = (await ctx.stores.gapClusters.listActiveClusters()).map((c) => c.id);
          return { content: `{"merges":[{"clusterIds":["${a}","${b}"],"rationale":"x"}],"splits":[]}` };
        }
      }) as never;

    const before = await ctx.stores.gapClusters.listActiveClusters();
    await reconcileGaps(ctx, { fetchPullRequestStatus: async () => undefined });
    const after = await ctx.stores.gapClusters.listActiveClusters();

    assert.ok(proposeCalls >= 1 && criticCalls >= 1, "propose then critic were called");
    assert.equal(after.length, before.length, "rejected merge left clusters unchanged");
  });

  it("applies a critic-confirmed merge, keeping every gap exactly once", async () => {
    const ctx = makeTestContext();
    await seedTwoClustersWithGaps(ctx);

    ctx.providers.chat = () =>
      ({
        complete: async (req: { system?: string }) => {
          if ((req.system ?? "").includes("strict reviewer")) {
            return { content: '{"confirmed":true,"rationale":"one doc covers both"}' };
          }
          const [a, b] = (await ctx.stores.gapClusters.listActiveClusters()).map((c) => c.id);
          return { content: `{"merges":[{"clusterIds":["${a}","${b}"],"rationale":"x"}],"splits":[]}` };
        }
      }) as never;

    const membershipsBefore = await ctx.stores.gapClusters.listActiveMemberships();
    await reconcileGaps(ctx, { fetchPullRequestStatus: async () => undefined });

    const after = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(after.length, 1, "the two clusters merged into one survivor");
    const membershipsAfter = await ctx.stores.gapClusters.listActiveMemberships();
    assert.equal(membershipsAfter.length, membershipsBefore.length, "every gap kept exactly one active membership");
    assert.ok(membershipsAfter.every((m) => m.clusterId === after[0].id), "all gaps now belong to the survivor");
  });
});

describe("reconcileGaps outbox", () => {
  it("retries a failed publish without any model call", async () => {
    const ctx = makeTestContext();
    const proposal = await ctx.stores.proposals.create({
      title: "T",
      targetPath: "t.md",
      markdown: "#",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });
    await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");

    let chatCalls = 0;
    ctx.providers.chat = () =>
      ({
        complete: async () => {
          chatCalls += 1;
          return { content: "{}" };
        }
      }) as never;

    let publishCalls = 0;
    await reconcileGaps(ctx, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {
        publishCalls += 1;
      },
      supersedeProposal: async () => {}
    });

    assert.equal(chatCalls, 0, "outbox retry makes no model call");
    assert.equal(publishCalls, 1, "the pending publish action ran");
    assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
  });
});

// Records two questions, flags a manual gap on each, then creates two clusters and
// assigns each gap to one. Recording the gaps advances the catalog past the
// processed revision so the gate opens.
async function seedTwoClustersWithGaps(ctx: AppContext): Promise<void> {
  const log1 = await ctx.stores.questionLogs.record({
    question: "q1?",
    executionMode: "direct",
    chatProvider: "mock",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log1.id, "Cheese");
  const log2 = await ctx.stores.questionLogs.record({
    question: "q2?",
    executionMode: "direct",
    chatProvider: "mock",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log2.id, "Cats");

  const c1 = await ctx.stores.gapClusters.createCluster({ title: "Cheese", revision: 1 });
  const c2 = await ctx.stores.gapClusters.createCluster({ title: "Cats", revision: 1 });
  const [g1] = await ctx.stores.questionLogs.gapIdsForSummary("Cheese");
  const [g2] = await ctx.stores.questionLogs.gapIdsForSummary("Cats");
  await ctx.stores.gapClusters.assignGapToCluster(c1.id, g1);
  await ctx.stores.gapClusters.assignGapToCluster(c2.id, g2);
}
