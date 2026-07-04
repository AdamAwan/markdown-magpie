import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jobDefinition } from "@magpie/jobs";
import type { JobType, JobView } from "@magpie/jobs";
import type { AnswerResult, KnowledgeGapSignal } from "@magpie/core";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { FakeJobBroker } from "../../jobs/fake-broker.js";
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

// A fake broker that synchronously completes every answer_question job by
// writing a caller-controlled answer onto the re-asked question log — so
// runJobToCompletion returns at once and verifyGapClosure reads a real answer,
// no watcher required. Mirrors the ReshapingJobBroker pattern used by the
// reconciler tests.
class AnsweringJobBroker extends FakeJobBroker {
  constructor(
    private readonly ctx: ReturnType<typeof makeTestContext>,
    private readonly answerFor: (questionLogId: string) => AnswerResult
  ) {
    super();
  }

  override async create(type: JobType, input: unknown): Promise<JobView> {
    const job = await super.create(type, input);
    if (type === "answer_question") {
      const questionLogId = (input as { questionLogId: string }).questionLogId;
      const answer = this.answerFor(questionLogId);
      await this.ctx.stores.questionLogs.updateAnswer(questionLogId, { answer, chatProvider: "codex" });
      return super.complete(job.id, answer);
    }
    return job;
  }
}

// Like AnsweringJobBroker but branches on the re-asked question TEXT (carried on
// the job input), so a multi-question verification can close some re-asks and fail
// others deterministically without knowing the generated re-ask log ids up front.
class QuestionRoutingBroker extends FakeJobBroker {
  constructor(
    private readonly ctx: ReturnType<typeof makeTestContext>,
    private readonly answerForQuestion: (question: string) => AnswerResult
  ) {
    super();
  }

  override async create(type: JobType, input: unknown): Promise<JobView> {
    const job = await super.create(type, input);
    if (type === "answer_question") {
      const { questionLogId, question } = input as { questionLogId: string; question: string };
      const answer = this.answerForQuestion(question);
      await this.ctx.stores.questionLogs.updateAnswer(questionLogId, { answer, chatProvider: "codex" });
      return super.complete(job.id, answer);
    }
    return job;
  }
}

function citation(path: string): AnswerResult["citations"][number] {
  return { documentId: "d", sectionId: "s", path, heading: "h", anchor: "a", excerpt: "e", relevance: 0.9 };
}

async function mergedProposalWithGap(ctx: ReturnType<typeof makeTestContext>, flowId?: string) {
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: [log.id],
    ...(flowId ? { flowId } : {})
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  const merged = await ctx.stores.proposals.get(proposal.id);
  assert.ok(merged);
  return { log, merged };
}

test("runMergeCascade enqueues verification instead of resolving gaps blindly", async () => {
  const ctx = makeTestContext();
  const { merged } = await mergedProposalWithGap(ctx);

  const result = await proposals.runMergeCascade(ctx, merged);

  assert.equal(result.verificationEnqueued, true);
  const enqueued = await ctx.jobs.list({ type: "verify_gap_closure" });
  assert.equal(enqueued.jobs.length, 1, "a verify_gap_closure job was enqueued");

  // The gap is NOT resolved yet — resolution is now gated on verification.
  const after = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(
    after.some((candidate) => candidate.summary === "How to configure X"),
    true,
    "gap stays a candidate until verification confirms closure"
  );
});

test("runMergeCascade skips verification for a proposal with no triggering questions", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Seeded doc",
    targetPath: "seed.md",
    markdown: "# Seed",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  const merged = await ctx.stores.proposals.get(proposal.id);
  assert.ok(merged);

  const result = await proposals.runMergeCascade(ctx, merged);
  assert.equal(result.verificationEnqueued, false);
  assert.equal((await ctx.jobs.list({ type: "verify_gap_closure" })).jobs.length, 0);
});

