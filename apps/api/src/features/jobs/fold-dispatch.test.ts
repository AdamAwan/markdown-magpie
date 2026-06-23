import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestContext } from "../../test-support/context.js";
import { completeJob, failJob } from "./service.js";
import type { AppContext } from "../../context.js";

const draftInput = {
  provider: "codex" as const,
  gapSummaries: ["g"],
  triggeringQuestions: ["q"],
  evidence: [],
  expectedOutput: "markdown_proposal" as const
};
const draftOutput = (title: string) => ({ title, targetPath: "ignored", markdown: "# body", rationale: "r" });

async function completeDraft(ctx: AppContext, title: string): Promise<void> {
  const job = await ctx.jobs.create("draft_markdown_proposal", draftInput);
  const result = await completeJob(ctx, job.id, draftOutput(title));
  assert.ok(result.ok, "draft completion should succeed");
}

test("a second draft on the same target enqueues a fold instead of a rival", async () => {
  const ctx = makeTestContext();
  // Two drafts with the same title resolve to the same targetPath, so the second
  // overlaps the first.
  await completeDraft(ctx, "Refund policy");
  assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0, "first draft: no fold");

  await completeDraft(ctx, "Refund policy");
  const folds = (await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs;
  assert.equal(folds.length, 1, "second draft on the same path enqueues exactly one fold");
});

test("completing a fold job applies it (rival superseded, survivor markdown updated)", async () => {
  const ctx = makeTestContext();
  const survivor = await ctx.stores.proposals.create({
    title: "A", targetPath: "kb/refunds.md", markdown: "# survivor", rationale: "r", evidence: []
  });
  const rival = await ctx.stores.proposals.create({
    title: "B", targetPath: "kb/refunds.md", markdown: "# rival", rationale: "r", evidence: []
  });
  const job = await ctx.jobs.create("fold_markdown_proposal", {
    provider: "codex",
    survivorProposalId: survivor.id,
    rivalProposalId: rival.id,
    targetPath: "kb/refunds.md",
    survivorMarkdown: "# survivor",
    rivalMarkdown: "# rival",
    rivalGapSummaries: [],
    rivalEvidence: [],
    expectedOutput: "folded_markdown"
  });
  const result = await completeJob(ctx, job.id, { markdown: "# merged", rationale: "folded" });
  assert.ok(result.ok);
  assert.equal((await ctx.stores.proposals.get(survivor.id))?.markdown, "# merged");
  assert.equal((await ctx.stores.proposals.get(rival.id))?.status, "superseded");
});

test("a failed fold job enqueues the rival's publish fallback", async () => {
  const ctx = makeTestContext();
  const rival = await ctx.stores.proposals.create({
    title: "B", targetPath: "kb/refunds.md", markdown: "# rival", rationale: "r", evidence: []
  });
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
  // Exhaust all retries so the job reaches terminal "failed" state, which triggers the fallback.
  for (let attempt = 0; attempt <= job.retryLimit; attempt += 1) {
    await failJob(ctx, job.id, { code: "boom", message: "provider error", category: "provider", executor: "watcher" });
  }
  const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.ok(pending.some((a) => a.proposalId === rival.id && a.kind === "publish"));
});
