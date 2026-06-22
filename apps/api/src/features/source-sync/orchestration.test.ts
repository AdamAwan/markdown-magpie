import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { JobType, JobView } from "@magpie/jobs";
import type { CrunchPlan } from "@magpie/core";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { FakeJobBroker } from "../../jobs/fake-broker.js";
import { makeTestContext } from "../../test-support/context.js";
import { getRunExecutionContext, triggerSourceSyncRun } from "./service.js";

const execFileAsync = promisify(execFile);

// A broker that immediately completes any sync_source_changes_generate_plan job
// with the plan the watcher's chat runner would have produced, so the API's
// enqueue+bounded-wait resolves to a terminal completed job in-process. Other
// job types behave like the FakeJobBroker (created, never completed).
class PlanningJobBroker extends FakeJobBroker {
  constructor(private readonly buildPlan: (input: unknown) => CrunchPlan) {
    super();
  }

  override async create(type: JobType, input: unknown): Promise<JobView> {
    const job = await super.create(type, input);
    if (type === "sync_source_changes_generate_plan") {
      return super.complete(job.id, this.buildPlan(job.input));
    }
    return job;
  }
}

// A broker that enqueues the plan job but never completes it, so the bounded-wait
// elapses and returns a non-terminal view (state still "created"). Used to drive
// the timeout/failure path. The deadline is forced tiny via the option.
class StallingPlanJobBroker extends FakeJobBroker {}

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
  ctx.config = new RuntimeConfigHolder({ aiExecutionMode: "queue", aiProvider: "openai-compatible" });
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

test("triggerSourceSyncRun enqueues the plan job, persists the constrained changeset, and enqueues publication", async () => {
  const broker = new PlanningJobBroker(() => PLAN);
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    // First call baselines at the source's current HEAD; force a re-baseline at the
    // parent so the second call has a diff to react to.
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    assert.ok((await ctx.stores.sourceSync.getState(undefined, "src-1"))?.lastSha, "source baselined");
    // Rewind baseline to the source's parent commit so the next run has a diff.
    const repoPath = path.join(checkoutRoot, "src-1");
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath });
    await ctx.stores.sourceSync.setState(undefined, "src-1", stdout.trim());

    const runs = await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.status, "completed");
    assert.ok(run.plan, "plan persisted");
    assert.ok(run.changeset, "changeset persisted");
    assert.equal(run.changeset!.length, 1);
    assert.equal(run.changeset![0].path, "guide.md");
    assert.equal(run.changeset![0].content, "# Guide\nThe limit is 2025.\n");

    // A publish_source_sync job was enqueued for the completed run.
    const { jobs } = await ctx.jobs.list({});
    const publish = jobs.find((job) => job.type === "publish_source_sync");
    assert.ok(publish, "publication enqueued");
    assert.deepEqual(publish.input, { runId: run.id });

    // No git ran in the API: the run is still "completed" with no publication
    // recorded — publication happens in the watcher off the enqueued job.
    assert.equal(run.status, "completed");
    assert.equal(run.publication, undefined);
  } finally {
    await cleanup();
  }
});

test("triggerSourceSyncRun records a failed run when the plan job does not complete", async () => {
  const broker = new StallingPlanJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    const repoPath = path.join(checkoutRoot, "src-1");
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath });
    await ctx.stores.sourceSync.setState(undefined, "src-1", stdout.trim());

    // Tiny deadline so the bounded-wait elapses immediately on the never-completed
    // job, exercising the failure path.
    process.env.JOB_RUN_TO_COMPLETION_TIMEOUT_MS = "50";
    process.env.JOB_WAIT_POLL_MS = "10";
    try {
      const runs = await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, "failed");
      assert.ok(runs[0].error, "failure reason recorded");
    } finally {
      delete process.env.JOB_RUN_TO_COMPLETION_TIMEOUT_MS;
      delete process.env.JOB_WAIT_POLL_MS;
    }

    // The baseline is unchanged so a retry will re-attempt: state still at parent.
    const state = await ctx.stores.sourceSync.getState(undefined, "src-1");
    const { stdout: parent } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath });
    assert.equal(state?.lastSha, parent.trim(), "baseline left unchanged for retry");

    // No publication was enqueued for a failed run.
    const { jobs } = await ctx.jobs.list({});
    assert.equal(jobs.filter((job) => job.type === "publish_source_sync").length, 0);
  } finally {
    await cleanup();
  }
});

test("getRunExecutionContext returns the run, changeset, source name and repo for a completed run", async () => {
  const broker = new PlanningJobBroker(() => PLAN);
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