test("runMergeCascade does not re-enqueue verification once the proposal's closure was already recorded", async () => {
  const ctx = makeTestContext();
  const { merged } = await mergedProposalWithGap(ctx);
  await ctx.stores.proposals.setClosureStatus(merged.id, "verified_closed");
  const alreadyVerified = await ctx.stores.proposals.get(merged.id);
  assert.ok(alreadyVerified);

  // Simulates a merged→merged re-POST (or any other caller re-running the
  // cascade for a proposal whose gap-closure verdict is already settled): the
  // cascade must not enqueue a second verify_gap_closure job.
  const result = await proposals.runMergeCascade(ctx, alreadyVerified!);

  assert.equal(result.verificationEnqueued, false);
  const enqueued = await ctx.jobs.list({ type: "verify_gap_closure" });
  assert.equal(enqueued.jobs.length, 0, "no verify_gap_closure job is enqueued once closure is already recorded");
});

test("runMergeCascade does not enqueue a second verify_gap_closure job while one is already in flight", async () => {
  const ctx = makeTestContext();
  const { merged } = await mergedProposalWithGap(ctx);
  // Pre-seed an in-flight job as if an earlier cascade run (e.g. a concurrent
  // request) already enqueued verification for this exact proposal.
  await ctx.jobs.create("verify_gap_closure", { proposalId: merged.id });

  const result = await proposals.runMergeCascade(ctx, merged);

  assert.equal(result.verificationEnqueued, false);
  const enqueued = await ctx.jobs.list({ type: "verify_gap_closure" });
  assert.equal(enqueued.jobs.length, 1, "the pre-existing job is not duplicated");
});

test("verifyGapClosure marks verified_closed and resolves the gap when the re-ask cites the merged doc", async () => {
  const ctx = makeTestContext();
  const { merged } = await mergedProposalWithGap(ctx);
  ctx.jobs = new AnsweringJobBroker(ctx, () => ({
    answer: "Set the config flag.",
    confidence: "high",
    citations: [citation("configure-x.md")]
  }));

  const result = await proposals.verifyGapClosure(ctx, merged);

  assert.equal(result.closureStatus, "verified_closed");
  assert.equal(result.perQuestion[0]?.verdict, "closed");
  const proposal = await ctx.stores.proposals.get(merged.id);
  assert.equal(proposal?.closureStatus, "verified_closed");
  const after = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(
    after.some((candidate) => candidate.summary === "How to configure X"),
    false,
    "a verified-closed gap is resolved and no longer a candidate"
  );
});

test("verifyGapClosure reopens with a note when the re-ask does not close the gap", async () => {
  const ctx = makeTestContext();
  const { log, merged } = await mergedProposalWithGap(ctx);
  ctx.jobs = new AnsweringJobBroker(ctx, () => ({
    answer: "I am not sure.",
    confidence: "low",
    citations: []
  }));

  const result = await proposals.verifyGapClosure(ctx, merged);

  assert.equal(result.closureStatus, "reopened");
  assert.equal(result.perQuestion[0]?.verdict, "still_open");
  const proposal = await ctx.stores.proposals.get(merged.id);
  assert.equal(proposal?.closureStatus, "reopened");
  // The gap stays open and carries a verification note for the re-draft.
  const reloaded = await ctx.stores.questionLogs.get(log.id);
  const vGap = (reloaded?.gaps ?? []).find((gap) => gap.source === "verification");
  assert.ok(vGap, "a verification gap was recorded");
  assert.match(vGap?.note ?? "", /configure-x\.md/);
  const after = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(
    after.some((candidate) => candidate.summary === "How to configure X"),
    true,
    "a reopened gap remains a candidate for re-drafting"
  );
});

