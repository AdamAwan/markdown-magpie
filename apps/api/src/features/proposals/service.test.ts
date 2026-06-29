import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { jobDefinition } from "@magpie/jobs";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { makeTestContext } from "../../test-support/context.js";
import * as proposals from "./service.js";

const execFileAsync = promisify(execFile);

// Seeds a git checkout with one commit and an origin remote, then indexes it so
// findRepositoryForProposal resolves a git-backed RepositoryRef (scope !=
// not-git, with a workTreeRoot) — the precondition the publish path validates.
async function seedGitRepository(ctx: ReturnType<typeof makeTestContext>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-proposal-test-"));
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

test("runMergeCascade resolves the gaps the merged proposal recorded", async () => {
  const ctx = makeTestContext();

  // Record a question and flag a manual gap on it. Manual-gap logs surface as
  // gap candidates regardless of confidence.
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

  const before = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(
    before.some((candidate) => candidate.summary === "How to configure X"),
    true,
    "gap should be a candidate before the proposal merges"
  );

  // A merged proposal that closes exactly that gap.
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: [log.id]
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  const merged = await ctx.stores.proposals.get(proposal.id);
  assert.ok(merged);

  const result = await proposals.runMergeCascade(ctx, merged);

  assert.equal(result.resolvedGapCount, 1);

  const after = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(
    after.some((candidate) => candidate.summary === "How to configure X"),
    false,
    "resolved gap should no longer be a candidate"
  );
});

test("draftFromGaps always enqueues a catalog-valid draft_markdown_proposal job", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    
    chatProvider: "openai-compatible",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

  const outcome = await proposals.draftFromGaps(ctx, ["How to configure X"], {
    openPullRequests: [
      { title: "Existing doc", url: "https://github.com/o/r/pull/1", targetPath: "x.md", status: "pr-opened" }
    ]
  });
  if (!outcome.ok) {
    throw new Error("expected a queued draft");
  }

  // No proposal is created up front — the draft lands later via completion.
  assert.deepEqual(await ctx.stores.proposals.list(50), []);

  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.type, "draft_markdown_proposal");
  assert.equal(job.id, outcome.job.id);
  assert.equal(job.state, "created");

  const parsed = jobDefinition("draft_markdown_proposal").inputSchema.safeParse(job.input);
  assert.ok(parsed.success, "enqueued input should match the draft_markdown_proposal contract");

  const input = job.input as {
    gapSummaries: string[];
    provider: string;
    triggeringQuestionIds?: string[];
    openPullRequests?: { status: string }[];
  };
  assert.deepEqual(input.gapSummaries, ["How to configure X"]);
  assert.equal(input.provider, "openai-compatible");
  // Both must survive the broker's schema-parse so the proposal links back to its
  // triggering questions and the drafter sees the in-flight PR it should not duplicate.
  assert.ok(input.triggeringQuestionIds?.includes(log.id), "triggeringQuestionIds survives enqueue");
  assert.equal(input.openPullRequests?.[0]?.status, "pr-opened");
});

test("draftFromGaps passes the configured provider through unchanged", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "codex" });
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

  const outcome = await proposals.draftFromGaps(ctx, ["How to configure X"]);
  if (!outcome.ok) {
    throw new Error("expected a queued draft");
  }
  const input = outcome.job.input as { provider: string };
  assert.equal(input.provider, "codex");
});

test("collectOpenPullRequestContext returns [] when the flow has no snapshot yet", async () => {
  const ctx = makeTestContext();
  assert.deepEqual(await proposals.collectOpenPullRequestContext(ctx, undefined), []);
});

