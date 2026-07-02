import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../../test-support/context.js";
import {
  listFlowSnapshots,
  readFlowSnapshot,
  recordSnapshotsFromPullRequestResults,
  refreshSnapshot
} from "./service.js";

// The PR states the refresh_flow_snapshot watcher job reports, keyed by proposal.
type Reading = { merged: boolean; state: "open" | "closed" };
const noPulls = new Map<string, Reading>();

async function openPrProposal(ctx: ReturnType<typeof makeTestContext>) {
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
  return proposal;
}

describe("refreshSnapshot", () => {
  it("downloads this flow's gaps and in-flight proposals to the snapshot store", async () => {
    const ctx = makeTestContext();
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure X?",
      chatProvider: "codex",
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
    assert.equal(snapshot.pullRequests.length, 0, "a draft proposal has no PR state");

    // The snapshot is persisted, not just returned.
    assert.equal((await ctx.stores.snapshots.read(undefined))?.proposals.length, 1);
  });

  it("records the watcher-reported state for this flow's open pull requests", async () => {
    const ctx = makeTestContext();
    const proposal = await openPrProposal(ctx);

    const snapshot = await refreshSnapshot(
      ctx,
      undefined,
      new Map([[proposal.id, { merged: false, state: "open" }]])
    );

    assert.equal(snapshot.pullRequests.length, 1);
    assert.equal(snapshot.pullRequests[0].state, "open");
    assert.equal(snapshot.pullRequests[0].proposalId, proposal.id);
  });

  it("carries forward the prior reading when the watcher didn't report a PR", async () => {
    const ctx = makeTestContext();
    const proposal = await openPrProposal(ctx);

    // First run: the watcher reported the PR as open.
    await refreshSnapshot(ctx, undefined, new Map([[proposal.id, { merged: false, state: "open" }]]));

    // Second run: nothing reported for this PR (e.g. the watcher couldn't resolve it).
    const snapshot = await refreshSnapshot(ctx, undefined, noPulls);

    assert.equal(snapshot.pullRequests.length, 1, "the unreported PR is retained");
    assert.equal(snapshot.pullRequests[0].state, "open", "the prior reading is kept");
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

describe("recordSnapshotsFromPullRequestResults", () => {
  it("writes the default and every configured flow's snapshot from one job's results", async () => {
    const ctx = makeTestContext({
      knowledgeConfig: {
        sources: [],
        destinations: [],
        flows: [{ id: "alpha", name: "Alpha flow", sourceIds: [], destinationId: "d" }],
        repositories: [],
        roleGrants: {},
        checkoutRoot: ".magpie/checkouts"
      }
    });
    const proposal = await openPrProposal(ctx);

    await recordSnapshotsFromPullRequestResults(ctx, [
      { proposalId: proposal.id, merged: false, state: "open", reviewDecision: "approved" }
    ]);

    const views = await listFlowSnapshots(ctx);
    assert.equal(views.length, 2, "both the default and the alpha flow get a snapshot");
    const defaultSnapshot = views.find((v) => v.flowId === undefined);
    assert.equal(defaultSnapshot?.pullRequests[0]?.state, "open");
    assert.equal(defaultSnapshot?.pullRequests[0]?.reviewDecision, "approved", "the review decision reached the snapshot");
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
        roleGrants: {},
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
