import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileDraftedProposal, reconcileCorrectiveProposal, reconcileDedupeProposal, reconcileSplitProposal, reconcileImproveProposal, reconcileSourceSyncProposal, applyFoldFromCompletedJob, applyChangesetFoldFromCompletedJob, enqueueFoldFallback } from "./fold.js";
import type { AppContext } from "../context.js";

async function clusterWithGap(ctx: AppContext, flowId: string | undefined, summary: string): Promise<string> {
  const log = await ctx.stores.questionLogs.record({
    question: `${summary}?`,
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, summary);
  const cluster = await ctx.stores.gapClusters.createCluster({ ...(flowId ? { flowId } : {}), title: summary, revision: 1 });
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary(summary);
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);
  return cluster.id;
}

async function draft(ctx: AppContext, opts: { targetPath: string; gapClusterId?: string }) {
  return ctx.stores.proposals.create({
    title: "T",
    targetPath: opts.targetPath,
    markdown: "# body",
    rationale: "r",
    evidence: [],
    ...(opts.gapClusterId ? { gapClusterId: opts.gapClusterId } : {})
  });
}

describe("reconcileDraftedProposal", () => {
  it("enqueues a fold job when a same-flow open proposal overlaps", async () => {
    const ctx = makeTestContext();
    await draft(ctx, { targetPath: "kb/refunds.md" }); // survivor A
    const rival = await draft(ctx, { targetPath: "kb/refunds.md" }); // rival B
    await reconcileDraftedProposal(ctx, rival);
    const jobs = (await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs;
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0].input as { rivalProposalId: string }).rivalProposalId, rival.id);
  });

  it("does not fold when there is no overlap", async () => {
    const ctx = makeTestContext();
    await draft(ctx, { targetPath: "kb/a.md" });
    const rival = await draft(ctx, { targetPath: "kb/b.md" });
    await reconcileDraftedProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
  });

  it("does not fold across flows", async () => {
    const ctx = makeTestContext();
    const cA = await clusterWithGap(ctx, "flow-x", "A");
    const cB = await clusterWithGap(ctx, "flow-y", "B");
    await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cA });
    const rival = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cB });
    await reconcileDraftedProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
  });

  it("publishes the rival as its own PR when it overlaps only an approved PR", async () => {
    const ctx = makeTestContext();
    // Survivor is an open, approved PR on the same file.
    const survivor = await draft(ctx, { targetPath: "kb/refunds.md" });
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/5",
      publishedAt: new Date().toISOString()
    });
    await ctx.stores.proposals.updateReviewDecision(survivor.id, "approved");

    const rival = await draft(ctx, { targetPath: "kb/refunds.md" });
    await reconcileDraftedProposal(ctx, rival);

    // No fold job — the approved PR is non-touchable, so the gate defers.
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
    // Instead the rival is enqueued to publish as its own PR.
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === rival.id && a.kind === "publish"));
  });
});

describe("reconcileCorrectiveProposal", () => {
  it("open-new (no overlap) enqueues a publish action", async () => {
    const ctx = makeTestContext();
    const proposal = await ctx.stores.proposals.create({
      title: "Verify: correct unprovable claims in a.md",
      targetPath: "a.md",
      markdown: "# a",
      rationale: "r",
      evidence: [],
      flowId: "billing"
    });
    await reconcileCorrectiveProposal(ctx, proposal);
    const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.deepEqual(
      actions.map((a) => ({ proposalId: a.proposalId, kind: a.kind })),
      [{ proposalId: proposal.id, kind: "publish" }]
    );
  });

  it("fold (overlapping touchable PR) enqueues a fold_markdown_proposal job, no publish", async () => {
    const ctx = makeTestContext();
    const survivor = await ctx.stores.proposals.create({
      title: "Gap doc",
      targetPath: "a.md",
      markdown: "# survivor",
      rationale: "r",
      evidence: [],
      flowId: "billing"
    });
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });
    const rival = await ctx.stores.proposals.create({
      title: "Verify: correct unprovable claims in a.md",
      targetPath: "a.md",
      markdown: "# rival",
      rationale: "r",
      evidence: [],
      flowId: "billing"
    });
    await reconcileCorrectiveProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 1);
    assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
  });
});