test("collectOpenPullRequestContext maps the snapshot's in-flight proposals to drafting context", async () => {
  const ctx = makeTestContext();
  const opened = await ctx.stores.proposals.create({
    title: "Cheese ageing",
    targetPath: "cheese/ageing.md",
    markdown: "#",
    rationale: "r",
    evidence: []
  });
  const draft = await ctx.stores.proposals.create({
    title: "Cheese pairing",
    targetPath: "cheese/pairing.md",
    markdown: "#",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.snapshots.write({
    flowId: undefined,
    takenAt: new Date().toISOString(),
    catalogRevision: 0,
    gaps: [],
    proposals: [
      { id: opened.id, title: "Cheese ageing", status: "pr-opened", pullRequestUrl: "https://github.com/o/r/pull/7" },
      { id: draft.id, title: "Cheese pairing", status: "draft" }
    ],
    pullRequests: [
      { proposalId: opened.id, url: "https://github.com/o/r/pull/7", merged: false, state: "open", checkedAt: new Date().toISOString() }
    ]
  });

  const context = await proposals.collectOpenPullRequestContext(ctx, undefined);
  assert.equal(context.length, 2, "both the open PR and the in-flight draft are surfaced");
  const openPr = context.find((entry) => entry.status === "pr-opened");
  assert.deepEqual(openPr, {
    title: "Cheese ageing",
    url: "https://github.com/o/r/pull/7",
    targetPath: "cheese/ageing.md",
    status: "pr-opened"
  });
  const draftEntry = context.find((entry) => entry.status === "draft");
  assert.equal(draftEntry?.url, undefined, "an in-flight draft has no PR url yet");
  assert.equal(draftEntry?.targetPath, "cheese/pairing.md");
});

test("collectOpenPullRequestContext excludes the named cluster's own proposal and settled PRs", async () => {
  const ctx = makeTestContext();
  const own = await ctx.stores.proposals.create({
    title: "Own",
    targetPath: "own.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapClusterId: "cluster-1"
  });
  const merged = await ctx.stores.proposals.create({
    title: "Merged",
    targetPath: "merged.md",
    markdown: "#",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.snapshots.write({
    flowId: undefined,
    takenAt: new Date().toISOString(),
    catalogRevision: 0,
    gaps: [],
    proposals: [
      { id: own.id, title: "Own", status: "pr-opened", gapClusterId: "cluster-1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { id: merged.id, title: "Merged", status: "pr-opened", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ],
    // The fetch job recorded pull/2 as already merged — it's no longer open.
    pullRequests: [
      { proposalId: merged.id, url: "https://github.com/o/r/pull/2", merged: true, state: "closed", checkedAt: new Date().toISOString() }
    ]
  });

  const context = await proposals.collectOpenPullRequestContext(ctx, undefined, { excludeClusterId: "cluster-1" });
  assert.deepEqual(context, [], "own-cluster proposal excluded; merged PR dropped as not open");
});

test("requestProposalPublication enqueues a publish_proposal job after validation passes", async () => {
  const ctx = makeTestContext();
  await seedGitRepository(ctx);
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "ready");
  const ready = await ctx.stores.proposals.get(proposal.id);
  assert.ok(ready);

  const outcome = await proposals.requestProposalPublication(ctx, ready);
  if (!outcome.ok) {
    throw new Error(`expected publication to be enqueued, got ${outcome.code}`);
  }

  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.type, "publish_proposal");
  assert.equal(job.id, outcome.job.id);
  assert.equal(job.state, "created");
  assert.deepEqual(job.input, { proposalId: proposal.id });

  const parsed = jobDefinition("publish_proposal").inputSchema.safeParse(job.input);
  assert.ok(parsed.success, "enqueued input should match the publish_proposal contract");

  // No git execution happened in the API: the proposal is still ready, with no
  // publication recorded.
  const after = await ctx.stores.proposals.get(proposal.id);
  assert.equal(after?.status, "ready");
  assert.equal(after?.publication, undefined);
});

test("requestProposalPublication fails fast without enqueuing when no git repository matches", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "ready");
  const ready = await ctx.stores.proposals.get(proposal.id);
  assert.ok(ready);

  const outcome = await proposals.requestProposalPublication(ctx, ready);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.code, "proposal_repository_not_found");

  // Nothing was enqueued.
  assert.equal((await ctx.jobs.list({})).jobs.length, 0);
});

test("requestProposalPublication fails fast with proposal_repository_not_git for a non-git repo", async () => {
  const ctx = makeTestContext();
  // Index a plain (non-git) directory so findRepositoryForProposal resolves a
  // RepositoryRef whose git scope is "not-git" — the second validation branch.
  const root = await mkdtemp(path.join(tmpdir(), "magpie-proposal-nongit-"));
  await writeFile(path.join(root, "README.md"), "# plain\n", "utf8");
  await ctx.stores.knowledgeIndex.indexLocalRepository({ localPath: root, repositoryId: "plain-repo", name: "plain-repo" });

  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "ready");
  const ready = await ctx.stores.proposals.get(proposal.id);
  assert.ok(ready);

  const outcome = await proposals.requestProposalPublication(ctx, ready);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.code, "proposal_repository_not_git");
  assert.equal((await ctx.jobs.list({})).jobs.length, 0);
});

