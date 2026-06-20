import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CrunchPlan } from "@magpie/core";
import { jobDefinition } from "@magpie/jobs";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { makeTestContext } from "../../test-support/context.js";
import { changesetFromPlan, getRunExecutionContext, publishRun, triggerCrunchRun } from "./service.js";

const execFileAsync = promisify(execFile);

// Seeds a git checkout with one commit and an origin remote, then indexes it so
// findRepositoryForDestination resolves a git-backed RepositoryRef (scope !=
// not-git, with a workTreeRoot) — the precondition the publish path validates.
async function seedGitRepository(ctx: ReturnType<typeof makeTestContext>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-crunch-test-"));
  const remotePath = path.join(root, "remote.git");
  const clonePath = path.join(root, "clone");
  await mkdir(remotePath, { recursive: true });
  const run = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });
  await run(remotePath, ["init", "--bare", "--initial-branch=main"]);
  await execFileAsync("git", ["clone", remotePath, clonePath]);
  await run(clonePath, ["config", "user.name", "Seed"]);
  await run(clonePath, ["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(clonePath, "README.md"), "# seed\n", "utf8");
  await run(clonePath, ["add", "-A"]);
  await run(clonePath, ["commit", "-m", "seed"]);
  await run(clonePath, ["push", "-u", "origin", "main"]);
  await run(clonePath, ["fetch", "origin"]);
  await ctx.stores.knowledgeIndex.indexLocalRepository({ localPath: clonePath, repositoryId: "test-repo", name: "test-repo" });
}

async function seedCompletedRun(ctx: ReturnType<typeof makeTestContext>): Promise<string> {
  const plan: CrunchPlan = {
    summary: "tidy",
    operations: [
      {
        kind: "rewrite",
        title: "rewrite a.md",
        reason: "r",
        sources: ["a.md"],
        writes: [{ path: "a.md", content: "# A\nrewritten" }],
        deletes: []
      }
    ],
    rationale: "r"
  };
  const run = await ctx.stores.crunchRuns.createRun({
    destinationId: "test-repo",
    trigger: "manual",
    documentCount: 1,
    status: "running"
  });
  await ctx.stores.crunchRuns.completeRun(run.id, plan);
  return run.id;
}

test("triggerCrunchRun always enqueues a catalog-valid crunch_knowledge_base job with the run linked", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiExecutionMode: "queue", aiProvider: "openai-compatible" });

  const run = await triggerCrunchRun(ctx, { trigger: "manual" });

  // Planning is off the request thread, so the run starts "running" with no plan,
  // linked to the enqueued job. The watcher completes it later.
  assert.equal(run.status, "running");
  assert.equal(run.plan, undefined);
  assert.equal(run.trigger, "manual");
  assert.ok(run.jobId, "the run is linked to its planning job");

  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.type, "crunch_knowledge_base");
  assert.equal(job.id, run.jobId);
  assert.equal(job.state, "created");

  const parsed = jobDefinition("crunch_knowledge_base").inputSchema.safeParse(job.input);
  assert.ok(parsed.success, "enqueued input should match the crunch_knowledge_base contract");
});

test("triggerCrunchRun passes the configured provider through unchanged", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiExecutionMode: "queue", aiProvider: "codex" });

  const run = await triggerCrunchRun(ctx, { trigger: "manual" });
  const { jobs } = await ctx.jobs.list({});
  const job = jobs.find((candidate) => candidate.id === run.jobId);
  assert.ok(job);
  const input = job.input as { provider: string };
  assert.equal(input.provider, "codex");
});

test("publishRun enqueues a publish_crunch job after validation passes", async () => {
  const ctx = makeTestContext();
  await seedGitRepository(ctx);
  const runId = await seedCompletedRun(ctx);

  const outcome = await publishRun(ctx, runId);
  if (!outcome.ok) {
    throw new Error(`expected publication to be enqueued, got ${outcome.code}`);
  }

  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.type, "publish_crunch");
  assert.equal(job.id, outcome.job.id);
  assert.equal(job.state, "created");
  assert.deepEqual(job.input, { runId });

  const parsed = jobDefinition("publish_crunch").inputSchema.safeParse(job.input);
  assert.ok(parsed.success, "enqueued input should match the publish_crunch contract");

  // No git execution happened in the API: the run is still completed, with no
  // publication recorded.
  const after = await ctx.stores.crunchRuns.getRun(runId);
  assert.equal(after?.status, "completed");
  assert.equal(after?.publication, undefined);
});