describe("reconcileDedupeProposal", () => {
  const dedupeRival = (ctx: ReturnType<typeof makeTestContext>) =>
    ctx.stores.proposals.create({
      title: "Dedupe: reconcile kb/a.md with kb/b.md",
      targetPath: "kb/a.md",
      markdown: "# A merged",
      rationale: "merged the duplicate",
      evidence: [],
      flowId: "billing",
      changeset: [
        { path: "kb/a.md", content: "# A merged" },
        { path: "kb/b.md", delete: true }
      ]
    });

  it("open-new (no overlap) enqueues a publish action", async () => {
    const ctx = makeTestContext();
    const proposal = await dedupeRival(ctx);
    await reconcileDedupeProposal(ctx, proposal);
    const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.deepEqual(
      actions.map((a) => ({ proposalId: a.proposalId, kind: a.kind })),
      [{ proposalId: proposal.id, kind: "publish" }]
    );
    assert.equal((await ctx.jobs.list({ type: "fold_changeset_proposal" })).jobs.length, 0);
  });

  it("fold (touchable PR overlapping a file in the file-set) enqueues a fold_changeset_proposal, no publish", async () => {
    const ctx = makeTestContext();
    // An open PR on kb/b.md — the doc the dedupe would delete — overlaps the file-set.
    const survivor = await ctx.stores.proposals.create({
      title: "Gap doc",
      targetPath: "kb/b.md",
      markdown: "# survivor",
      rationale: "r",
      evidence: [],
      flowId: "billing"
    });
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });
    const rival = await dedupeRival(ctx);

    await reconcileDedupeProposal(ctx, rival);
    const foldJobs = (await ctx.jobs.list({ type: "fold_changeset_proposal" })).jobs;
    assert.equal(foldJobs.length, 1);
    assert.equal((foldJobs[0].input as { survivorProposalId: string }).survivorProposalId, survivor.id);
    assert.deepEqual((foldJobs[0].input as { sharedPaths: string[] }).sharedPaths, ["kb/b.md"]);
    assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
  });

  it("defer (overlap only an approved PR) self-publishes the dedupe change", async () => {
    const ctx = makeTestContext();
    const approved = await ctx.stores.proposals.create({
      title: "Gap doc",
      targetPath: "kb/b.md",
      markdown: "# approved",
      rationale: "r",
      evidence: [],
      flowId: "billing"
    });
    await ctx.stores.proposals.recordPublication(approved.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/2",
      publishedAt: new Date().toISOString()
    });
    await ctx.stores.proposals.updateReviewDecision(approved.id, "approved");
    const rival = await dedupeRival(ctx);

    await reconcileDedupeProposal(ctx, rival);
    // Folding into an approved PR would invalidate its review, so the dedupe self-publishes.
    assert.equal((await ctx.jobs.list({ type: "fold_changeset_proposal" })).jobs.length, 0);
    const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.deepEqual(
      actions.map((a) => a.proposalId),
      [rival.id]
    );
  });
});

