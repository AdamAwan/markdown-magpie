import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import { makeTestContext } from "../../test-support/context.js";
import { createProposalFromCompletedJob, draftFromGaps } from "./service.js";

const draftOutput = {
  title: "Refund timing",
  targetPath: "kb/refunds.md",
  markdown: "# Refunds",
  rationale: "covers the gap"
};

function draftJob(input: Record<string, unknown>): JobView {
  return {
    id: "job-1",
    type: "draft_markdown_proposal",
    input,
    state: "completed"
  } as unknown as JobView;
}

describe("createProposalFromCompletedJob cluster linking", () => {
  it("links the created proposal to the gapClusterId in the job input", async () => {
    const ctx = makeTestContext();
    const proposal = await createProposalFromCompletedJob(
      ctx,
      draftJob({ gapSummaries: ["g"], evidence: [], gapClusterId: "cluster-7" }),
      draftOutput
    );
    assert.equal(proposal?.gapClusterId, "cluster-7");
  });

  it("leaves the proposal unlinked when the job input has no gapClusterId", async () => {
    const ctx = makeTestContext();
    const proposal = await createProposalFromCompletedJob(
      ctx,
      draftJob({ gapSummaries: ["g"], evidence: [] }),
      draftOutput
    );
    assert.equal(proposal?.gapClusterId, undefined);
  });
});

describe("draftFromGaps threads gapClusterId into the job input", () => {
  async function seedGap(ctx: ReturnType<typeof makeTestContext>, summary: string): Promise<void> {
    const log = await ctx.stores.questionLogs.record({
      question: `${summary}?`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, summary);
  }

  it("includes gapClusterId in the enqueued draft job when provided", async () => {
    const ctx = makeTestContext();
    await seedGap(ctx, "Refunds");
    const outcome = await draftFromGaps(ctx, ["Refunds"], { gapClusterId: "cluster-9" });
    assert.equal(outcome.ok, true);
    const jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0].input as { gapClusterId?: string }).gapClusterId, "cluster-9");
  });

  it("omits gapClusterId on the on-demand path", async () => {
    const ctx = makeTestContext();
    await seedGap(ctx, "Refunds");
    const outcome = await draftFromGaps(ctx, ["Refunds"], {});
    assert.equal(outcome.ok, true);
    const jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal((jobs[0].input as { gapClusterId?: string }).gapClusterId, undefined);
  });
});