test("verifyGapClosure files a reopen under the proposal-addressed gap, not the question's oldest open gap", async () => {
  const ctx = makeTestContext();
  // The question carries two open gaps: an older, unrelated one that loads first,
  // and the one the proposal actually addressed. The old primary pick took the
  // question's first open gap (the oldest) regardless of the proposal's scope, so
  // it would misfile the reopen under the unrelated gap — polluting an unrelated
  // draft and leaving the reopened gap un-resolvable by a later in-scope proposal.
  const gapSignal = (summary: string): KnowledgeGapSignal => ({
    summary,
    question: "How do I configure X?",
    confidence: "low",
    citedSectionIds: [],
    source: "auto"
  });
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: [],
    answer: {
      answer: "Partial.",
      confidence: "low",
      citations: [],
      // Older unrelated gap first (loads oldest-first), proposal-addressed gap second.
      gaps: [gapSignal("Older unrelated topic"), gapSignal("How to configure X")]
    }
  });
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
  ctx.jobs = new AnsweringJobBroker(ctx, () => ({
    answer: "Still unsure.",
    confidence: "low",
    citations: []
  }));

  const result = await proposals.verifyGapClosure(ctx, merged!);

  assert.equal(result.closureStatus, "reopened");
  const reloaded = await ctx.stores.questionLogs.get(log.id);
  const vGap = (reloaded?.gaps ?? []).find((gap) => gap.source === "verification");
  assert.ok(vGap, "a verification gap was recorded");
  assert.equal(
    vGap?.summary,
    "How to configure X",
    "the reopen is filed under the proposal-addressed gap, not the older unrelated one"
  );
  assert.notEqual(vGap?.summary, "Older unrelated topic");
});