describe("reconcileSplitProposal", () => {
  const splitRival = (ctx: ReturnType<typeof makeTestContext>) =>
    ctx.stores.proposals.create({
      title: "Split: reorganise kb/operations.md",
      targetPath: "kb/operations.md",
      markdown: "# Operations",
      rationale: "moved billing out",
      evidence: [],
      flowId: "billing",
      changeset: [
        { path: "kb/operations.md", content: "# Operations" },
        { path: "kb/billing.md", delete: true },
        { path: "kb/billing-guide.md", content: "# Billing Guide" }
      ]
    });

  it("open-new (no overlap) enqueues a publish action", async () => {
    const ctx = makeTestContext();
    const proposal = await splitRival(ctx);
    await reconcileSplitProposal(ctx, proposal);
    const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.deepEqual(
      actions.map((a) => ({ proposalId: a.proposalId, kind: a.kind })),
      [{ proposalId: proposal.id, kind: "publish" }]
    );
    assert.equal((await ctx.jobs.list({ type: "fold_changeset_proposal" })).jobs.length, 0);
  });

  it("fold (touchable PR overlapping any touched path) enqueues fold_changeset_proposal", async () => {
    const ctx = makeTestContext();
    const survivor = await ctx.stores.proposals.create({
      title: "Billing doc",
      targetPath: "kb/billing-guide.md",
      markdown: "# survivor",
      rationale: "r",
      evidence: [],
      flowId: "billing"
    });
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });
    const rival = await splitRival(ctx);

    await reconcileSplitProposal(ctx, rival);
    const foldJobs = (await ctx.jobs.list({ type: "fold_changeset_proposal" })).jobs;
    assert.equal(foldJobs.length, 1);
    assert.equal((foldJobs[0].input as { survivorProposalId: string }).survivorProposalId, survivor.id);
    assert.deepEqual((foldJobs[0].input as { sharedPaths: string[] }).sharedPaths, ["kb/billing-guide.md"]);
    assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
  });
});