test("getProposalExecutionContext returns the proposal plus repo config and never secrets", async () => {
  const ctx = makeTestContext();
  await seedGitRepository(ctx);
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "ready");

  const outcome = await proposals.getProposalExecutionContext(ctx, proposal.id);
  if (!outcome.ok) {
    throw new Error(`expected an execution context, got ${outcome.code}`);
  }

  assert.equal(outcome.proposal.id, proposal.id);
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

test("getProposalExecutionContext returns proposal_not_found for an unknown id", async () => {
  const ctx = makeTestContext();
  const outcome = await proposals.getProposalExecutionContext(ctx, "missing");
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.code, "proposal_not_found");
});

test("getProposalExecutionContext returns 409 codes when no git repository matches", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: []
  });

  const outcome = await proposals.getProposalExecutionContext(ctx, proposal.id);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.code, "proposal_repository_not_found");
});

test("createCorrectiveProposalFromCompletedJob creates a labelled draft carrying the flowId, idempotent on jobId", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("correct_document", {
    path: "a.md",
    content: "# a",
    claims: [{ claim: "stale", reason: "x" }],
    sources: [],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });
  const output = { markdown: "# a (fixed)", rationale: "removed stale claim" };

  const first = await proposals.createCorrectiveProposalFromCompletedJob(ctx, job, output);
  assert.ok(first);
  assert.equal(first?.flowId, "billing");
  assert.equal(first?.targetPath, "a.md");
  assert.equal(first?.markdown, "# a (fixed)");
  assert.ok(first?.title.startsWith("Verify:"));

  // Re-delivery: same jobId -> same proposal, no duplicate.
  const second = await proposals.createCorrectiveProposalFromCompletedJob(ctx, job, output);
  assert.equal(second?.id, first?.id);
  assert.equal((await proposals.list(ctx, 50)).length, 1);
});

async function dedupeJob(ctx: ReturnType<typeof makeTestContext>) {
  return ctx.jobs.create("dedupe_documents", {
    path: "kb/refunds.md",
    content: "# Refunds",
    neighbours: [{ path: "kb/partial-refunds.md", content: "# Partial refunds" }],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });
}

test("createDedupeProposalFromCompletedJob drafts a file-set proposal carrying the changeset and flowId", async () => {
  const ctx = makeTestContext();
  const job = await dedupeJob(ctx);
  const changeset = [
    { path: "kb/refunds.md", content: "# Refunds\nincludes partial refunds" },
    { path: "kb/partial-refunds.md", delete: true }
  ];
  const output = { duplicate: true, rationale: "merged the duplicate", primaryPath: "kb/refunds.md", changeset };

  const first = await proposals.createDedupeProposalFromCompletedJob(ctx, job, output);
  assert.ok(first);
  assert.equal(first?.flowId, "billing");
  assert.equal(first?.targetPath, "kb/refunds.md");
  assert.equal(first?.markdown, "# Refunds\nincludes partial refunds");
  assert.deepEqual(first?.changeset, changeset);
  assert.ok(first?.title.startsWith("Dedupe:"));

  // Idempotent on jobId.
  const second = await proposals.createDedupeProposalFromCompletedJob(ctx, job, output);
  assert.equal(second?.id, first?.id);
});

test("createDedupeProposalFromCompletedJob is silent when no duplicate was found", async () => {
  const ctx = makeTestContext();
  const job = await dedupeJob(ctx);
  const result = await proposals.createDedupeProposalFromCompletedJob(ctx, job, {
    duplicate: false,
    rationale: "no real overlap",
    changeset: []
  });
  assert.equal(result, undefined);
});

test("createDedupeProposalFromCompletedJob skips a changeset whose primaryPath has no write", async () => {
  const ctx = makeTestContext();
  const job = await dedupeJob(ctx);
  const result = await proposals.createDedupeProposalFromCompletedJob(ctx, job, {
    duplicate: true,
    rationale: "malformed",
    primaryPath: "kb/refunds.md",
    changeset: [{ path: "kb/partial-refunds.md", delete: true }]
  });
  assert.equal(result, undefined);
});


async function splitJob(ctx: ReturnType<typeof makeTestContext>) {
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: [
      { path: "kb/operations.md", content: "# Operations" },
      { path: "kb/billing.md", content: "# Billing" },
      { path: "kb/unrelated.md", content: "# Unrelated" }
    ]
  });
  return ctx.jobs.create("split_document", {
    path: "kb/operations.md",
    content: "# Operations",
    neighbours: [{ path: "kb/billing.md", content: "# Billing" }],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });
}

