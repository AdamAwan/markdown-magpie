import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
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

async function seed(broker: FakeJobBroker): Promise<Seeded> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-srcsync-test-"));
  const run = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });

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

async function baselineAtParent(ctx: Seeded["ctx"], checkoutRoot: string): Promise<string> {
  await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
  const repoPath = path.join(checkoutRoot, "src-1");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath });
  await ctx.stores.sourceSync.setState(undefined, "src-1", stdout.trim());
  return repoPath;
}

test("triggerSourceSyncRun enqueues a plan job, advances baseline, and returns no completed ids before the plan finishes", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    const repoPath = await baselineAtParent(ctx, checkoutRoot);
    const result = await triggerSourceSyncRun(ctx, { trigger: "scheduled" });

    assert.deepEqual(result, { maintenanceRunIds: [], proposalIds: [] });
    const planJob = (await ctx.jobs.list({})).jobs.find((job) => job.type === "sync_source_changes_generate_plan");
    assert.ok(planJob, "plan job enqueued");

    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    assert.equal((await ctx.stores.sourceSync.getState(undefined, "src-1"))?.lastSha, head.trim());
    assert.equal((await ctx.jobs.list({ type: "publish_proposal" })).jobs.length, 0);
  } finally {
    await cleanup();
  }
});

test("completing a source-sync plan creates one changeset proposal and records a maintenance run", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    const planJob = (await ctx.jobs.list({ type: "sync_source_changes_generate_plan" })).jobs[0];

    const outcome = await completeJob(ctx, planJob.id, PLAN);
    assert.equal(outcome.ok, true);

    const proposals = await ctx.stores.proposals.list(10);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].title.startsWith("Source sync: Rules repo "), true);
    assert.equal(proposals[0].targetPath, "guide.md");
    assert.equal(proposals[0].changeset?.length, 1);
    assert.equal(proposals[0].flowId, undefined);

    const runs = await ctx.stores.maintenanceRuns.list({ taskType: "source_change_sync", limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "completed");
    assert.deepEqual((runs[0].details as { proposalIds?: string[] }).proposalIds, [proposals[0].id]);

    assert.equal((await ctx.jobs.list({ type: "publish_proposal" })).jobs.length, 1);
  } finally {
    await cleanup();
  }
});

test("source-sync proposal overlapping a touchable PR folds through fold_changeset_proposal", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    await ctx.stores.proposals.create({
      title: "Guide",
      targetPath: "guide.md",
      markdown: "# Guide",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });
    const planJob = (await ctx.jobs.list({ type: "sync_source_changes_generate_plan" })).jobs[0];

    const outcome = await completeJob(ctx, planJob.id, PLAN);
    assert.equal(outcome.ok, true);

    assert.equal((await ctx.jobs.list({ type: "fold_changeset_proposal" })).jobs.length, 1);
    assert.equal((await ctx.jobs.list({ type: "publish_proposal" })).jobs.length, 0);
  } finally {
    await cleanup();
  }
});

test("a plan job that exhausts its retries records a failed maintenance run without rewinding the baseline", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    const repoPath = await baselineAtParent(ctx, checkoutRoot);
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    const planJob = (await ctx.jobs.list({ type: "sync_source_changes_generate_plan" })).jobs[0];

    const jobError = { code: "runner_failed", message: "model unavailable", category: "external" as const, executor: "watcher" };
    let failed = await failJob(ctx, planJob.id, jobError);
    while (failed?.state !== "failed") {
      failed = await failJob(ctx, planJob.id, jobError);
    }

    const runs = await ctx.stores.maintenanceRuns.list({ taskType: "source_change_sync", limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "failed");

    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    assert.equal((await ctx.stores.sourceSync.getState(undefined, "src-1"))?.lastSha, head.trim());
    assert.equal((await ctx.jobs.list({ type: "publish_proposal" })).jobs.length, 0);
  } finally {
    await cleanup();
  }
});
