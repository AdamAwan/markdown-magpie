import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../../test-support/context.js";
import { listFlowSnapshots, readFlowSnapshot, refreshSnapshot } from "./service.js";

const noPulls = { pollPullRequest: async () => ({ notModified: false }) };

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
      pollPullRequest: async () => {
        polls += 1;
        return { notModified: false, status: { merged: false, state: "open" }, etag: 'W/"abc"' };
      }
    });

    assert.equal(polls, 1, "the one open PR was polled");
    assert.equal(snapshot.pullRequests.length, 1);
    assert.equal(snapshot.pullRequests[0].state, "open");
    assert.equal(snapshot.pullRequests[0].proposalId, proposal.id);
    assert.equal(snapshot.pullRequests[0].etag, 'W/"abc"', "the ETag is stored for the next poll");
  });

  it("replays the stored ETag and keeps the prior reading on a 304", async () => {
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

    // First poll returns a 200 with an ETag.
    await refreshSnapshot(ctx, undefined, {
      pollPullRequest: async () => ({ notModified: false, status: { merged: false, state: "open" }, etag: 'W/"v1"' })
    });

    // Second poll: the service must send the stored ETag and, on 304, keep the reading.
    let seenEtag: string | undefined = "unset";
    const snapshot = await refreshSnapshot(ctx, undefined, {
      pollPullRequest: async (_url, etag) => {
        seenEtag = etag;
        return { notModified: true };
      }
    });

    assert.equal(seenEtag, 'W/"v1"', "the stored ETag was replayed as If-None-Match");
    assert.equal(snapshot.pullRequests.length, 1, "the unchanged PR is retained");
    assert.equal(snapshot.pullRequests[0].state, "open", "the prior reading is kept on 304");
    assert.equal(snapshot.pullRequests[0].etag, 'W/"v1"', "the ETag is carried forward");
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

describe("reading snapshots for the UI", () => {
  it("lists only flows whose snapshot has been written, labelled by flow name", async () => {
    const ctx = makeTestContext({
      knowledgeConfig: {
        sources: [],
        destinations: [],
        flows: [{ id: "alpha", name: "Alpha flow", sourceIds: [], destinationId: "d" }],
        repositories: [],
        checkoutRoot: ".magpie/checkouts"
      }
    });

    // Nothing written yet.
    assert.deepEqual(await listFlowSnapshots(ctx), []);

    await refreshSnapshot(ctx, undefined, noPulls);
    await refreshSnapshot(ctx, "alpha", noPulls);

    const views = await listFlowSnapshots(ctx);
    assert.equal(views.length, 2);
    assert.equal(views.find((v) => v.flowId === undefined)?.flowName, "Default flow");
    assert.equal(views.find((v) => v.flowId === "alpha")?.flowName, "Alpha flow");
  });

  it("reads one flow's snapshot and returns undefined when absent", async () => {
    const ctx = makeTestContext();
    assert.equal(await readFlowSnapshot(ctx, undefined), undefined);

    await refreshSnapshot(ctx, undefined, noPulls);
    const view = await readFlowSnapshot(ctx, undefined);
    assert.equal(view?.flowName, "Default flow");
  });
});
