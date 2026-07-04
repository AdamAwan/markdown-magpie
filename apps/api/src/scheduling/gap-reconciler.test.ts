import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobType, JobView } from "@magpie/jobs";
import { reconcileGapClustersOutputSchema } from "@magpie/jobs";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import { RuntimeConfigHolder } from "../config-holder.js";
import { FakeJobBroker } from "../jobs/fake-broker.js";
import { makeTestContext } from "../test-support/context.js";
import type { GapClusterMembershipRecord, GapClusterRecord } from "../stores/gap-cluster-store.js";
import { reconcileGaps, reshapeCompositionHash } from "./gap-reconciler.js";

function cluster(id: string): GapClusterRecord {
  return { id, title: id, status: "active", reconciliationRevision: 1, createdAt: "t", updatedAt: "t" };
}
function membership(clusterId: string, gapId: string): GapClusterMembershipRecord {
  return { id: `${clusterId}-${gapId}`, clusterId, gapId, active: true, createdAt: "t" };
}

describe("reshapeCompositionHash", () => {
  it("is independent of cluster and membership ordering", () => {
    const a = reshapeCompositionHash(
      [cluster("1"), cluster("2")],
      [membership("1", "10"), membership("1", "11"), membership("2", "20")]
    );
    const b = reshapeCompositionHash(
      [cluster("2"), cluster("1")],
      [membership("2", "20"), membership("1", "11"), membership("1", "10")]
    );
    assert.equal(a, b, "same clusters holding the same gaps hash equal regardless of order");
  });

  it("changes when a cluster gains, loses, or moves a gap", () => {
    const base = reshapeCompositionHash([cluster("1"), cluster("2")], [membership("1", "10"), membership("2", "20")]);
    const gained = reshapeCompositionHash(
      [cluster("1"), cluster("2")],
      [membership("1", "10"), membership("1", "11"), membership("2", "20")]
    );
    const moved = reshapeCompositionHash([cluster("1"), cluster("2")], [membership("2", "10"), membership("2", "20")]);
    const droppedCluster = reshapeCompositionHash([cluster("1")], [membership("1", "10")]);
    assert.notEqual(base, gained, "adding a gap changes the hash");
    assert.notEqual(base, moved, "moving a gap to another cluster changes the hash");
    assert.notEqual(base, droppedCluster, "removing a cluster changes the hash");
  });
});

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

    // The plain broker never completes the reshape job, so the bounded-wait falls
    // back and the reconciler skips reshape — the single new cluster stands.
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
      return { merges: [{ clusterIds, rationale: "x", confirmed: false }], splits: [], dismissals: [] };
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
      return { merges: [{ clusterIds, rationale: "x", confirmed: true }], splits: [], dismissals: [] };
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
    // could. We drive a tiny deadline via the runtime config.
    const ctx = makeTestContext({
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    ctx.settings.jobs.runToCompletionTimeoutMs = 20;
    await seedTwoClustersWithGaps(ctx);

    const before = await ctx.stores.gapClusters.listActiveClusters();
    await reconcileGaps(ctx, undefined, { fetchPullRequestStatus: async () => undefined });
    const after = await ctx.stores.gapClusters.listActiveClusters();

    assert.equal((await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length, 1, "the reshape job was enqueued");
    assert.equal(after.length, before.length, "no reshape applied on timeout");
    assert.deepEqual(await ctx.stores.reconciliations.list(50), [], "no decision recorded when the job never ran");
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

describe("reconcileGaps reshape composition short-circuit (#168)", () => {
  const deps = {
    fetchPullRequestStatus: async () => undefined,
    publishProposal: async () => {},
    supersedeProposal: async () => {}
  };

  it("skips the reshape when the active cluster composition is unchanged since the last reshape", async () => {
    const jobs = new ReshapingJobBroker(() => ({ merges: [], splits: [], dismissals: [] }));
    const ctx = makeTestContext({ jobs, config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" }) });
    await seedTwoClustersWithGaps(ctx);

    await reconcileGaps(ctx, undefined, deps);
    assert.equal(
      (await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length,
      1,
      "the first tick judges the composition"
    );
    assert.ok(
      await ctx.stores.gapClusters.getReshapeCompositionHash(undefined),
      "a completed reshape records the composition it judged"
    );

    // A later revision bump that left the active cluster set identical: reopen the
    // reconcile gate by rewinding the processed revision while the clusters and
    // their memberships stay exactly as the last reshape judged them.
    await ctx.stores.gapClusters.setProcessedRevision(undefined, 0, new Date().toISOString());
    await reconcileGaps(ctx, undefined, deps);

    assert.equal(
      (await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length,
      1,
      "the second tick skipped the reshape — the composition was byte-identical"
    );
  });

  it("re-runs the reshape when the composition genuinely changes", async () => {
    const jobs = new ReshapingJobBroker(() => ({ merges: [], splits: [], dismissals: [] }));
    const ctx = makeTestContext({ jobs, config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" }) });
    await seedTwoClustersWithGaps(ctx);

    await reconcileGaps(ctx, undefined, deps);
    assert.equal((await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length, 1);

    // A brand-new gap forms a third cluster, so the composition — and its hash —
    // changes; the reshape must run again to judge the new set.
    const log = await ctx.stores.questionLogs.record({ question: "q3?", chatProvider: "codex", retrievedSectionIds: [] });
    await ctx.stores.questionLogs.recordManualGap(log.id, "Dogs");
    await reconcileGaps(ctx, undefined, deps);

    assert.equal(
      (await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length,
      2,
      "a changed composition re-runs the reshape"
    );
  });

  it("does not record the composition hash when the reshape fails, so the next tick retries", async () => {
    // A plain FakeJobBroker never completes the reshape job, so the bounded wait
    // times out and requestReshape returns undefined. A failed reshape must NOT
    // record the hash, or the gate would wedge on an unjudged composition.
    const ctx = makeTestContext({ config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" }) });
    ctx.settings.jobs.runToCompletionTimeoutMs = 20;
    await seedTwoClustersWithGaps(ctx);

    await reconcileGaps(ctx, undefined, deps);
    assert.equal((await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length, 1);
    assert.equal(
      await ctx.stores.gapClusters.getReshapeCompositionHash(undefined),
      undefined,
      "a failed reshape records no composition hash"
    );

    // Reopen the gate on an unchanged composition; because no hash was recorded the
    // reshape is retried rather than skipped.
    await ctx.stores.gapClusters.setProcessedRevision(undefined, 0, new Date().toISOString());
    await reconcileGaps(ctx, undefined, deps);
    assert.equal(
      (await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length,
      2,
      "the reshape retried because the failed run recorded no hash"
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

    // The plain broker never completes the reshape job, so the scope check is
    // skipped and the on-topic single cluster proceeds to drafting.
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

  it("dismisses an off-topic single cluster and drafts nothing when the critic confirms", async () => {
    const jobs = new ReshapingJobBroker((input) => {
      const clusterIds = (input as { clusters: Array<{ id: string }> }).clusters.map((c) => c.id);
      return {
        merges: [],
        splits: [],
        dismissals: clusterIds.map((clusterId) => ({
          clusterId,
          rationale: "unrelated to this knowledge base",
          confirmed: true
        }))
      };
    });
    const ctx = makeTestContext({
      jobs,
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    const log = await ctx.stores.questionLogs.record({
      question: "Do cats purr?",
      chatProvider: "openai-compatible",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "Cats");

    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    });

    assert.equal(
      (await ctx.stores.gapClusters.listActiveClusters()).length,
      0,
      "the off-topic cluster was dismissed and left the active set"
    );
    assert.equal(
      (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs.length,
      0,
      "no proposal is drafted for an off-topic cluster"
    );
    assert.equal(
      (await ctx.stores.questionLogs.listGapCandidates(50)).length,
      0,
      "the dismissed gap no longer surfaces as a candidate, so it never re-clusters"
    );

    const dismissal = (await ctx.stores.reconciliations.list(50)).find((d) => d.kind === "dismiss");
    assert.ok(dismissal, "the dismissal was recorded as a decision");
    assert.equal(dismissal.confirmed, true);
    assert.equal(dismissal.applied, true);
  });

  it("keeps an off-topic cluster when the critic rejects the dismissal", async () => {
    const jobs = new ReshapingJobBroker((input) => {
      const clusterIds = (input as { clusters: Array<{ id: string }> }).clusters.map((c) => c.id);
      return {
        merges: [],
        splits: [],
        dismissals: clusterIds.map((clusterId) => ({ clusterId, rationale: "maybe off-topic", confirmed: false }))
      };
    });
    const ctx = makeTestContext({
      jobs,
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    const log = await ctx.stores.questionLogs.record({
      question: "Do cats purr?",
      chatProvider: "openai-compatible",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "Cats");

    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    });

    assert.equal(
      (await ctx.stores.gapClusters.listActiveClusters()).length,
      1,
      "a rejected dismissal leaves the cluster active"
    );
    const dismissal = (await ctx.stores.reconciliations.list(50)).find((d) => d.kind === "dismiss");
    assert.ok(dismissal, "the rejected dismissal is still recorded for audit");
    assert.equal(dismissal.applied, false, "a rejected dismissal is not applied");
  });

  it("enqueues only the uncovered cluster on a later run, never duplicating", async () => {
    const jobs = new ReshapingJobBroker(() => ({ merges: [], splits: [], dismissals: [] }));
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

describe("reconcileGaps in-flight draft coverage", () => {
  // Drafting is enqueue-only: the proposal row lands only when the
  // draft_markdown_proposal job completes. Between enqueue and completion no
  // proposal exists, so two overlapping reconciles (issue #167) — or a draft that
  // outlives its 10-minute tick — would each see the cluster "uncovered" and
  // enqueue a second full draft generation for the same cluster. Treating a
  // queued/active draft job as covering its cluster closes that window.
  async function seedOneClusterWithOpenGap(ctx: AppContext): Promise<string> {
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure X?",
      chatProvider: "openai-compatible",
      retrievedSectionIds: []
    });
    // Recording the gap advances the catalog past the processed revision, so the
    // reconcile gate opens and drafting is reached.
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
    const cluster = await ctx.stores.gapClusters.createCluster({ title: "How to configure X", revision: 1 });
    const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary("How to configure X");
    await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);
    return cluster.id;
  }

  const draftInputFor = (clusterId: string) => ({
    provider: "openai-compatible" as const,
    gapSummaries: ["How to configure X"],
    triggeringQuestions: [],
    evidence: [],
    destinationId: "dest",
    expectedOutput: "markdown_proposal" as const,
    gapClusterId: clusterId
  });

  it("does not draft when a queued draft job already covers the cluster", async () => {
    const ctx = makeTestContext({ config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" }) });
    const clusterId = await seedOneClusterWithOpenGap(ctx);
    // A draft is already enqueued for this cluster but not yet completed, so no
    // proposal row exists — exactly the window issue #167 doubles in.
    await ctx.jobs.create("draft_markdown_proposal", draftInputFor(clusterId));

    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    });

    const drafts = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(drafts.length, 1, "the in-flight draft covers the cluster; reconcile enqueued no duplicate");
  });

  it("still drafts the same cluster when its only draft job has already completed", async () => {
    // Control for the case above: a completed (terminal) draft no longer covers the
    // cluster on its own — coverage then comes from the proposal row the completion
    // creates. With neither present, the cluster is genuinely uncovered and drafts.
    const ctx = makeTestContext({ config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" }) });
    const clusterId = await seedOneClusterWithOpenGap(ctx);
    const job = await ctx.jobs.create("draft_markdown_proposal", draftInputFor(clusterId));
    await ctx.jobs.complete(job.id, { title: "t", targetPath: "t.md", markdown: "#", rationale: "r" });

    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    });

    const drafts = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(drafts.length, 2, "a terminal draft does not cover the cluster; the uncovered cluster drafts");
  });
});

describe("reconcileGaps resolution pruning", () => {
  // A reshape can move a gap into a cluster other than the one whose proposal
  // later resolves it (resolution matches on (question, summary); freezing only
  // touches the resolving proposal's own cluster). The reconciler must drop the
  // resolved gap from whatever active cluster currently holds it, so a covered
  // gap stops surfacing as a live member/proposal.
  it("deactivates the membership of a gap resolved by another proposal", async () => {
    const ctx = makeTestContext({
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    const summaries = ["Power BI comparison", "Metabase comparison", "Tableau comparison"];
    const gapIdBySummary = new Map<string, string>();
    const logIdBySummary = new Map<string, string>();
    const cluster = await ctx.stores.gapClusters.createCluster({ title: "Comparisons", revision: 1 });
    for (const summary of summaries) {
      const log = await ctx.stores.questionLogs.record({
        question: `${summary}?`,
        chatProvider: "openai-compatible",
        retrievedSectionIds: []
      });
      await ctx.stores.questionLogs.recordManualGap(log.id, summary);
      const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary(summary);
      gapIdBySummary.set(summary, gapId);
      logIdBySummary.set(summary, log.id);
      await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);
    }

    // A different proposal merged and resolved the Metabase gap.
    await ctx.stores.questionLogs.resolveGaps(
      [logIdBySummary.get("Metabase comparison") as string],
      ["Metabase comparison"],
      "other-proposal"
    );

    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    });

    const members = await ctx.stores.gapClusters.listMembershipsForCluster(cluster.id);
    const memberGapIds = members.map((m) => m.gapId);
    assert.ok(
      !memberGapIds.includes(gapIdBySummary.get("Metabase comparison") as string),
      "the resolved gap is no longer an active member of the cluster"
    );
    assert.deepEqual(
      [...memberGapIds].sort(),
      [gapIdBySummary.get("Power BI comparison"), gapIdBySummary.get("Tableau comparison")].sort(),
      "only the still-open gaps remain active members"
    );
  });

  it("freezes a cluster whose every gap is resolved and never re-drafts it", async () => {
    const ctx = makeTestContext({
      config: new RuntimeConfigHolder({ aiProvider: "openai-compatible" })
    });
    const log = await ctx.stores.questionLogs.record({
      question: "How does X work?",
      chatProvider: "openai-compatible",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How X works");
    const cluster = await ctx.stores.gapClusters.createCluster({ title: "How X works", revision: 1 });
    const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary("How X works");
    await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);

    // The only gap in the cluster is resolved by a merged proposal.
    await ctx.stores.questionLogs.resolveGaps([log.id], ["How X works"], "some-proposal");

    await reconcileGaps(ctx, undefined, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => {},
      supersedeProposal: async () => {}
    });

    const after = await ctx.stores.gapClusters.getCluster(cluster.id);
    assert.equal(after?.status, "frozen", "a fully-resolved cluster is frozen");
    assert.equal(
      (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs.length,
      0,
      "no proposal is drafted for a fully-resolved cluster"
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
    assert.deepEqual(runs[0].details, {
      catalogRevision: 0,
      processedRevision: 0,
      pendingPublicationActions: 0,
      pullRequestsChecked: 0,
      pullRequestTransitions: 0,
      overlapsDetected: 0,
      clustersCreated: 0,
      mergeDecisions: 0,
      splitDecisions: 0,
      dismissDecisions: 0,
      decisionsApplied: 0,
      proposalsDrafted: 0,
      publicationActionsDrained: 0,
      skippedModelWork: true,
      reshapeSkipped: false
    });
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