describe("reconcileImproveProposal", () => {
  const improveRival = (ctx: ReturnType<typeof makeTestContext>) =>
    ctx.stores.proposals.create({
      title: "Improve: expand kb/refunds.md",
      targetPath: "kb/refunds.md",
      markdown: "# Refunds\nPartial refunds are supported.",
      rationale: "Added source-backed coverage.",
      evidence: [],
      flowId: "billing"
    });

  it("open-new (no overlap) enqueues a publish action", async () => {
    const ctx = makeTestContext();
    const proposal = await improveRival(ctx);
    await reconcileImproveProposal(ctx, proposal);
    const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.deepEqual(
      actions.map((a) => ({ proposalId: a.proposalId, kind: a.kind })),
      [{ proposalId: proposal.id, kind: "publish" }]
    );
  });

  it("fold (overlapping touchable PR) enqueues a fold_markdown_proposal job", async () => {
    const ctx = makeTestContext();
    const survivor = await ctx.stores.proposals.create({
      title: "Gap doc",
      targetPath: "kb/refunds.md",
      markdown: "# survivor",
      rationale: "r",
      evidence: [],
      flowId: "billing"
    });
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });
    const rival = await improveRival(ctx);

    await reconcileImproveProposal(ctx, rival);
    const foldJobs = (await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs;
    assert.equal(foldJobs.length, 1);
    assert.equal((foldJobs[0].input as { rivalProposalId: string }).rivalProposalId, rival.id);
    assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
  });

  it("defer (overlap only an approved PR) self-publishes the improve proposal", async () => {
    const ctx = makeTestContext();
    const approved = await ctx.stores.proposals.create({
      title: "Approved doc",
      targetPath: "kb/refunds.md",
      markdown: "# approved",
      rationale: "r",
      evidence: [],
      flowId: "billing"
    });
    await ctx.stores.proposals.recordPublication(approved.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/2",
      publishedAt: new Date().toISOString()
    });
    await ctx.stores.proposals.updateReviewDecision(approved.id, "approved");
    const rival = await improveRival(ctx);

    await reconcileImproveProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
    const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.deepEqual(actions.map((a) => a.proposalId), [rival.id]);
  });
});
describe("applyFoldFromCompletedJob", () => {
  it("updates survivor markdown, absorbs the rival cluster, supersedes the rival, and enqueues a publish", async () => {
    const ctx = makeTestContext();
    const cA = await clusterWithGap(ctx, undefined, "survivor");
    const cB = await clusterWithGap(ctx, undefined, "rival");
    const survivor = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cA });
    const rival = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cB });

    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: survivor.id,
      rivalProposalId: rival.id,
      targetPath: "kb/refunds.md",
      survivorMarkdown: "# survivor",
      rivalMarkdown: "# rival",
      rivalGapSummaries: ["rival"],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    const stored = await ctx.jobs.get(job.id);
    await applyFoldFromCompletedJob(ctx, stored, { markdown: "# merged", rationale: "folded" });

    assert.equal((await ctx.stores.proposals.get(survivor.id))?.markdown, "# merged");
    assert.equal((await ctx.stores.proposals.get(rival.id))?.status, "superseded");
    assert.equal((await ctx.stores.gapClusters.getCluster(cB))?.status, "frozen");
    const survivorMembers = await ctx.stores.gapClusters.listMembershipsForCluster(cA);
    assert.equal(survivorMembers.length, 2, "rival's gap moved onto the survivor cluster");
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === survivor.id && a.kind === "publish"));
    assert.equal((await ctx.jobs.list({ type: "comment_pull_request" })).jobs.length, 0, "no PR to comment on");
  });

  it("writes the merged content into the changeset's primary entry when the survivor is a changeset proposal", async () => {
    const ctx = makeTestContext();
    // A dedupe/split survivor publishes from its changeset, not its markdown. A
    // single-file rival (gap/verify/improve) folding into it must update the
    // changeset's primary entry, or the merge is silently lost at publish time.
    const survivor = await ctx.stores.proposals.create({
      title: "Dedupe: reconcile a with b",
      targetPath: "kb/a.md",
      markdown: "# a (stale primary)",
      rationale: "dup",
      evidence: [],
      changeset: [
        { path: "kb/a.md", content: "# a (stale primary)" },
        { path: "kb/b.md", delete: true }
      ]
    });
    const rival = await draft(ctx, { targetPath: "kb/a.md" });

    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: survivor.id,
      rivalProposalId: rival.id,
      targetPath: "kb/a.md",
      survivorMarkdown: "# a (stale primary)",
      rivalMarkdown: "# rival",
      rivalGapSummaries: [],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    await applyFoldFromCompletedJob(ctx, await ctx.jobs.get(job.id), { markdown: "# a (merged)", rationale: "folded" });

    const updated = await ctx.stores.proposals.get(survivor.id);
    // The merged content is what publishes: it must live in the changeset's primary entry.
    assert.equal(updated?.changeset?.find((c) => c.path === "kb/a.md")?.content, "# a (merged)");
    // The other file in the changeset is carried through untouched.
    assert.equal(updated?.changeset?.find((c) => c.path === "kb/b.md")?.delete, true);
    // markdown stays in sync with the primary entry.
    assert.equal(updated?.markdown, "# a (merged)");
    assert.equal((await ctx.stores.proposals.get(rival.id))?.status, "superseded");
  });

  it("is idempotent: a second call with the same job is a no-op", async () => {
    const ctx = makeTestContext();
    const cA = await clusterWithGap(ctx, undefined, "survivor2");
    const cB = await clusterWithGap(ctx, undefined, "rival2");
    const survivor = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cA });
    const rival = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cB });

    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: survivor.id,
      rivalProposalId: rival.id,
      targetPath: "kb/refunds.md",
      survivorMarkdown: "# survivor",
      rivalMarkdown: "# rival",
      rivalGapSummaries: ["rival2"],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    const stored = await ctx.jobs.get(job.id);
    const output = { markdown: "# merged", rationale: "folded" };

    await applyFoldFromCompletedJob(ctx, stored, output);
    // Second call — rival is now superseded so the early-return guard should fire.
    await applyFoldFromCompletedJob(ctx, stored, output);

    const survivorMembers = await ctx.stores.gapClusters.listMembershipsForCluster(cA);
    assert.equal(survivorMembers.length, 2, "rival's gap was not absorbed a second time");
    assert.equal((await ctx.stores.proposals.get(rival.id))?.status, "superseded");
  });

  it("enqueues a comment_pull_request job when the survivor has an open PR", async () => {
    const ctx = makeTestContext();
    const cA = await clusterWithGap(ctx, undefined, "survivor-pr");
    const cB = await clusterWithGap(ctx, undefined, "rival-pr");
    const survivor = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cA });
    const rival = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cB });

    const prUrl = "https://github.com/o/r/pull/9";
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: prUrl,
      publishedAt: new Date().toISOString()
    });

    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: survivor.id,
      rivalProposalId: rival.id,
      targetPath: "kb/refunds.md",
      survivorMarkdown: "# survivor",
      rivalMarkdown: "# rival",
      rivalGapSummaries: ["rival-pr"],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    const stored = await ctx.jobs.get(job.id);
    await applyFoldFromCompletedJob(ctx, stored, { markdown: "# merged", rationale: "folded" });

    const commentJobs = (await ctx.jobs.list({ type: "comment_pull_request" })).jobs;
    assert.equal(commentJobs.length, 1, "a comment_pull_request job was enqueued");
    assert.equal((commentJobs[0].input as { pullRequestUrl: string }).pullRequestUrl, prUrl);
  });
});