test("createSplitProposalFromCompletedJob drafts a constrained file-set proposal", async () => {
  const ctx = makeTestContext();
  const job = await splitJob(ctx);
  const changeset = [
    { path: "kb/operations.md", content: "# Operations\nSee the focused billing guide." },
    { path: "kb/billing.md", delete: true },
    { path: "kb/billing-guide.md", content: "# Billing Guide\nMoved billing detail." }
  ];
  const output = { split: true, rationale: "moved billing detail out", primaryPath: "kb/operations.md", changeset };

  const first = await proposals.createSplitProposalFromCompletedJob(ctx, job, output);
  assert.ok(first);
  assert.equal(first?.flowId, "billing");
  assert.equal(first?.targetPath, "kb/operations.md");
  assert.equal(first?.markdown, "# Operations\nSee the focused billing guide.");
  assert.deepEqual(first?.changeset, changeset);
  assert.ok(first?.title.startsWith("Split:"));

  const second = await proposals.createSplitProposalFromCompletedJob(ctx, job, output);
  assert.equal(second?.id, first?.id);
});

test("createSplitProposalFromCompletedJob is silent when the document stays cohesive", async () => {
  const ctx = makeTestContext();
  const job = await splitJob(ctx);
  const result = await proposals.createSplitProposalFromCompletedJob(ctx, job, {
    split: false,
    rationale: "already cohesive",
    changeset: []
  });
  assert.equal(result, undefined);
});

test("createSplitProposalFromCompletedJob rejects changes to unrelated existing docs", async () => {
  const ctx = makeTestContext();
  const job = await splitJob(ctx);
  const result = await proposals.createSplitProposalFromCompletedJob(ctx, job, {
    split: true,
    rationale: "too broad",
    primaryPath: "kb/operations.md",
    changeset: [
      { path: "kb/operations.md", content: "# Operations" },
      { path: "kb/unrelated.md", content: "# Rewritten unrelated" }
    ]
  });
  assert.equal(result, undefined);
});

async function improveJob(ctx: ReturnType<typeof makeTestContext>, content = "# Refunds") {
  return ctx.jobs.create("improve_document", {
    path: "kb/refunds.md",
    content,
    sources: [{ sourceId: "s1", sourceName: "Billing", kind: "git", path: "refunds.ts", content: "partial refunds are supported" }],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });
}

test("createImproveProposalFromCompletedJob drafts a labelled single-file proposal carrying flowId", async () => {
  const ctx = makeTestContext();
  const job = await improveJob(ctx);
  const output = {
    improved: true,
    markdown: "# Refunds\nPartial refunds are supported.",
    rationale: "Added source-backed partial refund coverage."
  };

  const first = await proposals.createImproveProposalFromCompletedJob(ctx, job, output);
  assert.ok(first);
  assert.equal(first?.flowId, "billing");
  assert.equal(first?.destinationId, "docs");
  assert.equal(first?.targetPath, "kb/refunds.md");
  assert.equal(first?.markdown, output.markdown);
  assert.ok(first?.title.startsWith("Improve:"));

  const second = await proposals.createImproveProposalFromCompletedJob(ctx, job, output);
  assert.equal(second?.id, first?.id);
  assert.equal((await proposals.list(ctx, 50)).length, 1);
});

test("createImproveProposalFromCompletedJob is silent for no-op or unchanged improvements", async () => {
  const ctx = makeTestContext();
  const job = await improveJob(ctx, "# Refunds");

  assert.equal(
    await proposals.createImproveProposalFromCompletedJob(ctx, job, { improved: false, rationale: "Already complete." }),
    undefined
  );
  assert.equal(
    await proposals.createImproveProposalFromCompletedJob(ctx, job, {
      improved: true,
      markdown: "# Refunds",
      rationale: "No material change."
    }),
    undefined
  );
});

test("isProposalStatus accepts every lifecycle status, including superseded, and rejects others", async () => {
  // Guards the list's ?status= filter. Must accept the full enum — superseded was
  // once omitted, so filtering by it was silently dropped.
  for (const status of ["draft", "ready", "branch-pushed", "pr-opened", "merged", "rejected", "superseded"]) {
    assert.equal(proposals.isProposalStatus(status), true, `${status} should be a valid status`);
  }
  for (const notAStatus of ["", "archived", "SUPERSEDED", undefined, null, 7]) {
    assert.equal(proposals.isProposalStatus(notAStatus), false, `${String(notAStatus)} should be rejected`);
  }
});
