import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../../test-support/context.js";
import { refreshSnapshot } from "./service.js";

const noPulls = { fetchPullRequestStatus: async () => undefined };

describe("refreshSnapshot", () => {
  it("downloads this flow's gaps and in-flight proposals to the snapshot store", async () => {
    const ctx = makeTestContext();
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure X?",
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
    const proposal = await ctx.stores.proposals.create({
      title: "Configure X",
      targetPath: "x.md",
      markdown: "# X",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });

    const snapshot = await refreshSnapshot(ctx, undefined, noPulls);

    assert.ok(snapshot.gaps.some((g) => g.summary === "How to configure X"), "the gap was captured");
    assert.ok(snapshot.proposals.some((p) => p.id === proposal.id), "the proposal was captured");
    assert.equal(snapshot.pullRequests.length, 0, "a draft proposal has no PR to poll");

    // The snapshot is persisted, not just returned.
    assert.equal((await ctx.stores.snapshots.read(undefined))?.proposals.length, 1);
  });

  it("polls only this flow's open pull requests", async () => {
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

    let polls = 0;
    const snapshot = await refreshSnapshot(ctx, undefined, {
      fetchPullRequestStatus: async () => {
        polls += 1;
        return { merged: false, state: "open" };
      }
    });

    assert.equal(polls, 1, "the one open PR was polled");
    assert.equal(snapshot.pullRequests.length, 1);
    assert.equal(snapshot.pullRequests[0].state, "open");
    assert.equal(snapshot.pullRequests[0].proposalId, proposal.id);
  });

  it("scopes gaps and proposals to the requested flow", async () => {
    const ctx = makeTestContext();
    // A proposal that belongs to flow "alpha" via its cluster.
    const cluster = await ctx.stores.gapClusters.createCluster({ flowId: "alpha", title: "Alpha gap", revision: 1 });
    const proposal = await ctx.stores.proposals.create({
      title: "Alpha",
      targetPath: "a.md",
      markdown: "# A",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });
    await ctx.stores.proposals.linkCluster(proposal.id, cluster.id);

    const defaultSnapshot = await refreshSnapshot(ctx, undefined, noPulls);
    assert.ok(!defaultSnapshot.proposals.some((p) => p.id === proposal.id), "alpha's proposal is absent from the default flow");

    const alphaSnapshot = await refreshSnapshot(ctx, "alpha", noPulls);
    assert.ok(alphaSnapshot.proposals.some((p) => p.id === proposal.id), "alpha's proposal is in the alpha snapshot");
  });
});