test("publishRun returns 404 without enqueuing for a missing run", async () => {
  const ctx = makeTestContext();
  const outcome = await publishRun(ctx, "missing");
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.status, 404);
  assert.equal(outcome.code, "crunch_run_not_found");
  assert.equal((await ctx.jobs.list({})).jobs.length, 0);
});

test("publishRun returns 409 without enqueuing for a run that is not completed", async () => {
  const ctx = makeTestContext();
  const run = await ctx.stores.crunchRuns.createRun({
    destinationId: "test-repo",
    trigger: "manual",
    documentCount: 0,
    status: "running"
  });

  const outcome = await publishRun(ctx, run.id);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.status, 409);
  assert.equal(outcome.code, "crunch_run_not_publishable");
  assert.equal((await ctx.jobs.list({})).jobs.length, 0);
});

test("publishRun returns 409 without enqueuing when no git repository matches", async () => {
  const ctx = makeTestContext();
  const runId = await seedCompletedRun(ctx);

  const outcome = await publishRun(ctx, runId);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.status, 409);
  assert.equal(outcome.code, "crunch_repository_not_found");
  assert.equal((await ctx.jobs.list({})).jobs.length, 0);
});

test("publishRun returns 409 crunch_run_empty_plan without enqueuing when the plan has no operations", async () => {
  const ctx = makeTestContext();
  await seedGitRepository(ctx);
  const run = await ctx.stores.crunchRuns.createRun({
    destinationId: "test-repo",
    trigger: "manual",
    documentCount: 1,
    status: "running"
  });
  // A completed run whose plan resulted in no operations must not publish.
  await ctx.stores.crunchRuns.completeRun(run.id, { summary: "nothing to do", operations: [], rationale: "r" });

  const outcome = await publishRun(ctx, run.id);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.status, 409);
  assert.equal(outcome.code, "crunch_run_empty_plan");
  assert.equal((await ctx.jobs.list({})).jobs.length, 0);
});

test("getRunExecutionContext returns the run plus repo config and never secrets", async () => {
  const ctx = makeTestContext();
  await seedGitRepository(ctx);
  const runId = await seedCompletedRun(ctx);

  const outcome = await getRunExecutionContext(ctx, runId);
  if (!outcome.ok) {
    throw new Error(`expected an execution context, got ${outcome.code}`);
  }

  assert.equal(outcome.run.id, runId);
  assert.equal(outcome.repository.id, "test-repo");
  assert.ok(outcome.repository.localPath, "localPath is resolved for the runner");
  assert.equal(outcome.repository.defaultBranch, "main");
  assert.ok(outcome.repository.git, "git context is exposed for the runner");

  // The exposed repository config must not leak credentials of any kind.
  const serialised = JSON.stringify(outcome.repository).toLowerCase();
  for (const secret of ["token", "password", "apikey", "authorization"]) {
    assert.equal(serialised.includes(secret), false, `repository config leaked "${secret}"`);
  }
});

test("getRunExecutionContext returns crunch_run_not_found for an unknown id", async () => {
  const ctx = makeTestContext();
  const outcome = await getRunExecutionContext(ctx, "missing");
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.code, "crunch_run_not_found");
});

test("getRunExecutionContext returns a 409 code when no git repository matches", async () => {
  const ctx = makeTestContext();
  const runId = await seedCompletedRun(ctx);

  const outcome = await getRunExecutionContext(ctx, runId);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.code, "crunch_repository_not_found");
});

test("changesetFromPlan applies deletes then writes with last-write-wins per path", async () => {
  const plan: CrunchPlan = {
    summary: "tidy",
    operations: [
      {
        kind: "split",
        title: "delete a.md",
        reason: "r",
        sources: ["a.md"],
        writes: [],
        deletes: ["a.md"]
      },
      {
        kind: "rewrite",
        title: "rewrite a.md",
        reason: "r",
        sources: ["a.md"],
        writes: [{ path: "a.md", content: "# A\nrewritten" }],
        deletes: []
      }
    ],
    rationale: "r"
  };

  const changes = changesetFromPlan(plan);

  const forA = changes.filter((change) => change.path === "a.md");
  assert.equal(forA.length, 1, "a path deleted then written collapses to a single entry");
  assert.equal(forA[0].content, "# A\nrewritten");
  assert.equal(forA[0].delete, undefined, "the surviving entry is a write, not a delete");
});
