import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { MaintenancePlan } from "@magpie/core";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { FakeJobBroker } from "../../jobs/fake-broker.js";
import { makeTestContext } from "../../test-support/context.js";
import { completeJob, failJob } from "../jobs/service.js";
import { triggerSourceSyncRun } from "./service.js";

const execFileAsync = promisify(execFile);

interface Seeded {
  ctx: ReturnType<typeof makeTestContext>;
  checkoutRoot: string;
  cleanup: () => Promise<void>;
}

// Seeds: a destination git repo (the KB) indexed with one document, plus a source
// git repo with TWO commits so a diff is available. Configures the source so
// triggerSourceSyncRun gathers candidates and reaches the generative step. The
// destination doc path matches the candidate the plan will write to.
async function seed(broker: FakeJobBroker): Promise<Seeded> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-srcsync-test-"));
  const run = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });

  // Destination KB repo (indexed so a candidate document exists + a git checkout
  // for publication pre-flight).
  const destRemote = path.join(root, "dest.git");
  const destClone = path.join(root, "dest");
  await mkdir(destRemote, { recursive: true });
  await run(destRemote, ["init", "--bare", "--initial-branch=main"]);
  await execFileAsync("git", ["clone", destRemote, destClone]);
  await run(destClone, ["config", "user.name", "Seed"]);
  await run(destClone, ["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(destClone, "guide.md"), "# Guide\nThe limit is 2024.\n", "utf8");
  await run(destClone, ["add", "-A"]);
  await run(destClone, ["commit", "-m", "seed"]);
  await run(destClone, ["push", "-u", "origin", "main"]);

  // Source repo with two commits so diffChangedFiles returns a change.
  const sourceRemote = path.join(root, "source.git");
  const sourceClone = path.join(root, "source");
  await mkdir(sourceRemote, { recursive: true });
  await run(sourceRemote, ["init", "--bare", "--initial-branch=main"]);
  await execFileAsync("git", ["clone", sourceRemote, sourceClone]);
  await run(sourceClone, ["config", "user.name", "Seed"]);
  await run(sourceClone, ["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(sourceClone, "rules.ts"), "export const LIMIT = 2024;\n", "utf8");
  await run(sourceClone, ["add", "-A"]);
  await run(sourceClone, ["commit", "-m", "first"]);
  await writeFile(path.join(sourceClone, "rules.ts"), "export const LIMIT = 2025;\n", "utf8");
  await run(sourceClone, ["add", "-A"]);
  await run(sourceClone, ["commit", "-m", "bump"]);
  await run(sourceClone, ["push", "-u", "origin", "main"]);

  // The service derives its checkout root from MAGPIE_CHECKOUT_ROOT; pin it to this
  // test's temp dir so checkouts are isolated and cleaned up.
  const checkoutRoot = path.join(root, "checkouts");
  process.env.MAGPIE_CHECKOUT_ROOT = checkoutRoot;

  const ctx = makeTestContext({ jobs: broker });
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.sources = [
    { id: "src-1", name: "Rules repo", kind: "git", url: sourceRemote }
  ];

  await ctx.stores.knowledgeIndex.indexLocalRepository({
    localPath: destClone,
    repositoryId: "dest",
    name: "dest"
  });

  return {
    ctx,
    checkoutRoot,
    cleanup: async () => {
      delete process.env.MAGPIE_CHECKOUT_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  };
}

const PLAN: MaintenancePlan = {
  summary: "Update the limit",
  operations: [
    {
      kind: "rewrite",
      title: "rewrite guide.md",
      reason: "limit changed",
      sources: ["rules.ts"],
      writes: [{ path: "guide.md", content: "# Guide\nThe limit is 2025.\n" }],
      deletes: []
    }
  ],
  rationale: "source bumped the limit"
};

// Re-baselines the seeded source at its parent commit so the next triggerSourceSyncRun
// sees a one-commit diff to react to, and returns the source checkout path.
async function baselineAtParent(ctx: Seeded["ctx"], checkoutRoot: string): Promise<string> {
  await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
  const repoPath = path.join(checkoutRoot, "src-1");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath });
  await ctx.stores.sourceSync.setState(undefined, "src-1", stdout.trim());
  return repoPath;
}

test("triggerSourceSyncRun enqueues a running plan job and advances the baseline immediately", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    const repoPath = await baselineAtParent(ctx, checkoutRoot);

    const runs = await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    assert.equal(runs.length, 1);
    const run = runs[0];

    // Enqueue-only: the run is "running" and linked to a plan job; nothing blocked
    // on the model and no changeset is derived yet.
    assert.equal(run.status, "running");
    assert.ok(run.jobId, "run linked to a plan job");
    assert.equal(run.changeset, undefined);
    assert.equal(run.plan, undefined);

    // Exactly one plan job was enqueued, and it is the run's job.
    const planJob = (await ctx.jobs.list({})).jobs.find((job) => job.type === "sync_source_changes_generate_plan");
    assert.ok(planJob, "plan job enqueued");
    assert.equal(planJob.id, run.jobId);

    // The baseline advanced to HEAD at enqueue, so the next tick won't re-plan the
    // same commit while the job is in flight.
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    assert.equal((await ctx.stores.sourceSync.getState(undefined, "src-1"))?.lastSha, head.trim());

    // No publication yet — that waits on the plan job completing.
    assert.equal((await ctx.jobs.list({})).jobs.filter((job) => job.type === "publish_source_sync" as never).length, 0);
  } finally {
    await cleanup();
  }
});

