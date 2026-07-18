import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppContext } from "../context.js";
import { makeTestContext } from "../test-support/context.js";
import { applyPullRequestTransition, reconcileGaps } from "./gap-reconciler.js";

// Regression coverage for issue #282: the post-merge cascade (re-index + enqueue
// verify_gap_closure) must be durable and replay-safe. A merge is persisted
// synchronously, but the cascade runs either fire-and-forget (manual/local-git,
// lost on restart) or inside the replayable completeJob block (GitHub PR-poll,
// where committing status=merged before the cascade defeats the 500-replay
// guard). Either can orphan a proposal at `merged` with unset closureStatus and
// its gaps never verified. Two safety nets are tested here: a replay-safe PR
// transition, and a reconciler sweep backstop.

// A merged proposal that carries a triggering question (so a merge has a gap to
// verify) but whose cascade never ran — the orphaned shape a crash leaves behind.
async function seedOrphanedMerge(ctx: AppContext): Promise<string> {
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const created = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: [log.id]
  });
  await ctx.stores.proposals.updateStatus(created.id, "merged");
  return created.id;
}

async function verifyJobCount(ctx: AppContext): Promise<number> {
  return (await ctx.jobs.list({ type: "verify_gap_closure" })).jobs.length;
}

describe("gap reconciler: orphaned-merge sweep (#282)", () => {
  it("re-drives the cascade for a merged proposal whose verification was never enqueued", async () => {
    const ctx = makeTestContext();
    const id = await seedOrphanedMerge(ctx);
    assert.equal(await verifyJobCount(ctx), 0, "no verification yet — the cascade was lost");

    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });

    assert.equal(await verifyJobCount(ctx), 1, "the sweep recovered the orphan and enqueued verification");
    // The proposal id the recovered job targets is the orphaned one.
    const jobs = (await ctx.jobs.list({ type: "verify_gap_closure" })).jobs;
    assert.equal((jobs[0]?.input as { proposalId?: string })?.proposalId, id);
  });

  it("does not re-enqueue verification once the orphan has been recovered", async () => {
    const ctx = makeTestContext();
    await seedOrphanedMerge(ctx);

    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });

    assert.equal(await verifyJobCount(ctx), 1, "a second sweep is a no-op — the verify job already exists");
  });

  it("leaves a merged proposal with a recorded closure verdict untouched", async () => {
    const ctx = makeTestContext();
    const id = await seedOrphanedMerge(ctx);
    await ctx.stores.proposals.setClosureStatus(id, "verified_closed");

    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });

    assert.equal(await verifyJobCount(ctx), 0, "a verified proposal is not swept");
  });

  it("does not sweep merged proposals belonging to another flow", async () => {
    const ctx = makeTestContext();
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure Y?",
      chatProvider: "codex",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure Y");
    const created = await ctx.stores.proposals.create({
      title: "Configure Y",
      targetPath: "configure-y.md",
      markdown: "# Configure Y\nbody",
      rationale: "r",
      evidence: [],
      gapSummary: "How to configure Y",
      triggeringQuestionIds: [log.id],
      flowId: "flow-b"
    });
    await ctx.stores.proposals.updateStatus(created.id, "merged");

    // Reconcile the default flow: the flow-b orphan must not be picked up here.
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
    assert.equal(await verifyJobCount(ctx), 0, "another flow's orphan is not swept by the default flow tick");

    // Its own flow's tick recovers it.
    await reconcileGaps(ctx, "flow-b", { fetchPullRequestStatus: async () => undefined });
    assert.equal(await verifyJobCount(ctx), 1, "the owning flow's tick recovers its orphan");
  });
});

describe("applyPullRequestTransition replay safety (#282)", () => {
  it("re-drives the cascade when replayed against an already-merged, uncascaded proposal", async () => {
    const ctx = makeTestContext();
    const id = await seedOrphanedMerge(ctx);
    // The proposal is already `merged` (as if a prior transition committed the
    // status but its cascade threw before enqueuing verification). A completeJob
    // replay re-invokes the transition with the same merged reading.
    const acted = await applyPullRequestTransition(ctx, id, { merged: true, state: "closed" });

    assert.equal(acted, true, "the replay re-drove the interrupted cascade");
    assert.equal(await verifyJobCount(ctx), 1, "verification is now enqueued");
  });

  it("is a no-op when replayed against a merged proposal whose cascade already completed", async () => {
    const ctx = makeTestContext();
    const id = await seedOrphanedMerge(ctx);
    // First transition-equivalent: enqueue the verify job as the cascade would.
    await ctx.jobs.create("verify_gap_closure", { proposalId: id });

    const acted = await applyPullRequestTransition(ctx, id, { merged: true, state: "closed" });

    assert.equal(acted, false, "nothing to re-drive — the cascade already landed");
    assert.equal(await verifyJobCount(ctx), 1, "no duplicate verification job is enqueued");
  });

  it("still transitions a genuinely pr-opened proposal to merged", async () => {
    const ctx = makeTestContext();
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure Z?",
      chatProvider: "codex",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure Z");
    const created = await ctx.stores.proposals.create({
      title: "Configure Z",
      targetPath: "configure-z.md",
      markdown: "# Configure Z\nbody",
      rationale: "r",
      evidence: [],
      gapSummary: "How to configure Z",
      triggeringQuestionIds: [log.id]
    });
    await ctx.stores.proposals.recordPublication(created.id, {
      provider: "local-git",
      branchName: "magpie/proposal-configure-z",
      commitSha: "deadbeef",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });

    const acted = await applyPullRequestTransition(ctx, created.id, { merged: true, state: "closed" });

    assert.equal(acted, true);
    assert.equal((await ctx.stores.proposals.get(created.id))?.status, "merged");
    assert.equal(await verifyJobCount(ctx), 1, "the first merge runs the cascade");
  });
});