test("verifyGapClosure files a multi-question cluster reopen under the failing question's own gap, not gap-1's", async () => {
  const ctx = makeTestContext();
  // A cluster proposal spans two questions: Q1's gap S1 (which sorts first in the
  // proposal's newline-joined gapSummary blob) and Q2's gap S2. Q1 verifies closed
  // but Q2 stays open. Q2's own live gap row has since been superseded, so the old
  // code fell through to element [0] of the display blob (S1 — Q1's gap) instead
  // of Q2's gap. The persisted cluster membership still records the per-question
  // association, so the reopen must be filed under Q2's own summary (S2).
  const q1 = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(q1.id, "How to configure X");
  const q2 = await ctx.stores.questionLogs.record({
    question: "How do I configure Y?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(q2.id, "How to configure Y");

  const cluster = await ctx.stores.gapClusters.createCluster({ title: "Configure X and Y", revision: 1 });
  const [gapS1] = await ctx.stores.questionLogs.gapIdsForSummary("How to configure X");
  const [gapS2] = await ctx.stores.questionLogs.gapIdsForSummary("How to configure Y");
  assert.ok(gapS1 && gapS2, "both cluster gaps have stable ids");
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapS1);
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapS2);
  // Q2's live gap row is superseded (e.g. a re-answer replaced it) — only the
  // structured cluster membership still records that this proposal addressed S2
  // for Q2, exactly the case the element-[0] fallback misfiled.
  await ctx.stores.questionLogs.clearManualGap(q2.id);

  const proposal = await ctx.stores.proposals.create({
    title: "Configure X and Y",
    targetPath: "configure-x.md",
    markdown: "# Configure X and Y\nbody",
    rationale: "r",
    evidence: [],
    // Newline-joined display blob; S1 (Q1's gap) sorts first.
    gapSummary: "How to configure X\nHow to configure Y",
    triggeringQuestionIds: [q1.id, q2.id],
    gapClusterId: cluster.id
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  const merged = await ctx.stores.proposals.get(proposal.id);
  assert.ok(merged);
  // Q1's re-ask closes (confident + cites the merged doc); Q2's stays open.
  ctx.jobs = new QuestionRoutingBroker(ctx, (question) =>
    question === "How do I configure X?"
      ? { answer: "Set the X flag.", confidence: "high", citations: [citation("configure-x.md")] }
      : { answer: "Still unsure.", confidence: "low", citations: [] }
  );

  const result = await proposals.verifyGapClosure(ctx, merged!);

  assert.equal(result.closureStatus, "reopened");
  const q2Reloaded = await ctx.stores.questionLogs.get(q2.id);
  const vGap = (q2Reloaded?.gaps ?? []).find((gap) => gap.source === "verification");
  assert.ok(vGap, "Q2's failed re-ask reopened a verification gap");
  assert.equal(
    vGap?.summary,
    "How to configure Y",
    "the reopen is filed under the failing question's own gap (S2), not gap-1 (S1)"
  );
  assert.notEqual(vGap?.summary, "How to configure X");
});

test("verifyGapClosure flags needs_attention after the retry cap and stops re-drafting", async () => {
  const ctx = makeTestContext();
  const { log, merged } = await mergedProposalWithGap(ctx);
  // Seed one prior failed verification from an earlier, DISTINCT redraft cycle
  // (its own proposal id) so this run is the second *distinct* failure — the cap.
  await ctx.stores.gapClosureVerifications.record({
    proposalId: "earlier-redraft-proposal",
    questionId: log.id,
    verdict: "still_open",
    confidence: "low",
    citedMergedDoc: false
  });
  ctx.jobs = new AnsweringJobBroker(ctx, () => ({
    answer: "Still unsure.",
    confidence: "low",
    citations: []
  }));

  const result = await proposals.verifyGapClosure(ctx, merged);

  assert.equal(result.closureStatus, "needs_attention");
  const reloaded = await ctx.stores.questionLogs.get(log.id);
  assert.ok((reloaded?.gaps ?? []).some((gap) => gap.source === "needs_attention"), "gap flagged needs_attention");
  const after = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(
    after.some((candidate) => candidate.summary === "How to configure X"),
    false,
    "a needs_attention gap awaits a human and does not auto-redraft"
  );
});

test("verifyGapClosure short-circuits without re-asking when closureStatus is already recorded", async () => {
  const ctx = makeTestContext();
  const { log, merged } = await mergedProposalWithGap(ctx);
  // A first, already-completed run recorded still_open right at the retry cap
  // boundary — one more still_open would flip this to needs_attention.
  await ctx.stores.gapClosureVerifications.record({
    proposalId: merged.id,
    questionId: log.id,
    verdict: "still_open",
    confidence: "low",
    citedMergedDoc: false
  });
  await ctx.stores.proposals.setClosureStatus(merged.id, "reopened");
  const reopened = await ctx.stores.proposals.get(merged.id);
  assert.ok(reopened);
  // A broker that fails the test if verifyGapClosure re-asks any question.
  ctx.jobs = new AnsweringJobBroker(ctx, () => {
    throw new Error("verifyGapClosure must not re-ask once closureStatus is already set");
  });

  const result = await proposals.verifyGapClosure(ctx, reopened!);

  assert.equal(result.closureStatus, "reopened");
  assert.deepEqual(result.perQuestion, []);
  // No new verification row was recorded — the prior still_open stays the only one,
  // so a duplicate call can never push a question over CLOSURE_RETRY_CAP by itself.
  assert.equal(await ctx.stores.gapClosureVerifications.countPriorStillOpen(log.id), 1);
});

test("verifyGapClosure drops a stale requestedFlowId and falls back to auto-routing", async () => {
  // The proposal's flowId names a flow that no longer exists in the knowledge
  // config (deleted/renamed between drafting and this post-merge re-ask).
  // Regression test for #157: the re-ask must not pin retrieval to it — doing
  // so makes resolveRepositoryScope fail with unknown_flow, which reads as a
  // false still_open verdict and can wrongly park the gap needs_attention even
  // though the merged doc fully answers the question.
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb" }];
  const { merged } = await mergedProposalWithGap(ctx, "deleted-flow");
  ctx.jobs = new AnsweringJobBroker(ctx, () => ({
    answer: "Set the config flag.",
    confidence: "high",
    citations: [citation("configure-x.md")]
  }));

  const result = await proposals.verifyGapClosure(ctx, merged);

  assert.equal(result.closureStatus, "verified_closed");
  const answerJobs = (await ctx.jobs.list({ type: "answer_question" })).jobs;
  assert.equal(answerJobs.length, 1);
  assert.equal(
    (answerJobs[0]?.input as { requestedFlowId?: string }).requestedFlowId,
    undefined,
    "a flowId absent from the knowledge config is dropped, not passed through to the job"
  );
});

test("verifyGapClosure keeps a requestedFlowId that still names a configured flow", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "billing", name: "Billing", sourceIds: ["s"], destinationId: "kb" }];
  const { merged } = await mergedProposalWithGap(ctx, "billing");
  ctx.jobs = new AnsweringJobBroker(ctx, () => ({
    answer: "Set the config flag.",
    confidence: "high",
    citations: [citation("configure-x.md")]
  }));

  await proposals.verifyGapClosure(ctx, merged);

  const answerJobs = (await ctx.jobs.list({ type: "answer_question" })).jobs;
  assert.equal(answerJobs.length, 1);
  assert.equal(
    (answerJobs[0]?.input as { requestedFlowId?: string }).requestedFlowId,
    "billing",
    "a flowId still present in the knowledge config is passed through unchanged"
  );
});

