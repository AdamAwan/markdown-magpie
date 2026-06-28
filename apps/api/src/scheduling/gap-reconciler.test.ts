import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobType, JobView } from "@magpie/jobs";
import { reconcileGapClustersOutputSchema } from "@magpie/jobs";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import { RuntimeConfigHolder } from "../config-holder.js";
import { FakeJobBroker } from "../jobs/fake-broker.js";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";

type ReconcileOutput = z.infer<typeof reconcileGapClustersOutputSchema>;

// A broker that immediately completes any reconcile_gap_clusters job with the
// output the watcher's chat runner would have produced, so the reconciler's
// enqueue+bounded-wait resolves to a terminal job in-process. Other job types
// behave exactly like the FakeJobBroker (created, never completed).
class ReshapingJobBroker extends FakeJobBroker {
  constructor(private readonly buildOutput: (input: unknown) => ReconcileOutput) {
    super();
  }

  override async create(type: JobType, input: unknown): Promise<JobView> {
    const job = await super.create(type, input);
    if (type === "reconcile_gap_clusters") {
      return super.complete(job.id, this.buildOutput(job.input));
    }
    return job;
  }
}

// A broker that enqueues the reconcile job normally but then throws when the
// bounded-wait polls it (runJobToCompletion -> waitForJob -> get). This mirrors a
// broker dying mid-poll: requestReshape's try/catch must swallow it and skip the
// reshape, leaving the rest of reconcileGaps to run.
class ThrowingPollJobBroker extends FakeJobBroker {
  private reshapeJobId: string | undefined;

  override async create(type: JobType, input: unknown): Promise<JobView> {
    const job = await super.create(type, input);
    if (type === "reconcile_gap_clusters") {
      this.reshapeJobId = job.id;
    }
    return job;
  }

  override async get(id: string): Promise<JobView | undefined> {
    if (id === this.reshapeJobId) {
      throw new Error("broker connection lost mid-poll");
    }
    return super.get(id);
  }
}

