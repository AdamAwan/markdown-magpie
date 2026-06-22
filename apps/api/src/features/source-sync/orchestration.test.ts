import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CrunchPlan } from "@magpie/core";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { FakeJobBroker } from "../../jobs/fake-broker.js";
import { makeTestContext } from "../../test-support/context.js";
import { completeJob, failJob } from "../jobs/service.js";
import { getRunExecutionContext, triggerSourceSyncRun } from "./service.js";

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

const PLAN: CrunchPlan = {
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
    assert.equal((await ctx.jobs.list({})).jobs.filter((job) => job.type === "publish_source_sync").length, 0);
  } finally {
    await cleanup();
  }
});

test("completing the plan job constrains the changeset, completes the run, and enqueues publication", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const jobId = run.jobId;
    assert.ok(jobId, "run linked to a plan job");

    // Drive the watcher's completion through the real dispatcher.
    const outcome = await completeJob(ctx, jobId, PLAN);
    assert.equal(outcome.ok, true);

    const completed = await ctx.stores.sourceSync.getRun(run.id);
    assert.equal(completed?.status, "completed");
    assert.ok(completed?.plan, "plan persisted");
    assert.equal(completed?.changeset?.length, 1);
    assert.equal(completed?.changeset?.[0].path, "guide.md");
    assert.equal(completed?.changeset?.[0].content, "# Guide\nThe limit is 2025.\n");

    // A publish_source_sync job was enqueued for the now-completed run; no git ran in
    // the API and no publication is recorded yet — that happens in the watcher.
    const publish = (await ctx.jobs.list({})).jobs.find((job) => job.type === "publish_source_sync");
    assert.ok(publish, "publication enqueued");
    assert.deepEqual(publish.input, { runId: run.id });
    assert.equal(completed?.publication, undefined);
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
    assert.equal((await ctx.jobs.list({})).jobs.filter((job) => job.type === "publish_source_sync").length, 0);
  } finally {
    await cleanup();
  }
});

test("getRunExecutionContext returns the run, changeset, source name and repo for a completed run", async () => {
  const broker = new FakeJobBroker();
  const { ctx, cleanup } = await seed(broker);
  try {
    // Build a completed run with a changeset directly via the store, and point its
    // destination at the indexed git repo so the pre-flight accepts it. Reset the
    // index so the git clone is the sole repository the pre-flight can resolve.
    await ctx.stores.knowledgeIndex.reset();
    await indexGitDestination(ctx);
    const run = await ctx.stores.sourceSync.createRun({
      destinationId: "gitdest",
      sourceId: "src-1",
      trigger: "scheduled",
      status: "completed",
      plan: PLAN,
      changeset: [{ path: "guide.md", content: "x" }],
      toSha: "abc",
      changedFileCount: 1,
      candidateCount: 1
    });

    const outcome = await getRunExecutionContext(ctx, run.id);
    if (!outcome.ok) {
      throw new Error(`expected execution context, got ${outcome.code}`);
    }
    assert.equal(outcome.run.id, run.id);
    assert.equal(outcome.run.changeset?.length, 1);
    assert.equal(outcome.sourceName, "Rules repo");
    assert.equal(outcome.repository.id, "gitdest");
    assert.ok(outcome.repository.git, "git context exposed");

    const serialised = JSON.stringify(outcome.repository).toLowerCase();
    for (const secret of ["token", "password", "apikey", "authorization"]) {
      assert.equal(serialised.includes(secret), false, `repository config leaked "${secret}"`);
    }
  } finally {
    await cleanup();
  }
});

test("getRunExecutionContext returns source_sync_run_not_found for an unknown id", async () => {
  const broker = new FakeJobBroker();
  const { ctx, cleanup } = await seed(broker);
  try {
    const outcome = await getRunExecutionContext(ctx, "missing");
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error("unreachable");
    assert.equal(outcome.code, "source_sync_run_not_found");
  } finally {
    await cleanup();
  }
});

test("getRunExecutionContext returns a 409 when the run has no changeset", async () => {
  const broker = new FakeJobBroker();
  const { ctx, cleanup } = await seed(broker);
  try {
    const run = await ctx.stores.sourceSync.createRun({
      destinationId: "dest",
      sourceId: "src-1",
      trigger: "scheduled",
      status: "skipped",
      toSha: "abc",
      changedFileCount: 1,
      candidateCount: 0
    });
    const outcome = await getRunExecutionContext(ctx, run.id);
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error("unreachable");
    assert.equal(outcome.status, 409);
    assert.equal(outcome.code, "source_sync_run_not_publishable");
  } finally {
    await cleanup();
  }
});

// Indexes a real git clone as the "gitdest" destination so findRepositoryForDestination
// resolves a git-backed RepositoryRef the publish pre-flight accepts.
async function indexGitDestination(ctx: ReturnType<typeof makeTestContext>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-srcsync-gitdest-"));
  const remote = path.join(root, "remote.git");
  const clone = path.join(root, "clone");
  const run = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });
  await mkdir(remote, { recursive: true });
  await run(remote, ["init", "--bare", "--initial-branch=main"]);
  await execFileAsync("git", ["clone", remote, clone]);
  await run(clone, ["config", "user.name", "Seed"]);
  await run(clone, ["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(clone, "guide.md"), "# Guide\n", "utf8");
  await run(clone, ["add", "-A"]);
  await run(clone, ["commit", "-m", "seed"]);
  await run(clone, ["push", "-u", "origin", "main"]);
  await run(clone, ["fetch", "origin"]);
  await ctx.stores.knowledgeIndex.indexLocalRepository({ localPath: clone, repositoryId: "gitdest", name: "gitdest" });
}
