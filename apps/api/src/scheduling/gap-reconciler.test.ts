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
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
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
    await reconcileGaps(ctx, undefined, {
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

    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });

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
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
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
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });

    const after = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(after.length, 1, "the two clusters merged into one survivor");
    const membershipsAfter = await ctx.stores.gapClusters.listActiveMemberships();
    assert.equal(membershipsAfter.length, membershipsBefore.length, "every gap kept exactly one active membership");
    assert.ok(membershipsAfter.every((m) => m.clusterId === after[0].id), "all gaps now belong to the survivor");
  });
});

describe("reconcileGaps autonomous drafting", () => {
  it("drafts, links, and publishes a proposal for a brand-new cluster", async () => {
    const ctx = makeTestContext();
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure X?",
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

    // No reshape proposed (a single cluster has nothing to merge anyway).
    ctx.providers.chat = () => ({ complete: async () => ({ content: '{"merges":[],"splits":[]}' }) }) as never;

    let published = 0;
    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {
        published += 1;
      },
      supersedeProposal: async () => {}
    });

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 1, "one cluster was created for the gap");
    const proposals = await ctx.stores.proposals.list(500);
    assert.equal(proposals.length, 1, "a proposal was drafted for the new cluster");
    assert.equal(proposals[0].gapClusterId, clusters[0].id, "the proposal is linked to its cluster");
    assert.equal(published, 1, "the drafted proposal's publish action was drained");
    assert.deepEqual(
      await ctx.stores.gapClusters.listPendingPublicationActions(),
      [],
      "no publication action is left pending"
    );
  });

  it("drafts only the uncovered cluster on a later run, never duplicating an existing proposal", async () => {
    const ctx = makeTestContext();
    ctx.providers.chat = () => ({ complete: async () => ({ content: '{"merges":[],"splits":[]}' }) }) as never;
    const deps = {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    };

    const log1 = await ctx.stores.questionLogs.record({
      question: "q1?",
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log1.id, "Topic one");
    await reconcileGaps(ctx, undefined, deps);
    assert.equal((await ctx.stores.proposals.list(500)).length, 1, "first run drafts one proposal");

    // A new, distinct gap advances the catalog and reopens the gate.
    const log2 = await ctx.stores.questionLogs.record({
      question: "q2?",
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log2.id, "Topic two");
    await reconcileGaps(ctx, undefined, deps);

    const proposals = await ctx.stores.proposals.list(500);
    assert.equal(proposals.length, 2, "only the newly uncovered cluster was drafted; the existing proposal was untouched");
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
    await reconcileGaps(ctx, undefined, {
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

describe("reconcileGaps PR state from snapshot", () => {
  it("applies a merge recorded in the snapshot without polling the host live", async () => {
    const ctx = makeTestContext();
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
    // The fetch job already saw this PR merge.
    await ctx.stores.snapshots.write({
      flowId: undefined,
      takenAt: new Date().toISOString(),
      catalogRevision: 0,
      gaps: [],
      proposals: [{ id: proposal.id, status: "pr-opened", pullRequestUrl: "https://github.com/o/r/pull/1" }],
      pullRequests: [
        { proposalId: proposal.id, url: "https://github.com/o/r/pull/1", merged: true, state: "closed", checkedAt: new Date().toISOString() }
      ]
    });

    let liveLookups = 0;
    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => {
        liveLookups += 1;
        return undefined;
      }
    });

    assert.equal(liveLookups, 0, "the reconciler used the snapshot, not a live poll");
    assert.equal((await ctx.stores.proposals.get(proposal.id))?.status, "merged", "the snapshot's merge was applied");
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