test("completing the plan job creates a source-sync proposal and enqueues proposal publication", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const jobId = run.jobId;
    assert.ok(jobId, "run linked to a plan job");

    const outcome = await completeJob(ctx, jobId, PLAN);
    assert.equal(outcome.ok, true);

    const completed = await ctx.stores.sourceSync.getRun(run.id);
    assert.equal(completed?.status, "completed");
    assert.ok(completed?.plan, "plan persisted");
    assert.equal(completed?.changeset?.length, 1);
    assert.equal(completed?.changeset?.[0].path, "guide.md");
    assert.equal(completed?.changeset?.[0].content, "# Guide\nThe limit is 2025.\n");

    const proposals = await ctx.stores.proposals.list(20);
    const proposal = proposals.find((candidate) => candidate.jobId === jobId);
    assert.ok(proposal, "source-sync proposal created");
    assert.equal(proposal.flowId, undefined);
    assert.equal(proposal.destinationId, run.destinationId);
    assert.equal(proposal.targetPath, "guide.md");
    assert.equal(proposal.markdown, "# Guide\nThe limit is 2025.\n");
    assert.equal(proposal.changeset?.length, 1);
    assert.match(proposal.gapSummary ?? "", /Source sync:/);

    const publishProposal = (await ctx.jobs.list({})).jobs.find((job) => job.type === "publish_proposal");
    assert.ok(publishProposal, "proposal publication enqueued");
    assert.deepEqual(publishProposal.input, { proposalId: proposal.id });
    assert.equal((await ctx.jobs.list({})).jobs.some((job) => job.type === "publish_source_sync" as never), false);
  } finally {
    await cleanup();
  }
});

test("a plan job that exhausts its retries fails the linked run without rewinding the baseline", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    const repoPath = await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const jobId = run.jobId;
    assert.ok(jobId, "run linked to a plan job");
    assert.equal(run.status, "running");

    // Fail the plan job until pg-boss would give up (retryLimit retries, then a
    // terminal failure). Only the terminal failure fails the run.
    const jobError = { code: "runner_failed", message: "model unavailable", category: "external" as const, executor: "watcher" };
    let failed = await failJob(ctx, jobId, jobError);
    while (failed?.state !== "failed") {
      failed = await failJob(ctx, jobId, jobError);
    }

    const failedRun = await ctx.stores.sourceSync.getRun(run.id);
    assert.equal(failedRun?.status, "failed");
    assert.equal(failedRun?.error, "model unavailable");

    // The baseline stays at HEAD (advanced at enqueue): a failed run is operator-
    // visible and not auto-replanned, mirroring crunch.
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    assert.equal((await ctx.stores.sourceSync.getState(undefined, "src-1"))?.lastSha, head.trim());

    // No publication for a failed run.
    assert.equal((await ctx.jobs.list({})).jobs.filter((job) => job.type === "publish_source_sync" as never).length, 0);
  } finally {
    await cleanup();
  }
});


test("a source-sync change that overlaps a touchable open PR enqueues a fold", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const jobId = run.jobId!;

    await ctx.stores.proposals.create({
      title: "Guide", targetPath: "guide.md", markdown: "# Guide", rationale: "r",
      evidence: [], triggeringQuestionIds: []
    });

    const outcome = await completeJob(ctx, jobId, PLAN);
    assert.equal(outcome.ok, true);

    const proposal = (await ctx.stores.proposals.list(20)).find((candidate) => candidate.jobId === jobId);
    assert.ok(proposal, "source-sync proposal created");
    const foldJob = (await ctx.jobs.list({})).jobs.find((job) => job.type === "fold_changeset_proposal");
    assert.ok(foldJob, "source-sync proposal folded into touchable overlap");
    assert.equal((await ctx.jobs.list({})).jobs.some((job) => job.type === "publish_source_sync" as never), false);
  } finally {
    await cleanup();
  }
});

test("a source-sync change that overlaps an approved PR self-publishes as a proposal", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const jobId = run.jobId!;

    const existing = await ctx.stores.proposals.create({
      title: "Guide", targetPath: "guide.md", markdown: "# Guide", rationale: "r",
      evidence: [], triggeringQuestionIds: []
    });
    await ctx.stores.proposals.updateReviewDecision(existing.id, "approved");

    const outcome = await completeJob(ctx, jobId, PLAN);
    assert.equal(outcome.ok, true);

    const proposal = (await ctx.stores.proposals.list(20)).find((candidate) => candidate.jobId === jobId);
    assert.ok(proposal, "source-sync proposal created");
    const publish = (await ctx.jobs.list({})).jobs.find((job) => job.type === "publish_proposal");
    assert.ok(publish, "approved overlap self-publishes as proposal");
    assert.deepEqual(publish.input, { proposalId: proposal.id });
  } finally {
    await cleanup();
  }
});