test("verifyGapClosure does not let a same-proposal retry inflate the retry cap", async () => {
  // Regression for issue #152(a): verify_gap_closure has no idempotency guard, so
  // a retried job re-runs the whole re-ask loop for the SAME proposal, recording
  // a second 'still_open' row for it. That must cost 1 toward the cap, not 2 —
  // otherwise a single logical failure that happens to retry burns the whole
  // budget before any real redraft attempt occurs.
  const ctx = makeTestContext();
  const { log, merged } = await mergedProposalWithGap(ctx);
  ctx.jobs = new AnsweringJobBroker(ctx, () => ({
    answer: "Still unsure.",
    confidence: "low",
    citations: []
  }));

  const first = await proposals.verifyGapClosure(ctx, merged);
  assert.equal(first.closureStatus, "reopened", "first attempt just reopens the gap");

  // Simulate pg-boss retrying the verify_gap_closure job: the same proposal is
  // re-verified from scratch, recording a second still_open row for it.
  const retried = await proposals.verifyGapClosure(ctx, merged);

  assert.equal(retried.closureStatus, "reopened", "a retry of the same proposal must not trip the cap by itself");
  const reloaded = await ctx.stores.questionLogs.get(log.id);
  assert.equal(
    (reloaded?.gaps ?? []).some((gap) => gap.source === "needs_attention"),
    false,
    "the gap is not parked after only one distinct failing proposal"
  );
});

test("verifyGapClosure resets the retry budget once the parked gap is resolved", async () => {
  // Regression for issue #152(b): resolveGaps/dismissGaps only ever touched
  // question_gaps, never gap_closure_verification, so a question parked once
  // then fixed permanently carried its old failure count forever. A genuinely
  // new gap on the same question must start with a fresh budget.
  const ctx = makeTestContext();
  const { log, merged } = await mergedProposalWithGap(ctx);
  ctx.jobs = new AnsweringJobBroker(ctx, () => ({
    answer: "Still unsure.",
    confidence: "low",
    citations: []
  }));

  const first = await proposals.verifyGapClosure(ctx, merged);
  assert.equal(first.closureStatus, "reopened");

  // A human (or a later successful redraft) resolves the reopened gap.
  const resolvedCount = await ctx.stores.questionLogs.resolveGaps([log.id], ["How to configure X"], "resolver-proposal");
  assert.ok(resolvedCount > 0, "the reopened gap was resolved");

  // A brand-new proposal later closes a fresh gap on the SAME question, and its
  // own verification also fails. On the old all-time count this would be the
  // second failure ever recorded for the question and would hit the cap
  // immediately; it must instead read as the first failure of a fresh budget.
  const secondProposal = await ctx.stores.proposals.create({
    title: "Configure X again",
    targetPath: "configure-x-2.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X, part 2",
    triggeringQuestionIds: [log.id]
  });
  await ctx.stores.proposals.updateStatus(secondProposal.id, "merged");
  const mergedSecond = await ctx.stores.proposals.get(secondProposal.id);
  assert.ok(mergedSecond);

  const second = await proposals.verifyGapClosure(ctx, mergedSecond);

  assert.equal(second.closureStatus, "reopened", "the fresh gap gets a new retry budget instead of instant needs_attention");
  const reloaded = await ctx.stores.questionLogs.get(log.id);
  assert.equal(
    (reloaded?.gaps ?? []).some((gap) => gap.source === "needs_attention"),
    false,
    "the question is not permanently parked after its earlier gap was resolved"
  );
});