describe("applyChangesetFoldFromCompletedJob", () => {
  async function setup(ctx: ReturnType<typeof makeTestContext>) {
    const survivor = await draft(ctx, { targetPath: "kb/b.md" });
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });
    const rival = await ctx.stores.proposals.create({
      title: "Dedupe: reconcile kb/a.md with kb/b.md",
      targetPath: "kb/a.md",
      markdown: "# A merged",
      rationale: "r",
      evidence: [],
      flowId: "billing",
      changeset: [
        { path: "kb/a.md", content: "# A merged" },
        { path: "kb/b.md", delete: true }
      ]
    });
    const job = await ctx.jobs.create("fold_changeset_proposal", {
      provider: "codex",
      survivorProposalId: survivor.id,
      rivalProposalId: rival.id,
      survivorChangeset: [{ path: "kb/b.md", content: "# B" }],
      rivalChangeset: rival.changeset!,
      sharedPaths: ["kb/b.md"],
      expectedOutput: "folded_changeset"
    });
    return { survivor, rival, job };
  }

  it("promotes the survivor to the merged file-set, supersedes the rival, and re-publishes", async () => {
    const ctx = makeTestContext();
    const { survivor, rival, job } = await setup(ctx);
    const merged = [
      { path: "kb/b.md", content: "# B\nnow covers A" },
      { path: "kb/a.md", delete: true }
    ];

    await applyChangesetFoldFromCompletedJob(ctx, await ctx.jobs.get(job.id), { changeset: merged, rationale: "merged" });

    const updated = await ctx.stores.proposals.get(survivor.id);
    assert.deepEqual(updated?.changeset, merged);
    assert.equal(updated?.markdown, "# B\nnow covers A"); // primary (targetPath kb/b.md) content
    assert.equal(updated?.targetPath, "kb/b.md");
    assert.equal((await ctx.stores.proposals.get(rival.id))?.status, "superseded");
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === survivor.id && a.kind === "publish"));
    assert.equal((await ctx.jobs.list({ type: "comment_pull_request" })).jobs.length, 1);
  });

  it("no-ops when the rival is already superseded (idempotent)", async () => {
    const ctx = makeTestContext();
    const { survivor, rival, job } = await setup(ctx);
    await ctx.stores.proposals.updateStatus(rival.id, "superseded");

    await applyChangesetFoldFromCompletedJob(ctx, await ctx.jobs.get(job.id), {
      changeset: [{ path: "kb/b.md", content: "# changed" }],
      rationale: "x"
    });
    // Survivor untouched (still single-file), no publish enqueued.
    assert.equal((await ctx.stores.proposals.get(survivor.id))?.changeset, undefined);
    assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
  });
});

describe("enqueueFoldFallback", () => {
  it("enqueues the rival's publish so the gap is not lost", async () => {
    const ctx = makeTestContext();
    const rival = await draft(ctx, { targetPath: "kb/refunds.md" });
    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: "missing",
      rivalProposalId: rival.id,
      targetPath: "kb/refunds.md",
      survivorMarkdown: "x",
      rivalMarkdown: "y",
      rivalGapSummaries: [],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    await enqueueFoldFallback(ctx, await ctx.jobs.get(job.id));
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === rival.id && a.kind === "publish"));
  });

  it("also republishes a still-draft rival when a multi-file fold job fails", async () => {
    const ctx = makeTestContext();
    const rival = await ctx.stores.proposals.create({
      title: "Dedupe: reconcile kb/a.md with kb/b.md",
      targetPath: "kb/a.md",
      markdown: "# A merged",
      rationale: "r",
      evidence: [],
      flowId: "billing",
      changeset: [{ path: "kb/a.md", content: "# A merged" }, { path: "kb/b.md", delete: true }]
    });
    const job = await ctx.jobs.create("fold_changeset_proposal", {
      provider: "codex",
      survivorProposalId: "missing",
      rivalProposalId: rival.id,
      survivorChangeset: [{ path: "kb/b.md", content: "# B" }],
      rivalChangeset: rival.changeset!,
      sharedPaths: ["kb/b.md"],
      expectedOutput: "folded_changeset"
    });
    await enqueueFoldFallback(ctx, await ctx.jobs.get(job.id));
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === rival.id && a.kind === "publish"));
  });
});

