import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Proposal } from "@magpie/core";
import { makeTestContext } from "../../test-support/context.js";
import { attributionForMergedProposal } from "./change-attribution.js";

function merged(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "proposal-1",
    title: "Update billing rates",
    status: "merged",
    targetPath: "guide.md",
    markdown: "# Billing guide\n",
    evidence: [],
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

describe("attributionForMergedProposal", () => {
  it("resolves a source-sync proposal through to its upstream commit range", async () => {
    const ctx = makeTestContext();
    const job = await ctx.jobs.create("improve_document", {
      provider: "codex",
      path: "guide.md",
      content: "# Billing guide\n",
      sources: []
    });
    await ctx.stores.sourceSync.createRun({
      sourceId: "product-repo",
      trigger: "scheduled",
      status: "running",
      jobId: job.id,
      fromSha: "a1b2f3",
      toSha: "c3d4e5",
      changedFileCount: 3,
      candidateCount: 1
    });

    const attribution = await attributionForMergedProposal(ctx, merged({ jobId: job.id }));

    assert.deepEqual(attribution, {
      proposalId: "proposal-1",
      jobId: job.id,
      summary: "Update billing rates",
      cause: "source_sync",
      sourceId: "product-repo",
      sourceFromSha: "a1b2f3",
      sourceToSha: "c3d4e5"
    });
  });

  it("attributes a gap proposal to its gap, labelled with the gap summary", async () => {
    const ctx = makeTestContext();

    const attribution = await attributionForMergedProposal(
      ctx,
      merged({ gapClusterId: "cluster-1", gapSummary: "How do rate tiers work?" })
    );

    assert.equal(attribution.cause, "gap");
    assert.equal(attribution.summary, "How do rate tiers work?");
    assert.equal(attribution.proposalId, "proposal-1");
  });

  it("attributes a seed proposal to its plan", async () => {
    const ctx = makeTestContext();

    const attribution = await attributionForMergedProposal(ctx, merged({ seedPlanId: "plan-1" }));

    assert.equal(attribution.cause, "seed");
  });

  it("attributes a proposal drafted by a patrol lens to the patrol", async () => {
    const ctx = makeTestContext();
    const job = await ctx.jobs.create("improve_document", {
      provider: "codex",
      path: "guide.md",
      content: "# Billing guide\n",
      sources: []
    });

    const attribution = await attributionForMergedProposal(ctx, merged({ jobId: job.id }));

    assert.equal(attribution.cause, "patrol");
    assert.equal(attribution.jobId, job.id);
  });

  it("falls back to external for a proposal with nothing to attribute", async () => {
    const ctx = makeTestContext();

    const attribution = await attributionForMergedProposal(ctx, merged());

    assert.deepEqual(attribution, {
      proposalId: "proposal-1",
      summary: "Update billing rates",
      cause: "external"
    });
  });

  it("falls back to external when a lookup fails, rather than failing the cascade", async () => {
    // Attribution is a decoration on an independently-correct diff: an entry with
    // an unresolved cause still records a true change.
    const ctx = makeTestContext();
    ctx.stores.sourceSync.getRunByJobId = async () => {
      throw new Error("source sync store unavailable");
    };

    const attribution = await attributionForMergedProposal(ctx, merged({ jobId: "job-1", gapClusterId: "cluster-1" }));

    assert.equal(attribution.cause, "external");
    assert.equal(attribution.proposalId, "proposal-1");
  });
});