test("verifyGapClosure resolves gaps for a closed question even when a sibling is still_open", async () => {
  // Regression test for issue #155: when a proposal triggers multiple questions
  // and one closes but a sibling is still_open, the closed question's gaps must
  // be resolved immediately, not stranded forever.
  const ctx = makeTestContext();

  // Create two triggering questions with manual gaps
  const log1 = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log1.id, "How to configure X");

  const log2 = await ctx.stores.questionLogs.record({
    question: "How do I deploy Y?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log2.id, "How to deploy Y");

  // Create a proposal triggered by both questions
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X and Deploy Y",
    targetPath: "setup.md",
    markdown: "# Setup\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X\nHow to deploy Y",
    triggeringQuestionIds: [log1.id, log2.id]
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  const merged = await ctx.stores.proposals.get(proposal.id);
  assert.ok(merged);

  // Custom broker that determines answers based on the stored question text
  class MixedAnswerBroker extends FakeJobBroker {
    override async create(type: JobType, input: unknown): Promise<JobView> {
      const job = await super.create(type, input);
      if (type === "answer_question") {
        const questionLogId = (input as { questionLogId: string }).questionLogId;
        const log = await ctx.stores.questionLogs.get(questionLogId);
        const answer: AnswerResult =
          log?.question === "How do I configure X?"
            ? {
                answer: "Set the config flag.",
                confidence: "high",
                citations: [citation("setup.md")]
              }
            : {
                answer: "I am not sure.",
                confidence: "low",
                citations: []
              };
        await ctx.stores.questionLogs.updateAnswer(questionLogId, { answer, chatProvider: "codex" });
        return super.complete(job.id, answer);
      }
      return job;
    }
  }
  ctx.jobs = new MixedAnswerBroker();

  const result = await proposals.verifyGapClosure(ctx, merged);

  // The overall closure should be "reopened" because Q2 is still_open
  assert.equal(result.closureStatus, "reopened");
  assert.equal(result.perQuestion.length, 2);
  assert.equal(result.perQuestion[0]?.verdict, "closed", "Q1's verdict is closed");
  assert.equal(result.perQuestion[1]?.verdict, "still_open", "Q2's verdict is still_open");

  // BUT Q1's gap should be resolved despite the sibling being still_open
  const after = await ctx.stores.questionLogs.listGapCandidates(50);
  const q1GapResolved = !after.some(
    (candidate) => candidate.summary === "How to configure X" && candidate.questionIds.includes(log1.id)
  );
  assert.ok(q1GapResolved, "Q1's gap is resolved even though Q2 is still_open");

  // And Q2's gap should still be a candidate for re-drafting
  const q2GapStillOpen = after.some(
    (candidate) => candidate.summary === "How to deploy Y" && candidate.questionIds.includes(log2.id)
  );
  assert.ok(q2GapStillOpen, "Q2's gap remains a candidate for re-drafting");
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

test("draftFromGaps threads a reopened gap's verification note into resubmissionNotes", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "openai-compatible",
    retrievedSectionIds: []
  });
  // A prior proposal merged but failed its gap-closure check, reopening the gap
  // with the detail of why the merged doc still did not answer the question.
  await ctx.stores.questionLogs.recordVerificationGap(log.id, {
    summary: "How to configure X",
    source: "verification",
    note: "merged configure-x.md; re-ask still low; no worked example of the toggle"
  });

  const outcome = await proposals.draftFromGaps(ctx, ["How to configure X"]);
  if (!outcome.ok) {
    throw new Error("expected a queued draft");
  }

  const parsed = jobDefinition("draft_markdown_proposal").inputSchema.safeParse(outcome.job.input);
  assert.ok(parsed.success, "resubmissionNotes must survive the draft contract");
  const input = outcome.job.input as { resubmissionNotes?: string[] };
  assert.deepEqual(input.resubmissionNotes, [
    "merged configure-x.md; re-ask still low; no worked example of the toggle"
  ]);
});

