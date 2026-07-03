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

  // The service reads its checkout root from the resolved knowledge config; pin
  // it to this test's temp dir so checkouts are isolated and cleaned up.
  const checkoutRoot = path.join(root, "checkouts");

  const ctx = makeTestContext({ jobs: broker });
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.checkoutRoot = checkoutRoot;
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
    assert.deepEqual(publishProposal.input, { proposalId: proposal.id, destination: "github" });
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
    assert.deepEqual(publish.input, { proposalId: proposal.id, destination: "github" });
  } finally {
    await cleanup();
  }
});

// Seeds a destination KB (so a candidate exists) and a source whose SECOND commit
// touches `bulkFileCount` source files, so a single tick produces a commit that
// exceeds a low changed-file cap. The KB doc path matches a candidate the plan
// writes to. Re-baselines so the next triggerSourceSyncRun reacts to the bulk commit.
async function seedLargeCommit(broker: FakeJobBroker, bulkFileCount: number): Promise<Seeded & { repoPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-srcsync-bulk-"));
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
  // First commit: a single rules file (the baseline state).
  await writeFile(path.join(sourceClone, "rules.ts"), "export const LIMIT = 2024;\n", "utf8");
  await run(sourceClone, ["add", "-A"]);
  await run(sourceClone, ["commit", "-m", "first"]);
  // Second commit: change rules.ts AND add many files, so the diff exceeds the cap.
  await writeFile(path.join(sourceClone, "rules.ts"), "export const LIMIT = 2025;\n", "utf8");
  for (let i = 0; i < bulkFileCount; i += 1) {
    // Include the keyword the KB guide describes so retrieval still finds the
    // candidate from the capped subset (the first N files, in name-status order).
    await writeFile(
      path.join(sourceClone, `bulk-${String(i).padStart(4, "0")}.ts`),
      `// the limit guide value ${i}\nexport const X${i} = ${i};\n`,
      "utf8"
    );
  }
  await run(sourceClone, ["add", "-A"]);
  await run(sourceClone, ["commit", "-m", "bulk"]);
  await run(sourceClone, ["push", "-u", "origin", "main"]);

  const checkoutRoot = path.join(root, "checkouts");
  const ctx = makeTestContext({ jobs: broker });
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.checkoutRoot = checkoutRoot;
  ctx.knowledgeConfig.sources = [{ id: "src-1", name: "Rules repo", kind: "git", url: sourceRemote }];
  await ctx.stores.knowledgeIndex.indexLocalRepository({ localPath: destClone, repositoryId: "dest", name: "dest" });

  // Baseline at the parent so the next tick diffs the bulk commit.
  await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
  const repoPath = path.join(checkoutRoot, "src-1");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath });
  await ctx.stores.sourceSync.setState(undefined, "src-1", stdout.trim());

  return { ctx, checkoutRoot, repoPath, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

test("a commit exceeding SOURCE_SYNC_MAX_CHANGED_FILES caps the job input but records the true total and advances the baseline", async () => {
  const broker = new FakeJobBroker();
  const previousCap = process.env.SOURCE_SYNC_MAX_CHANGED_FILES;
  process.env.SOURCE_SYNC_MAX_CHANGED_FILES = "5";
  // 1 changed rules.ts + 20 new bulk files = 21 changed files, well over the cap of 5.
  const bulkFileCount = 20;
  const { ctx, repoPath, cleanup } = await seedLargeCommit(broker, bulkFileCount);
  try {
    const runs = await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    assert.equal(runs.length, 1);
    const run = runs[0];

    // The run records the TRUE total changed-file count, not the capped subset.
    assert.equal(run.changedFileCount, bulkFileCount + 1, "run records the true total changed files");

    // Only the first N files were materialized into the plan job input...
    const planJob = (await ctx.jobs.list({})).jobs.find((job) => job.type === "sync_source_changes_generate_plan");
    assert.ok(planJob, "plan job enqueued");
    const input = planJob.input as { changes: unknown[]; totalChangedFileCount?: number; changedFilesTruncated?: boolean };
    assert.equal(input.changes.length, 5, "only the cap's worth of files go downstream");
    // ...and the truncation is made visible on the job input.
    assert.equal(input.totalChangedFileCount, bulkFileCount + 1, "job input carries the true total");
    assert.equal(input.changedFilesTruncated, true, "job input flags the truncation");

    // The baseline still advanced to HEAD (no reprocessing loop).
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    assert.equal((await ctx.stores.sourceSync.getState(undefined, "src-1"))?.lastSha, head.trim());
  } finally {
    if (previousCap === undefined) {
      delete process.env.SOURCE_SYNC_MAX_CHANGED_FILES;
    } else {
      process.env.SOURCE_SYNC_MAX_CHANGED_FILES = previousCap;
    }
    await cleanup();
  }
});

test("a commit under SOURCE_SYNC_MAX_CHANGED_FILES is not truncated", async () => {
  const broker = new FakeJobBroker();
  const previousCap = process.env.SOURCE_SYNC_MAX_CHANGED_FILES;
  process.env.SOURCE_SYNC_MAX_CHANGED_FILES = "100";
  // 1 changed rules.ts + 3 new bulk files = 4 changed files, under the cap of 100.
  const { ctx, cleanup } = await seedLargeCommit(broker, 3);
  try {
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    assert.equal(run.changedFileCount, 4);
    const planJob = (await ctx.jobs.list({})).jobs.find((job) => job.type === "sync_source_changes_generate_plan");
    assert.ok(planJob, "plan job enqueued");
    const input = planJob.input as { changes: unknown[]; totalChangedFileCount?: number; changedFilesTruncated?: boolean };
    assert.equal(input.changes.length, 4, "all changed files go downstream when under the cap");
    assert.equal(input.changedFilesTruncated, false, "no truncation flagged");
    assert.equal(input.totalChangedFileCount, 4);
  } finally {
    if (previousCap === undefined) {
      delete process.env.SOURCE_SYNC_MAX_CHANGED_FILES;
    } else {
      process.env.SOURCE_SYNC_MAX_CHANGED_FILES = previousCap;
    }
    await cleanup();
  }
});

// A single NUL byte (0x00), built via char code so this source file stays plain ASCII.
const NUL = String.fromCharCode(0);

// Seeds a KB (so a candidate exists) and a source whose watched file is large enough
// (> 8 KB of clean text, past git's binary-detection window) that a NUL byte in its
// final, changed line lands in a *text* diff rather than being suppressed as "Binary
// files differ". That NUL, unsanitized, poisons the JSONB plan-job input — see #131.
// Re-baselines so the next triggerSourceSyncRun reacts to the NUL-bearing commit.
async function seedNulCommit(broker: FakeJobBroker): Promise<Seeded & { repoPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-srcsync-nul-"));
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
  // ~900 clean lines (> 8 KB) so git's binary heuristic (first 8 KB) sees no NUL, then a
  // trailing line whose NUL byte therefore survives into a text diff when it changes.
  const filler = Array.from({ length: 900 }, (_, i) => `line ${String(i).padStart(4, "0")} the limit`).join("\n");
  await writeFile(path.join(sourceClone, "rules.ts"), `${filler}\nlimit marker${NUL}OLD\n`, "utf8");
  await run(sourceClone, ["add", "-A"]);
  await run(sourceClone, ["commit", "-m", "first"]);
  await writeFile(path.join(sourceClone, "rules.ts"), `${filler}\nlimit marker${NUL}NEW\n`, "utf8");
  await run(sourceClone, ["add", "-A"]);
  await run(sourceClone, ["commit", "-m", "bump"]);
  await run(sourceClone, ["push", "-u", "origin", "main"]);

  const checkoutRoot = path.join(root, "checkouts");
  const ctx = makeTestContext({ jobs: broker });
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.checkoutRoot = checkoutRoot;
  ctx.knowledgeConfig.sources = [{ id: "src-1", name: "Rules repo", kind: "git", url: sourceRemote }];
  await ctx.stores.knowledgeIndex.indexLocalRepository({ localPath: destClone, repositoryId: "dest", name: "dest" });

  await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
  const repoPath = path.join(checkoutRoot, "src-1");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath });
  await ctx.stores.sourceSync.setState(undefined, "src-1", stdout.trim());

  return { ctx, checkoutRoot, repoPath, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

test("a changed file whose diff contains a NUL byte is sanitized so the JSONB job input is safe and the baseline advances", async () => {
  const broker = new FakeJobBroker();
  const { ctx, repoPath, cleanup } = await seedNulCommit(broker);
  try {
    // Sanity-check the fixture: the raw git diff really does carry a NUL byte, so this
    // test would fail without sanitization (and proves the scenario is real, not a
    // "binary files differ" no-op).
    const { stdout: rawDiff } = await execFileAsync("git", ["diff", "HEAD~1..HEAD", "--", "rules.ts"], { cwd: repoPath });
    assert.ok(rawDiff.includes(NUL), "fixture precondition: git emits a text diff containing a NUL byte");

    const runs = await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    assert.equal(runs.length, 1, "the poisoned commit still produces a run rather than throwing");
    const run = runs[0];
    assert.equal(run.status, "running");
    assert.ok(run.jobId, "run linked to a plan job");

    // The enqueued plan-job input — which Postgres would store as JSONB — carries no
    // NUL byte in any changed-file patch, so the INSERT that previously failed with
    // "unsupported Unicode escape sequence" now succeeds. (Assert on the raw field
    // value, not JSON.stringify(input): JSON serialization escapes a real 0x00 into an
    // ASCII escape sequence, which no longer contains a raw NUL and would mask the bug.)
    const planJob = (await ctx.jobs.list({})).jobs.find((job) => job.type === "sync_source_changes_generate_plan");
    assert.ok(planJob, "plan job enqueued");
    const input = planJob.input as { changes: Array<{ diff: string }> };
    assert.equal(
      input.changes.some((change) => change.diff.includes(NUL)),
      false,
      "no NUL byte survives in any changed-file patch in the job input"
    );

    // The baseline advanced to HEAD, so the next tick won't re-diff the poisoned commit
    // — the wedge is broken.
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    assert.equal((await ctx.stores.sourceSync.getState(undefined, "src-1"))?.lastSha, head.trim());
  } finally {
    await cleanup();
  }
});