describe("reconcileSourceSyncProposal", () => {
  it("folds a source-sync proposal into a touchable overlapping proposal", async () => {
    const ctx = makeTestContext();
    const survivor = await ctx.stores.proposals.create({
      title: "Guide",
      targetPath: "guide.md",
      markdown: "# Guide\nold",
      rationale: "",
      evidence: [],
      triggeringQuestionIds: [],
      flowId: "docs"
    });
    const rival = await ctx.stores.proposals.create({
      title: "Sync docs to Rules changes",
      targetPath: "guide.md",
      markdown: "# Guide\nnew",
      rationale: "",
      evidence: [],
      triggeringQuestionIds: [],
      flowId: "docs",
      changeset: [{ path: "guide.md", content: "# Guide\nnew" }]
    });

    await reconcileSourceSyncProposal(ctx, rival);

    const jobs = (await ctx.jobs.list({})).jobs;
    const fold = jobs.find((job) => job.type === "fold_changeset_proposal");
    assert.ok(fold, "fold job enqueued");
    assert.equal((fold.input as { survivorProposalId: string }).survivorProposalId, survivor.id);
    assert.equal((fold.input as { rivalProposalId: string }).rivalProposalId, rival.id);
  });

  it("publishes a source-sync proposal with no overlap", async () => {
    const ctx = makeTestContext();
    const proposal = await ctx.stores.proposals.create({
      title: "Sync docs to Rules changes",
      targetPath: "guide.md",
      markdown: "# Guide\nnew",
      rationale: "",
      evidence: [],
      triggeringQuestionIds: [],
      flowId: "docs",
      changeset: [{ path: "guide.md", content: "# Guide\nnew" }]
    });

    await reconcileSourceSyncProposal(ctx, proposal);

    const publishJobs = (await ctx.jobs.list({})).jobs.filter((job) => job.type === "publish_proposal");
    assert.equal(publishJobs.length, 1);
    assert.deepEqual((publishJobs[0].input as { proposalId: string }).proposalId, proposal.id);
  });

  it("publishes a source-sync proposal when overlap is non-touchable (approved)", async () => {
    const ctx = makeTestContext();
    const approved = await ctx.stores.proposals.create({
      title: "Approved Guide",
      targetPath: "guide.md",
      markdown: "# Guide\napproved",
      rationale: "",
      evidence: [],
      triggeringQuestionIds: [],
      flowId: "docs"
    });
    await ctx.stores.proposals.updateReviewDecision(approved.id, "approved");
    const rival = await ctx.stores.proposals.create({
      title: "Sync docs to Rules changes",
      targetPath: "guide.md",
      markdown: "# Guide\nnew",
      rationale: "",
      evidence: [],
      triggeringQuestionIds: [],
      flowId: "docs",
      changeset: [{ path: "guide.md", content: "# Guide\nnew" }]
    });

    await reconcileSourceSyncProposal(ctx, rival);

    const jobs = (await ctx.jobs.list({})).jobs;
    assert.equal(jobs.some((job) => job.type === "fold_changeset_proposal"), false);
    const publishJobs = jobs.filter((job) => job.type === "publish_proposal");
    assert.equal(publishJobs.length, 1);
    assert.equal((publishJobs[0].input as { proposalId: string }).proposalId, rival.id);
  });
});