test("draftFromGaps omits resubmissionNotes for a first-time draft", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "openai-compatible",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

  const outcome = await proposals.draftFromGaps(ctx, ["How to configure X"]);
  if (!outcome.ok) {
    throw new Error("expected a queued draft");
  }
  const input = outcome.job.input as { resubmissionNotes?: string[] };
  assert.equal(input.resubmissionNotes, undefined, "no note noise on a first draft");
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
  // A non-local (github) destination routes to the github publish queue.
  assert.deepEqual(job.input, { proposalId: proposal.id, destination: "github" });

  const parsed = jobDefinition("publish_proposal").inputSchema.safeParse(job.input);
  assert.ok(parsed.success, "enqueued input should match the publish_proposal contract");

  // No git execution happened in the API: the proposal is still ready, with no
  // publication recorded.
  const after = await ctx.stores.proposals.get(proposal.id);
  assert.equal(after?.status, "ready");
  assert.equal(after?.publication, undefined);
});

test("enqueuePublishProposal routes a file:// destination to the local-git publish queue", async () => {
  const ctx = makeTestContext({
    knowledgeConfig: {
      sources: [],
      destinations: [{ id: "demo", name: "Demo", url: "file:///tmp/demo-repo", kind: "git" }],
      flows: [],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# X\n",
    rationale: "r",
    evidence: [],
    destinationId: "demo"
  });

  const job = await proposals.enqueuePublishProposal(ctx, proposal);
  assert.deepEqual(job.input, { proposalId: proposal.id, destination: "local-git" });
  assert.equal(job.queueName, "publish_proposal__local_git");
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

test("createSeedProposalFromCompletedJob creates a clusterless draft carrying the flowId, idempotent on jobId", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("draft_seed_document", {
    flowId: "billing",
    coverage: ["what billing is"],
    sourceContext: [],
    provider: "codex"
  });
  const output = { title: "Billing overview", targetPath: "billing.md", markdown: "# Billing", rationale: "seed" };

  const first = await proposals.createSeedProposalFromCompletedJob(ctx, job, output);
  assert.ok(first);
  assert.equal(first?.flowId, "billing");
  assert.equal(first?.markdown, "# Billing");
  assert.equal(first?.gapClusterId, undefined);

  // Re-delivery: same jobId -> same proposal, no duplicate.
  const second = await proposals.createSeedProposalFromCompletedJob(ctx, job, output);
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

// --- local-git merge -------------------------------------------------------

function ctxWithDestination(url: string): ReturnType<typeof makeTestContext> {
  return makeTestContext({
    knowledgeConfig: {
      sources: [],
      destinations: [{ id: "demo", name: "Demo", url, kind: "git" }],
      flows: [],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

async function branchPushedProposal(
  ctx: ReturnType<typeof makeTestContext>,
  remoteUrl: string
): Promise<string> {
  const created = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\n",
    rationale: "r",
    evidence: [],
    destinationId: "demo"
  });
  await ctx.stores.proposals.recordPublication(created.id, {
    provider: "local-git",
    branchName: "magpie/proposal-abc",
    commitSha: "deadbeef",
    remoteUrl,
    publishedAt: new Date().toISOString()
  });
  return created.id;
}

test("isLocalGitDestination is true only for file:// destinations", async () => {
  const proposal = { targetPath: "configure-x.md", destinationId: "demo" } as never;
  assert.equal(proposals.isLocalGitDestination(ctxWithDestination("file:///tmp/demo"), proposal), true);
  assert.equal(proposals.isLocalGitDestination(ctxWithDestination("https://github.com/o/r.git"), proposal), false);
  assert.equal(proposals.isLocalGitDestination(makeTestContext(), proposal), false);
});

test("mergeLocalProposal merges, marks merged, and targets the destination repo", async () => {
  const url = pathToFileURL(path.join(tmpdir(), "demo-kb")).href;
  const ctx = ctxWithDestination(url);
  const id = await branchPushedProposal(ctx, url);
  const proposal = await ctx.stores.proposals.get(id);
  assert.ok(proposal);

  const calls: Array<{ repoPath: string; branchName: string; defaultBranch: string }> = [];
  const fakeMerge = async (req: { repoPath: string; branchName: string; defaultBranch: string }) => {
    calls.push(req);
    return { mergeCommitSha: "merge-sha" };
  };

  const result = await proposals.mergeLocalProposal(ctx, proposal, fakeMerge);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repoPath, fileURLToPath(url));
  assert.equal(calls[0].branchName, "magpie/proposal-abc");
  assert.equal(calls[0].defaultBranch, "main");
  assert.equal((await ctx.stores.proposals.get(id))?.status, "merged");
});

test("mergeLocalProposal rejects a hosted destination", async () => {
  const ctx = ctxWithDestination("https://github.com/o/r.git");
  const id = await branchPushedProposal(ctx, "https://github.com/o/r.git");
  const proposal = await ctx.stores.proposals.get(id);
  assert.ok(proposal);
  const result = await proposals.mergeLocalProposal(ctx, proposal, async () => ({ mergeCommitSha: "x" }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "not_local_git_destination");
});

test("mergeLocalProposal rejects a proposal that is not branch-pushed", async () => {
  const url = "file:///tmp/demo-kb";
  const ctx = ctxWithDestination(url);
  const created = await ctx.stores.proposals.create({
    title: "Draft", targetPath: "d.md", markdown: "# d\n", rationale: "r", evidence: [], destinationId: "demo"
  });
  const proposal = await ctx.stores.proposals.get(created.id);
  assert.ok(proposal);
  const result = await proposals.mergeLocalProposal(ctx, proposal, async () => ({ mergeCommitSha: "x" }));
  assert.equal(result.ok === false && result.code, "proposal_not_mergeable");
});

test("mergeLocalProposal keeps status on a merge conflict", async () => {
  const url = pathToFileURL(path.join(tmpdir(), "demo-kb")).href;
  const ctx = ctxWithDestination(url);
  const id = await branchPushedProposal(ctx, url);
  const proposal = await ctx.stores.proposals.get(id);
  assert.ok(proposal);
  const result = await proposals.mergeLocalProposal(ctx, proposal, async () => {
    throw new Error("Could not merge magpie/proposal-abc into main: CONFLICT");
  });
  assert.equal(result.ok === false && result.code, "merge_conflict");
  assert.equal((await ctx.stores.proposals.get(id))?.status, "branch-pushed");
});

test("list attaches localGitDestination", async () => {
  const url = "file:///tmp/demo-kb";
  const ctx = ctxWithDestination(url);
  await branchPushedProposal(ctx, url);
  const [listed] = await proposals.list(ctx, 10);
  assert.equal(listed.localGitDestination, true);
});
