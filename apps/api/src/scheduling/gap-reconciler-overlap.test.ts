import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";
import type { AppContext } from "../context.js";

async function openPr(ctx: AppContext, title: string, targetPath: string, prUrl: string): Promise<string> {
  const proposal = await ctx.stores.proposals.create({
    title,
    targetPath,
    markdown: "#",
    rationale: "r",
    evidence: [],
    triggeringQuestionIds: []
  });
  await ctx.stores.proposals.recordPublication(proposal.id, {
    provider: "local-git",
    branchName: `b-${title}`,
    commitSha: "sha",
    pullRequestUrl: prUrl,
    publishedAt: new Date().toISOString()
  });
  return proposal.id;
}

const keepOpen = {
  fetchPullRequestStatus: async () => ({ merged: false, state: "open" as const, mergeable: "unknown" as const })
};

describe("detectOverlaps", () => {
  it("cross-links two open PRs that touch the same file", async () => {
    const ctx = makeTestContext();
    const a = await openPr(ctx, "A", "kb/same.md", "https://github.com/o/r/pull/1");
    const b = await openPr(ctx, "B", "kb/same.md", "https://github.com/o/r/pull/2");

    await reconcileGaps(ctx, undefined, keepOpen);

    const jobs = (await ctx.jobs.list({ type: "crosslink_pull_requests" })).jobs;
    assert.equal(jobs.length, 1, "one crosslink job for the overlapping pair");
    assert.equal(await ctx.stores.prCrosslinks.has(a, b), true);
  });

  it("does not cross-link PRs on different files", async () => {
    const ctx = makeTestContext();
    await openPr(ctx, "A", "kb/one.md", "https://github.com/o/r/pull/1");
    await openPr(ctx, "B", "kb/two.md", "https://github.com/o/r/pull/2");
    await reconcileGaps(ctx, undefined, keepOpen);
    assert.equal((await ctx.jobs.list({ type: "crosslink_pull_requests" })).jobs.length, 0);
  });

  it("is idempotent — a second run enqueues no new job", async () => {
    const ctx = makeTestContext();
    await openPr(ctx, "A", "kb/same.md", "https://github.com/o/r/pull/1");
    await openPr(ctx, "B", "kb/same.md", "https://github.com/o/r/pull/2");
    await reconcileGaps(ctx, undefined, keepOpen);
    await reconcileGaps(ctx, undefined, keepOpen);
    assert.equal((await ctx.jobs.list({ type: "crosslink_pull_requests" })).jobs.length, 1);
  });

  it("skips branch-only proposals with no pull request url", async () => {
    const ctx = makeTestContext();
    const proposal = await ctx.stores.proposals.create({
      title: "A",
      targetPath: "kb/same.md",
      markdown: "#",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });
    await ctx.stores.proposals.recordPublication(proposal.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "sha",
      publishedAt: new Date().toISOString()
    });
    await openPr(ctx, "B", "kb/same.md", "https://github.com/o/r/pull/2");
    await reconcileGaps(ctx, undefined, keepOpen);
    assert.equal((await ctx.jobs.list({ type: "crosslink_pull_requests" })).jobs.length, 0);
  });
});