describe("reconcileGaps revision gate", () => {
  it("does no model work when the catalog revision is unchanged and no actions pending", async () => {
    const ctx = makeTestContext();

    // processed revision already equals the catalog revision (both 0), no actions:
    // with nothing changed the reconciler enqueues no reshape job.
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
    assert.equal(
      (await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length,
      0,
      "no reshape job enqueued when nothing changed"
    );
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
      chatProvider: "codex",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

    // A single new cluster has nothing to merge, so no reshape job is requested.
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 1, "the new gap created one cluster");
    const memberships = await ctx.stores.gapClusters.listActiveMemberships();
    assert.equal(memberships.length, 1);
  });

  it("does not reshape when the critic rejects the proposed merge", async () => {
    // The reshape AI job runs in the watcher now; the reconciler enqueues it and
    // applies only confirmed changes. Here the job comes back with the merge
    // unconfirmed (critic rejected it), so nothing is applied.
    const jobs = new ReshapingJobBroker((input) => {
      const clusterIds = (input as { clusters: Array<{ id: string }> }).clusters.map((c) => c.id);
      return { merges: [{ clusterIds, rationale: "x", confirmed: false }], splits: [] };
    });
    const ctx = makeTestContext({
      jobs,
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    await seedTwoClustersWithGaps(ctx);

    const before = await ctx.stores.gapClusters.listActiveClusters();
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
    const after = await ctx.stores.gapClusters.listActiveClusters();

    assert.equal((await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length, 1, "the reshape job was enqueued");
    assert.equal(after.length, before.length, "rejected merge left clusters unchanged");

    const decisions = await ctx.stores.reconciliations.list(50);
    const merge = decisions.find((d) => d.kind === "merge");
    assert.ok(merge, "the rejected merge was recorded as a decision");
    assert.equal(merge.confirmed, false, "the decision records the critic's rejection");
    assert.equal(merge.applied, false, "a rejected merge is not applied");
    assert.equal(merge.rationale, "x");
  });

  it("applies a critic-confirmed merge, keeping every gap exactly once", async () => {
    const jobs = new ReshapingJobBroker((input) => {
      const clusterIds = (input as { clusters: Array<{ id: string }> }).clusters.map((c) => c.id);
      return { merges: [{ clusterIds, rationale: "x", confirmed: true }], splits: [] };
    });
    const ctx = makeTestContext({
      jobs,
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    await seedTwoClustersWithGaps(ctx);

    const membershipsBefore = await ctx.stores.gapClusters.listActiveMemberships();
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });

    const after = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(after.length, 1, "the two clusters merged into one survivor");
    const membershipsAfter = await ctx.stores.gapClusters.listActiveMemberships();
    assert.equal(membershipsAfter.length, membershipsBefore.length, "every gap kept exactly one active membership");
    assert.ok(membershipsAfter.every((m) => m.clusterId === after[0].id), "all gaps now belong to the survivor");

    const decisions = await ctx.stores.reconciliations.list(50);
    const merge = decisions.find((d) => d.kind === "merge");
    assert.ok(merge, "the confirmed merge was recorded");
    assert.equal(merge.confirmed, true);
    assert.equal(merge.applied, true, "a confirmed merge is applied");
    assert.equal(merge.rationale, "x");
  });

  it("skips reshape (without throwing) when the reshape job never reaches a watcher", async () => {
    // A plain FakeJobBroker never completes the enqueued reconcile job, so the
    // bounded-wait hits its (tiny) deadline. Reshape is best-effort: the rest of
    // reconcileGaps must still run, exactly as the old code only reshaped when it
    // could. We drive a tiny deadline via the env override.
    const previous = process.env.JOB_RUN_TO_COMPLETION_TIMEOUT_MS;
    process.env.JOB_RUN_TO_COMPLETION_TIMEOUT_MS = "20";
    try {
      const ctx = makeTestContext({
        config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
      });
      await seedTwoClustersWithGaps(ctx);

      const before = await ctx.stores.gapClusters.listActiveClusters();
      await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
      const after = await ctx.stores.gapClusters.listActiveClusters();

      assert.equal((await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length, 1, "the reshape job was enqueued");
      assert.equal(after.length, before.length, "no reshape applied on timeout");
      assert.deepEqual(await ctx.stores.reconciliations.list(50), [], "no decision recorded when the job never ran");
    } finally {
      if (previous === undefined) {
        delete process.env.JOB_RUN_TO_COMPLETION_TIMEOUT_MS;
      } else {
        process.env.JOB_RUN_TO_COMPLETION_TIMEOUT_MS = previous;
      }
    }
  });

  it("skips reshape (without throwing) when the broker throws mid-poll", async () => {
    // The broker enqueues the reshape job but then throws when the bounded-wait
    // polls it. requestReshape wraps enqueue+wait in try/catch and treats a throw
    // as "skip reshape, continue reconcile" — so no merge/split is applied, no
    // reconciliation is recorded, no error escapes reconcileGaps, and the rest of
    // the run (e.g. drafting) still happens. Distinct from the timeout-skip test:
    // here the failure is a thrown error from the broker, not a quiet deadline.
    const jobs = new ThrowingPollJobBroker();
    const ctx = makeTestContext({
      jobs,
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    await seedTwoClustersWithGaps(ctx);

    const before = await ctx.stores.gapClusters.listActiveClusters();
    // Must resolve, not reject: the broker throw is caught inside requestReshape.
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
    const after = await ctx.stores.gapClusters.listActiveClusters();

    assert.equal((await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length, 1, "the reshape job was enqueued");
    assert.equal(after.length, before.length, "no reshape applied when the broker threw");
    assert.deepEqual(await ctx.stores.reconciliations.list(50), [], "no decision recorded when the reshape threw");
    // The rest of reconcileGaps still ran: each uncovered cluster got a draft job.
    assert.equal(
      (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs.length,
      before.length,
      "reconcile continued past the skipped reshape and drafted the uncovered clusters"
    );
  });
});

describe("reconcileGaps autonomous drafting", () => {
  // Drafting is now enqueue-only: autonomous reconciliation enqueues a
  // draft_markdown_proposal job per uncovered cluster. The proposal (and its
  // publish action) are created later by the Task 7 job-completion path, so these
  // tests assert the enqueue, not a synchronous proposal.
  it("enqueues a draft job for a brand-new cluster", async () => {
    const ctx = makeTestContext({
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure X?",
      
      chatProvider: "openai-compatible",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

    // A single cluster has nothing to merge, so no reshape job is requested.
    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    });

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 1, "one cluster was created for the gap");
    assert.deepEqual(await ctx.stores.proposals.list(500), [], "no proposal is created synchronously");
    const { jobs } = await ctx.jobs.list({ type: "draft_markdown_proposal" });
    assert.equal(jobs.length, 1, "a draft job was enqueued for the new cluster");
  });

  it("enqueues only the uncovered cluster on a later run, never duplicating", async () => {
    const jobs = new ReshapingJobBroker(() => ({ merges: [], splits: [] }));
    const ctx = makeTestContext({
      jobs,
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    const deps = {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    };

    const log1 = await ctx.stores.questionLogs.record({
      question: "q1?",
      
      chatProvider: "openai-compatible",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log1.id, "Topic one");
    await reconcileGaps(ctx, undefined, deps);
    // The just-enqueued draft completes into a proposal linked to its cluster, so
    // the cluster is "covered" before the next run (mirrors the completion path).
    const [cluster1] = await ctx.stores.gapClusters.listActiveClusters();
    const proposal1 = await ctx.stores.proposals.create({
      title: "Topic one", targetPath: "topic-one.md", markdown: "#", rationale: "r", evidence: [],
      gapClusterId: cluster1.id
    });
    assert.ok(proposal1);
    assert.equal((await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs.length, 1, "first run enqueues one draft");

    // A new, distinct gap advances the catalog and reopens the gate.
    const log2 = await ctx.stores.questionLogs.record({
      question: "q2?",
      
      chatProvider: "openai-compatible",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log2.id, "Topic two");
    await reconcileGaps(ctx, undefined, deps);

    assert.equal(
      (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs.length,
      2,
      "only the newly uncovered cluster was enqueued; the covered cluster was untouched"
    );
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

    let publishCalls = 0;
    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {
        publishCalls += 1;
      },
      supersedeProposal: async () => {}
    });

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
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log1.id, "Cheese");
  const log2 = await ctx.stores.questionLogs.record({
    question: "q2?",
    chatProvider: "codex",
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

describe("reconcileGaps audit", () => {
  it("records a completed maintenance run for the tick", async () => {
    const ctx = makeTestContext();
    await reconcileGaps(ctx, undefined);
    const runs = await ctx.stores.maintenanceRuns.list({ taskType: "process_gaps_to_pull_requests", limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].taskType, "process_gaps_to_pull_requests");
  });

  it("records a failed run and rethrows when the reconcile throws", async () => {
    const ctx = makeTestContext();
    // Force the inner reconcile to throw after the (empty) PR-state pass.
    ctx.stores.questionLogs.getGapCatalogRevision = async () => {
      throw new Error("reconcile exploded");
    };
    await assert.rejects(() => reconcileGaps(ctx, undefined), /reconcile exploded/);
    const runs = await ctx.stores.maintenanceRuns.list({ taskType: "process_gaps_to_pull_requests", limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "failed");
    assert.equal(runs[0].error, "reconcile exploded");
  });
});
