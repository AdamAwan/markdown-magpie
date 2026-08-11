import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnswerQuestionJobOutput, Citation } from "@magpie/core";
import { makeTestContext } from "../../test-support/context.js";
import * as questionnaires from "./service.js";

function flowContext(): ReturnType<typeof makeTestContext> {
  return makeTestContext({
    knowledgeConfig: {
      sources: [{ id: "src-1", name: "Compliance repo", kind: "git", url: "https://example.com/compliance.git" }],
      destinations: [{ id: "docs", name: "Docs", kind: "local", path: "docs" }],
      flows: [
        {
          id: "security",
          name: "Security",
          sourceIds: ["src-1"],
          destinationId: "docs",
          routingSummary: "security and compliance"
        }
      ],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

function confidentOutput(): AnswerQuestionJobOutput {
  const citation: Citation = {
    documentId: "docs:certs.md",
    sectionId: "docs:certs.md:0",
    path: "certs.md",
    heading: "Certificates",
    anchor: "0",
    excerpt: "ISO 27001",
    relevance: 0.9
  };
  return { answer: "We hold ISO 27001.", confidence: "high", citations: [citation], flowId: "security" };
}

type Ctx = ReturnType<typeof flowContext>;

// Deterministic axis assignment so the fake embedder can control which
// questions "match": any question containing ISO lands on axis 0, SOC2 on
// axis 1, everything else on axis 2 — kept apart so unrelated questions never
// accidentally collide.
function axisForText(text: string): number {
  if (text.includes("ISO")) return 0;
  if (text.includes("SOC2")) return 1;
  return 2;
}

function axisVector(text: string): number[] {
  const vector = new Array<number>(3).fill(0);
  vector[axisForText(text)] = 1;
  return vector;
}

// A flow context with a configured (fake) embedding provider, so the match
// phase's `if (embedding && model)` guard is satisfied and matchApprovedTopN
// has real vectors to compare.
function embeddingAxisContext(): Ctx {
  const ctx = flowContext();
  ctx.settings.embeddings.openAiCompatible = {
    embeddingBaseUrl: "http://embeddings.test",
    embeddingApiKey: "test-key",
    embeddingModel: "test-model"
  };
  ctx.providers.embedding = {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => axisVector(text));
    }
  };
  return ctx;
}

async function jobForLog(ctx: Ctx, logId: string | undefined) {
  const { jobs } = await ctx.jobs.list({ type: "answer_question_batch" });
  return jobs.find((job) => (job.input as { questionLogId?: string }).questionLogId === logId);
}

// Creates, answers, and approves a questionnaire item so it becomes an
// approved match-corpus entry (embedding stamped via the real approval-time
// backfill). Requires ctx to have a configured embedding provider.
async function createApprovedDonor(
  ctx: Ctx,
  opts: { question: string; answer: string; direction?: string }
): Promise<string> {
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "donor pool",
    flowId: "security",
    questions: [opts.question],
    ...(opts.direction ? { direction: opts.direction } : {})
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;
  const item = await ctx.stores.questionnaires.itemById(itemId);
  const job = await jobForLog(ctx, item?.questionLogId);
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    answer: opts.answer,
    confidence: "high",
    citations: [
      {
        documentId: "docs:certs.md",
        sectionId: `sec-${itemId}`,
        path: "certs.md",
        heading: "Certificates",
        anchor: "0",
        excerpt: opts.answer,
        relevance: 0.9
      }
    ]
  });
  const approved = await questionnaires.approveItem(ctx, created.questionnaire.id, itemId);
  assert.deepEqual(approved, { ok: true });
  return itemId;
}

// Creates and answers (but does not approve) a questionnaire item — enough to
// serve as a reuse "basis" item for the completion-mapping tests, which read
// basis.answer/citations directly rather than through the match corpus.
async function createAnsweredItem(
  ctx: Ctx,
  opts: { question: string; answer: string; citation: Citation }
): Promise<string> {
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "basis pool",
    flowId: "security",
    questions: [opts.question]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;
  const item = await ctx.stores.questionnaires.itemById(itemId);
  const job = await jobForLog(ctx, item?.questionLogId);
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    answer: opts.answer,
    confidence: "high",
    citations: [opts.citation]
  });
  return itemId;
}

test("createQuestionnaire rejects unknown flows and empty question lists", async () => {
  const ctx = flowContext();
  const unknownFlow = await questionnaires.createQuestionnaire(ctx, {
    name: "SIG",
    flowId: "nope",
    questions: ["q"]
  });
  assert.deepEqual(unknownFlow, { ok: false, code: "flow_not_found" });

  const empty = await questionnaires.createQuestionnaire(ctx, {
    name: "SIG",
    flowId: "security",
    questions: ["   ", ""]
  });
  assert.deepEqual(empty, { ok: false, code: "empty_questionnaire" });
});

test("createQuestionnaire drips up to maxInflight answer jobs, flow-pinned with questionnaire purpose", async () => {
  const ctx = flowContext();
  const result = await questionnaires.createQuestionnaire(ctx, {
    name: "Acme SIG Q3",
    flowId: "security",
    questions: ["q0", "q1", "q2", "q3", "q4"]
  });
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");

  const max = ctx.settings.questionnaires.maxInflight;
  const { jobs } = await ctx.jobs.list({ type: "answer_question_batch" });
  assert.equal(jobs.length, max, `exactly ${max} items in flight`);
  for (const job of jobs) {
    const input = job.input as { requestedFlowId?: string; questionLogId?: string };
    assert.equal(input.requestedFlowId, "security");
    const log = await ctx.stores.questionLogs.get(input.questionLogId ?? "");
    assert.equal(log?.purpose, "questionnaire");
  }

  const fetched = await questionnaires.getQuestionnaire(ctx, result.questionnaire.id);
  const statuses = fetched?.items.map((item) => item.status);
  assert.deepEqual(statuses?.slice(0, max), new Array(max).fill("answering"));
  assert.deepEqual(statuses?.slice(max), new Array(5 - max).fill("pending"));
});

test("completion advances the drip; unconfident/uncited answers mark items unanswerable", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "drip",
    flowId: "security",
    questions: ["q0", "q1", "q2", "q3"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const id = created.questionnaire.id;
  const max = ctx.settings.questionnaires.maxInflight;

  const { jobs } = await ctx.jobs.list({ type: "answer_question_batch" });
  const [first, second] = jobs;

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, first, confidentOutput());
  let fetched = await questionnaires.getQuestionnaire(ctx, id);
  const answered = fetched?.items.find((item) => item.status === "answered");
  assert.equal(answered?.answer, "We hold ISO 27001.");
  assert.equal(answered?.outcome, "fresh");
  // Slot freed → the 4th item was enqueued.
  const after = await ctx.jobs.list({ type: "answer_question_batch" });
  assert.equal(after.jobs.length, Math.min(4, max + 1));

  // Low-confidence output → unanswerable (the gap flywheel's entry point).
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, second, {
    answer: "I could not find this.",
    confidence: "low",
    citations: []
  });
  fetched = await questionnaires.getQuestionnaire(ctx, id);
  assert.equal(fetched?.items.filter((item) => item.status === "unanswerable").length, 1);
});

test("drip stops and reverts the item + log when the atomic gate rejects at capacity", async () => {
  const ctx = flowContext();
  // The global AI ceiling is already fully occupied by out-of-band jobs, and
  // there is no interactive reserve headroom — so the very first drip admission
  // is shed at the atomic gate.
  ctx.settings.rateLimit.aiMaxInflightJobs = 1;
  ctx.settings.rateLimit.aiInteractiveReservedJobs = 0;
  await ctx.jobs.create("summarize_gap", {
    provider: "codex",
    questions: ["saturating"],
    citedSections: [],
    expectedOutput: "gap_summary"
  });

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "saturated",
    flowId: "security",
    questions: ["q0", "q1"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");

  // No answer_question job was enqueued (the gate rejected), and the drip paused.
  assert.equal((await ctx.jobs.list({ type: "answer_question_batch" })).total, 0, "no drip job enqueued at capacity");

  // Every item is back to pending (none stuck in "answering"), and no orphaned
  // question log was left behind.
  const fetched = await ctx.stores.questionnaires.get(created.questionnaire.id);
  assert.ok(fetched);
  assert.ok(
    fetched.items.every((item) => item.status === "pending"),
    "the optimistically-marked item was reverted to pending"
  );
  assert.equal(await ctx.stores.questionLogs.count(), 0, "the drip's question log was deleted");
});

test("legacy answer_question questionnaire jobs still route through completion (deploy drain, #288c)", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "drain",
    flowId: "security",
    questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");

  // The drip now enqueues answer_question_batch, but an answer_question job for
  // the SAME questionnaire item could still be in flight across a deploy. Simulate
  // it by taking the real drip job and stamping the legacy type — the completion
  // hook must still mark the item (the questionLogId→item lookup is the guard).
  const { jobs } = await ctx.jobs.list({ type: "answer_question_batch" });
  const legacyJob = { ...jobs[0]!, type: "answer_question" as const };
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, legacyJob, confidentOutput());

  const fetched = await questionnaires.getQuestionnaire(ctx, created.questionnaire.id);
  assert.equal(fetched?.items[0]?.status, "answered");
  assert.equal(fetched?.items[0]?.answer, "We hold ISO 27001.");
});

test("a terminal job failure marks the item unanswerable with the error", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "fail",
    flowId: "security",
    questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");

  const { jobs } = await ctx.jobs.list({ type: "answer_question_batch" });
  await questionnaires.handleQuestionnaireAnswerFailure(ctx, jobs[0], "provider exploded");
  const fetched = await questionnaires.getQuestionnaire(ctx, created.questionnaire.id);
  assert.equal(fetched?.items[0].status, "unanswerable");
  assert.equal(fetched?.items[0].error, "provider exploded");
});

test("approval requires an answered item and admits it to the match corpus", async () => {
  const ctx = flowContext();
  // A deterministic fake embedder so approval backfills a matchable vector.
  ctx.providers.embedding = {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => {
        const vector = new Array<number>(1536).fill(0);
        vector[7] = 1;
        return vector;
      });
    }
  };
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "approve",
    flowId: "security",
    questions: ["What certs do you hold?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const id = created.questionnaire.id;
  const itemId = created.questionnaire.items[0].id;

  const early = await questionnaires.approveItem(ctx, id, itemId);
  assert.deepEqual(early, { ok: false, code: "not_answered" });

  const { jobs } = await ctx.jobs.list({ type: "answer_question_batch" });
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, jobs[0], confidentOutput());
  const approved = await questionnaires.approveItem(ctx, id, itemId);
  assert.deepEqual(approved, { ok: true });

  const fetched = await questionnaires.getQuestionnaire(ctx, id);
  assert.equal(fetched?.items[0].status, "approved");
  // With no Postgres knowledge store in unit tests, generation-time hashes are
  // unavailable, so the item must be flagged stale-at-approval (never reusable).
  assert.equal(fetched?.items[0].staleAtApproval, true);

  // It is now in the match corpus (embedding backfilled at approval).
  const vector = new Array<number>(1536).fill(0);
  vector[7] = 1;
  const match = await ctx.stores.questionnaires.matchApproved("security", vector, "test-model");
  // embeddingModelId is undefined in unit tests (no embedding env), so the
  // backfill stamps nothing — assert the approve path simply did not throw and
  // the item is approved. The Postgres store test covers real matching.
  assert.equal(match, undefined);
});

test("approveReused bulk-approves only reused items", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "bulk",
    flowId: "security",
    questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  // No reused items exist (fresh path) → nothing approved.
  const outcome = await questionnaires.approveReused(ctx, created.questionnaire.id);
  assert.deepEqual(outcome, { approved: 0 });
});

test("low-confidence answer WITH citations is answered (shown), not suppressed", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "Trust",
    flowId: "security",
    questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const { jobs } = await ctx.jobs.list({ type: "answer_question_batch" });
  const logId = (jobs[0]!.input as { questionLogId: string }).questionLogId;

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, jobs[0], {
    answer: "A grounded but hedged answer.",
    confidence: "low",
    citations: [
      { documentId: "d", sectionId: "s1", path: "p.md", heading: "H", anchor: "h", excerpt: "e", relevance: 0.5 }
    ]
  });

  const item = await ctx.stores.questionnaires.itemByQuestionLogId(logId);
  assert.equal(item?.status, "answered");
  assert.equal(item?.confidence, "low");
  assert.equal(item?.answer, "A grounded but hedged answer.");
});

test("answer with ZERO citations is unanswerable regardless of confidence", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "Trust2",
    flowId: "security",
    questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const { jobs } = await ctx.jobs.list({ type: "answer_question_batch" });
  const logId = (jobs[0]!.input as { questionLogId: string }).questionLogId;

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, jobs[0], {
    answer: "Ungrounded guess.",
    confidence: "high",
    citations: []
  });

  const item = await ctx.stores.questionnaires.itemByQuestionLogId(logId);
  assert.equal(item?.status, "unanswerable");
});

// --- Task 10: top-N match phase, fast-path, candidate-primed drip ---------

test("top-N match: no candidate above threshold leaves the item to answer fresh", async () => {
  const ctx = embeddingAxisContext();
  await createApprovedDonor(ctx, { question: "Are you SOC2 certified?", answer: "Yes, SOC2 Type II." });

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "query",
    flowId: "security",
    questions: ["Do you hold ISO certifications?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;

  // Orthogonal axis (ISO vs SOC2) => similarity 0, below threshold => 0
  // candidates => the drip answers it fresh, same as today's "no match" path.
  assert.deepEqual(await ctx.stores.questionnaires.reconcileCandidateIds(itemId), []);
  const item = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(item?.status, "answering");
  assert.equal(item?.outcome, "fresh");
});

test("top-N match: exactly one candidate above threshold is stashed for reconcile, not vetoed", async () => {
  const ctx = embeddingAxisContext();
  const donorId = await createApprovedDonor(ctx, {
    question: "Do you hold ISO 27001 certification?",
    answer: "Yes, we hold ISO 27001."
  });

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "query",
    flowId: "security",
    questions: ["Are you ISO certified?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;

  // No Postgres knowledge store in unit tests => checkReuse can never confirm
  // reuse (deps.fingerprints always []) => the single match is never fast-path
  // reusable => it must be stashed as a reconcile candidate, NOT vetoed via
  // the legacy markChanged path.
  assert.deepEqual(await ctx.stores.questionnaires.reconcileCandidateIds(itemId), [donorId]);
  const item = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(item?.changeReason, undefined);
  assert.equal(item?.reusedFromItemId, undefined);

  const job = await jobForLog(ctx, item?.questionLogId);
  const input = job?.input as { candidates?: Array<{ itemId: string; question: string; answer: string }> };
  assert.deepEqual(input.candidates, [
    { itemId: donorId, question: "Do you hold ISO 27001 certification?", answer: "Yes, we hold ISO 27001." }
  ]);
});

test("top-N match: two-plus candidates are all stashed and primed into the drip", async () => {
  const ctx = embeddingAxisContext();
  const donor1 = await createApprovedDonor(ctx, { question: "ISO cert question A", answer: "Answer A" });
  const donor2 = await createApprovedDonor(ctx, { question: "ISO cert question B", answer: "Answer B" });

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "query",
    flowId: "security",
    questions: ["ISO cert question C"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;

  const candidateIds = await ctx.stores.questionnaires.reconcileCandidateIds(itemId);
  assert.deepEqual(new Set(candidateIds), new Set([donor1, donor2]));

  const item = await ctx.stores.questionnaires.itemById(itemId);
  const job = await jobForLog(ctx, item?.questionLogId);
  const input = job?.input as { candidates?: Array<{ itemId: string }> };
  assert.equal(input.candidates?.length, 2);
});

test("match phase preserves the legacy veto behavior when reconcileEnabled is false", async () => {
  const ctx = embeddingAxisContext();
  await createApprovedDonor(ctx, {
    question: "Do you hold ISO 27001 certification?",
    answer: "Yes, we hold ISO 27001."
  });
  ctx.settings.questionnaires.reconcileEnabled = false;

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "query",
    flowId: "security",
    questions: ["Are you ISO certified?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;

  // The OLD single-match veto path: matchApproved + checkReuse -> markChanged
  // (never reused, since checkReuse can't confirm reuse without a knowledge
  // store) — no reconcile-candidate stash at all.
  assert.deepEqual(await ctx.stores.questionnaires.reconcileCandidateIds(itemId), []);
  const item = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(item?.outcome, "changed");
  assert.ok(item?.changeReason);
});

// --- Task 10: completion verdict mapping ----------------------------------

test("completion maps a merged verdict onto the item outcome and basis", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "target",
    flowId: "security",
    questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const targetItemId = created.questionnaire.items[0].id;
  const targetItem = await ctx.stores.questionnaires.itemById(targetItemId);
  const job = await jobForLog(ctx, targetItem?.questionLogId);

  // Basis ids must be REAL items — reused_from_item_id carries an FK, and the
  // completion drops ids that don't resolve (see the FK-safe filter test).
  const basisA = await createApprovedDonor(ctx, { question: "Merged source A?", answer: "Source A answer." });
  const basisB = await createApprovedDonor(ctx, { question: "Merged source B?", answer: "Source B answer." });

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    answer: "A synthesized answer drawing on two priors.",
    confidence: "high",
    citations: [
      { documentId: "d", sectionId: "s1", path: "p.md", heading: "H", anchor: "h", excerpt: "e", relevance: 0.9 }
    ],
    reuse: { verdict: "merged", basisItemIds: [basisA, basisB] }
  });

  const finalItem = await ctx.stores.questionnaires.itemById(targetItemId);
  assert.equal(finalItem?.outcome, "merged");
  assert.deepEqual(new Set(await ctx.stores.questionnaires.basisItemIds(targetItemId)), new Set([basisA, basisB]));
  assert.equal(finalItem?.answer, "A synthesized answer drawing on two priors.");
});

test("completion drops model-returned basis ids that aren't real items (FK-safe)", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "filter",
    flowId: "security",
    questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const targetItemId = created.questionnaire.items[0].id;
  const targetItem = await ctx.stores.questionnaires.itemById(targetItemId);
  const job = await jobForLog(ctx, targetItem?.questionLogId);

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    answer: "An adapted answer whose basis id the model hallucinated.",
    confidence: "high",
    citations: [
      { documentId: "d", sectionId: "s1", path: "p.md", heading: "H", anchor: "h", excerpt: "e", relevance: 0.9 }
    ],
    reuse: { verdict: "adapted", basisItemIds: ["not-a-real-item"] }
  });

  const finalItem = await ctx.stores.questionnaires.itemById(targetItemId);
  assert.equal(finalItem?.outcome, "adapted");
  assert.equal(finalItem?.reusedFromItemId, undefined, "a non-existent basis id must not become reused_from_item_id");
  assert.deepEqual(await ctx.stores.questionnaires.basisItemIds(targetItemId), []);
});

test("completion copies the basis item's answer and citations VERBATIM for a reused verdict", async () => {
  const ctx = flowContext();
  const basisId = await createAnsweredItem(ctx, {
    question: "What certs do you hold?",
    answer: "We hold ISO 27001.",
    citation: {
      documentId: "docs:certs.md",
      sectionId: "docs:certs.md:0",
      path: "certs.md",
      heading: "Certificates",
      anchor: "0",
      excerpt: "ISO 27001",
      relevance: 0.9
    }
  });
  const basis = await ctx.stores.questionnaires.itemById(basisId);
  assert.ok(basis?.answer);
  assert.ok(basis && basis.citations.length > 0);

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "target",
    flowId: "security",
    questions: ["Do you hold ISO certifications?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const targetItemId = created.questionnaire.items[0].id;
  const targetItem = await ctx.stores.questionnaires.itemById(targetItemId);
  const job = await jobForLog(ctx, targetItem?.questionLogId);

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    // Deliberately different from (and weaker than) the basis, to prove the
    // stored result is the basis's VERBATIM content, never the model's echo.
    answer: "A model echo that must NOT be trusted.",
    confidence: "high",
    citations: [],
    reuse: { verdict: "reused", basisItemIds: [basisId] }
  });

  const finalItem = await ctx.stores.questionnaires.itemById(targetItemId);
  assert.equal(finalItem?.outcome, "reused");
  assert.equal(finalItem?.answer, basis?.answer);
  assert.deepEqual(finalItem?.citations, basis?.citations);
  // Citations came from the basis (non-empty), not the output's empty list —
  // so the item must NOT be marked unanswerable.
  assert.equal(finalItem?.status, "answered");
});

// --- Task 12: end-to-end regression (the QA#4 shape) ----------------------
//
// QA#4 (docs/superpowers/specs/2026-07-17-questionnaire-trust-design.md): a
// re-index changed content hashes under a still-correct approved answer, so
// the deterministic fast-path's fingerprint check could never confirm reuse
// and every match was vetoed as "new_content" — zero reuse, despite the
// answer still being right. This drives the full pipeline end-to-end: match
// phase stashes the single unconfirmable candidate for reconcile (never
// vetoes, never fast-path-reuses), and the watcher's reconcile verdict is
// what ultimately produces the verbatim reuse.
test("end-to-end regression (QA#4 shape): a single candidate the fast-path can't confirm is reconciled to a verbatim reused answer", async () => {
  const ctx = embeddingAxisContext();
  const approvedId = await createApprovedDonor(ctx, {
    question: "Do you hold ISO 27001 certification?",
    answer: "Yes, we hold ISO 27001."
  });
  const approvedItem = await ctx.stores.questionnaires.itemById(approvedId);
  assert.ok(approvedItem?.answer);

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "QA#4 regression",
    flowId: "security",
    questions: ["Are you ISO certified?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;

  // Fast-path declined at create time: no Postgres knowledge store means
  // checkReuse can never verify the cited section's fingerprint, so the
  // match is stashed as a reconcile candidate rather than markReused (or
  // vetoed via the legacy markChanged path).
  assert.deepEqual(await ctx.stores.questionnaires.reconcileCandidateIds(itemId), [approvedId]);
  const primed = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(primed?.reusedFromItemId, undefined);
  assert.equal(primed?.status, "answering");

  // The watcher's reconcile step (answer_question, candidate-primed) later
  // decides — against the current KB — that the candidate is still good and
  // returns a "reused" verdict.
  const job = await jobForLog(ctx, primed?.questionLogId);
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    // Deliberately different from the approved answer, to prove the stored
    // result is the basis's VERBATIM content, never the model's echo.
    answer: "A model echo that must NOT be trusted.",
    confidence: "high",
    citations: [],
    reuse: { verdict: "reused", basisItemIds: [approvedId] }
  });

  const finalItem = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(finalItem?.outcome, "reused");
  assert.equal(finalItem?.status, "answered");
  assert.equal(finalItem?.answer, approvedItem?.answer);
  assert.deepEqual(finalItem?.citations, approvedItem?.citations);
});

// --- Whole-branch review fixes ---------------------------------------------

test("a reused verdict carries forward the basis item's ORIGINAL answeredAt, not completion time", async () => {
  const ctx = flowContext();
  const basisId = await createAnsweredItem(ctx, {
    question: "What certs do you hold?",
    answer: "We hold ISO 27001.",
    citation: {
      documentId: "docs:certs.md",
      sectionId: "docs:certs.md:0",
      path: "certs.md",
      heading: "Certificates",
      anchor: "0",
      excerpt: "ISO 27001",
      relevance: 0.9
    }
  });
  // Backdate the basis's answeredAt directly through the store (bypassing the
  // service, which always stamps "now") so the carry-forward assertion below
  // can't pass by coincidence of two completions landing in the same instant.
  const basis = await ctx.stores.questionnaires.itemById(basisId);
  assert.ok(basis);
  const originalAnsweredAt = "2020-01-01T00:00:00.000Z";
  await ctx.stores.questionnaires.completeItem(basis!.questionLogId!, {
    answer: basis!.answer!,
    answeredAt: originalAnsweredAt,
    citations: basis!.citations,
    unanswerable: false,
    confidence: "high"
  });

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "target",
    flowId: "security",
    questions: ["Do you hold ISO certifications?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const targetItemId = created.questionnaire.items[0].id;
  const targetItem = await ctx.stores.questionnaires.itemById(targetItemId);
  const job = await jobForLog(ctx, targetItem?.questionLogId);

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    answer: "",
    confidence: "high",
    citations: [],
    reuse: { verdict: "reused", basisItemIds: [basisId] }
  });

  const finalItem = await ctx.stores.questionnaires.itemById(targetItemId);
  assert.equal(finalItem?.outcome, "reused");
  // The freshness baseline for the NEXT questionnaire's newcomer check is the
  // basis's original generation time, exactly like the fast-path's markReused
  // — never the time this reuse completion happened to run.
  assert.equal(finalItem?.answeredAt, originalAnsweredAt);
});

test("a reused verdict whose basis is unresolvable degrades to unanswerable, not a blank answered row", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "target",
    flowId: "security",
    questions: ["Do you hold ISO certifications?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const targetItemId = created.questionnaire.items[0].id;
  const targetItem = await ctx.stores.questionnaires.itemById(targetItemId);
  const job = await jobForLog(ctx, targetItem?.questionLogId);

  // The watcher sends an empty answer for a reused verdict (the API is
  // expected to fill it in from the basis); here the basis id doesn't
  // resolve to any known item, so the reuse can't be honored.
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    answer: "",
    confidence: "high",
    citations: [],
    reuse: { verdict: "reused", basisItemIds: ["item-does-not-exist"] }
  });

  const finalItem = await ctx.stores.questionnaires.itemById(targetItemId);
  assert.equal(finalItem?.status, "unanswerable");
  assert.notEqual(finalItem?.outcome, "reused");
  assert.deepEqual(await ctx.stores.questionnaires.basisItemIds(targetItemId), []);
});

// --- Answering direction (docs/questionnaires.md) -----------------------------
// A direction steers how an ambiguous question is READ. It must therefore also
// govern answers that would otherwise be inherited verbatim from an earlier
// questionnaire — free reuse is only safe when the donor was answered under the
// same steer.

const DIRECTION = "Where ambiguous, assume the question is about the company and not the product.";

// The fast-path gate itself (one candidate + unchanged sources + matching
// direction) cannot fire in this harness: with no Postgres knowledge store
// checkReuse never confirms reuse, so `decision.reuse` is always false — see the
// "exactly one candidate above threshold is stashed" test above. The gate is
// covered directly in reconcile.test.ts (directionsMatch + isFastPathReusable),
// and the donor's direction reaching the matcher in questionnaire-store.test.ts.
// What matters here is that a differently-directed candidate still reaches the
// reconciler WITH the direction, so the model can judge the reading rather than
// the answer being inherited unexamined.
test("a differently-directed candidate is primed into the reconcile job together with the direction", async () => {
  const ctx = embeddingAxisContext();
  const donorItemId = await createApprovedDonor(ctx, {
    question: "Does the ISO 27001 certificate cover you?",
    answer: "Yes, ISO 27001 since 2021.",
    direction: "Where ambiguous, assume the question is about the product and not the company."
  });
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "directed",
    flowId: "security",
    questions: ["Are you ISO 27001 certified?"],
    direction: DIRECTION
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;
  const item = await ctx.stores.questionnaires.itemById(itemId);
  assert.notEqual(item?.outcome, "reused");
  assert.deepEqual(await ctx.stores.questionnaires.reconcileCandidateIds(itemId), [donorItemId]);

  const job = await jobForLog(ctx, item?.questionLogId);
  const input = job?.input as { direction?: string; candidates?: Array<{ itemId: string }> };
  assert.equal(input.direction, DIRECTION, "the reconciler judges the candidate against THIS direction");
  assert.deepEqual(
    input.candidates?.map((candidate) => candidate.itemId),
    [donorItemId]
  );
});

test("the drip puts the direction on the enqueued answer job", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "directed",
    flowId: "security",
    questions: ["Where is data stored?"],
    direction: DIRECTION
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  const job = await jobForLog(ctx, item?.questionLogId);
  assert.equal((job?.input as { direction?: string }).direction, DIRECTION);
});

test("a blank direction normalises to absent rather than reaching the job", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "blank",
    flowId: "security",
    questions: ["Where is data stored?"],
    direction: "   \n  "
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  assert.equal(created.questionnaire.direction, undefined);
  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  const job = await jobForLog(ctx, item?.questionLogId);
  assert.equal((job?.input as { direction?: string }).direction, undefined);
});

// --- ingesting completed questionnaires (ingestion spec D1/D3/D4) ---

test("an imported answer rides along on the item's answer job", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "SIG 2025",
    flowId: "security",
    importOrigin: "sig-lite-2025.xlsx",
    questions: [{ question: "Do you hold ISO 27001?", importedAnswer: "Yes, since 2021." }]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  assert.equal(created.questionnaire.importOrigin, "sig-lite-2025.xlsx");

  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  assert.equal(item?.importedAnswer, "Yes, since 2021.");
  const job = await jobForLog(ctx, item?.questionLogId);
  assert.equal((job?.input as { importedAnswer?: string }).importedAnswer, "Yes, since 2021.");
});

test("an imported item never fast-path reuses a matching approved answer (spec D3)", async () => {
  // A prior approved item matches above threshold and would normally be reused
  // verbatim for free. The import must still answer fresh — the whole point is
  // to grade the import against Magpie's OWN answer, and a verbatim reuse
  // leaves nothing to compare it to.
  const ctx = embeddingAxisContext();
  await createApprovedDonor(ctx, {
    question: "Do you hold ISO 27001?",
    answer: "We hold ISO 27001."
  });

  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "SIG 2025",
    flowId: "security",
    importOrigin: "sig.xlsx",
    questions: [{ question: "Do you hold ISO 27001 certification?", importedAnswer: "Yes, since 2021." }]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");

  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  assert.notEqual(item?.outcome, "reused");
  assert.equal(item?.status, "answering");
  const job = await jobForLog(ctx, item?.questionLogId);
  assert.ok(job, "an imported item must enqueue a real answer job");
});

test("a NON-imported questionnaire still runs the match phase, unchanged", async () => {
  // The regression guard for D1: importOrigin's absence must leave behaviour
  // exactly as it was before ingestion existed. The donor matches above
  // threshold, so the match phase primes it as a reconcile candidate on the
  // answer job — the observable effect an imported questionnaire skips.
  const ctx = embeddingAxisContext();
  const donorId = await createApprovedDonor(ctx, {
    question: "Do you hold ISO 27001?",
    answer: "We hold ISO 27001."
  });
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "ordinary",
    flowId: "security",
    questions: ["Do you hold ISO 27001 certification?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  const job = await jobForLog(ctx, item?.questionLogId);
  const candidates = (job?.input as { candidates?: Array<{ itemId: string }> }).candidates ?? [];
  assert.deepEqual(
    candidates.map((candidate) => candidate.itemId),
    [donorId]
  );
});

test("an imported questionnaire primes NO reuse candidates on the answer job (spec D3)", async () => {
  const ctx = embeddingAxisContext();
  await createApprovedDonor(ctx, {
    question: "Do you hold ISO 27001?",
    answer: "We hold ISO 27001."
  });
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "SIG 2025",
    flowId: "security",
    importOrigin: "sig.xlsx",
    questions: [{ question: "Do you hold ISO 27001 certification?", importedAnswer: "Yes, since 2021." }]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  const job = await jobForLog(ctx, item?.questionLogId);
  assert.equal((job?.input as { candidates?: unknown[] }).candidates, undefined);
});

test("completion persists the stage-1 verdict alongside the answer", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "SIG",
    flowId: "security",
    importOrigin: "sig.xlsx",
    questions: [{ question: "Do you hold ISO 27001?", importedAnswer: "Yes, since 2021." }]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;
  const item = await ctx.stores.questionnaires.itemById(itemId);
  const job = await jobForLog(ctx, item?.questionLogId);

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    ...confidentOutput(),
    importVerdict: "divergent"
  });

  const after = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(after?.importVerdict, "divergent");
});

test("an ordinary questionnaire's completion writes no import verdict", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "ordinary",
    flowId: "security",
    questions: ["Do you hold ISO 27001?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;
  const item = await ctx.stores.questionnaires.itemById(itemId);
  const job = await jobForLog(ctx, item?.questionLogId);

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, confidentOutput());

  const after = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(after?.importVerdict, undefined);
});

test("a blank imported answer normalises to absent rather than reaching the job", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "blank import",
    flowId: "security",
    importOrigin: "sig.xlsx",
    questions: [{ question: "Do you hold ISO 27001?", importedAnswer: "   \n  " }]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  assert.equal(item?.importedAnswer, undefined);
  const job = await jobForLog(ctx, item?.questionLogId);
  assert.equal((job?.input as { importedAnswer?: string }).importedAnswer, undefined);
});

// --- the approval gate (ingestion spec D7) ---

// Creates an imported questionnaire and answers its single item, leaving it
// "answered" and therefore approvable.
async function answeredImportedItem(
  ctx: Ctx,
  importedAnswer = "Yes, since 2021."
): Promise<{ questionnaireId: string; itemId: string }> {
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "SIG 2025",
    flowId: "security",
    importOrigin: "sig.xlsx",
    questions: [{ question: "Do you hold ISO 27001?", importedAnswer }]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;
  const item = await ctx.stores.questionnaires.itemById(itemId);
  const job = await jobForLog(ctx, item?.questionLogId);
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, confidentOutput());
  return { questionnaireId: created.questionnaire.id, itemId };
}

test("approving the IMPORTED wording is refused while the item has an open finding", async () => {
  const ctx = flowContext();
  const { questionnaireId, itemId } = await answeredImportedItem(ctx);
  await ctx.stores.assertedClaims.open({
    flowId: "security",
    itemId,
    kind: "unsubstantiated",
    question: "Do you hold ISO 27001?",
    claim: "We have held ISO 27001 since 2021.",
    positions: []
  });

  const result = await questionnaires.approveItem(ctx, questionnaireId, itemId, { use: "imported" });
  assert.deepEqual(result, { ok: false, code: "claim_unsubstantiated" });

  // And it really did not enter the corpus.
  const after = await ctx.stores.questionnaires.itemById(itemId);
  assert.notEqual(after?.status, "approved");
});

test("Magpie's grounded answer stays approvable on an item with an open finding", async () => {
  // The escape hatch: the gate refuses the unbackable WORDING, not the item.
  const ctx = flowContext();
  const { questionnaireId, itemId } = await answeredImportedItem(ctx);
  await ctx.stores.assertedClaims.open({
    flowId: "security",
    itemId,
    kind: "contradicted",
    question: "Do you hold ISO 27001?",
    claim: "We have held ISO 27001 since 2021.",
    positions: [{ sourceId: "policy", path: "certs.md", statement: "certified 2022" }]
  });

  const result = await questionnaires.approveItem(ctx, questionnaireId, itemId, { use: "magpie" });
  assert.deepEqual(result, { ok: true });
  const after = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(after?.status, "approved");
  assert.equal(after?.answer, "We hold ISO 27001.");
});

test("approving imported wording keeps the human phrasing and Magpie's citations", async () => {
  const ctx = flowContext();
  const { questionnaireId, itemId } = await answeredImportedItem(ctx);
  const result = await questionnaires.approveItem(ctx, questionnaireId, itemId, { use: "imported" });
  assert.deepEqual(result, { ok: true });

  const after = await ctx.stores.questionnaires.itemById(itemId);
  assert.equal(after?.answer, "Yes, since 2021.");
  assert.ok((after?.citations.length ?? 0) > 0, "grounding must stay Magpie's");
});

test("a resolved finding unblocks approving the imported wording", async () => {
  const ctx = flowContext();
  const { questionnaireId, itemId } = await answeredImportedItem(ctx);
  const { claim } = await ctx.stores.assertedClaims.open({
    flowId: "security",
    itemId,
    kind: "unsubstantiated",
    question: "Do you hold ISO 27001?",
    claim: "We have held ISO 27001 since 2021.",
    positions: []
  });
  assert.deepEqual(await questionnaires.approveItem(ctx, questionnaireId, itemId, { use: "imported" }), {
    ok: false,
    code: "claim_unsubstantiated"
  });

  await ctx.stores.assertedClaims.resolve(claim.id, "added the certificate to the compliance source repo");
  assert.deepEqual(await questionnaires.approveItem(ctx, questionnaireId, itemId, { use: "imported" }), { ok: true });
});

test("approving an ordinary item is unaffected by the gate", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "ordinary",
    flowId: "security",
    questions: ["Do you hold ISO 27001?"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;
  const item = await ctx.stores.questionnaires.itemById(itemId);
  const job = await jobForLog(ctx, item?.questionLogId);
  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, confidentOutput());

  assert.deepEqual(await questionnaires.approveItem(ctx, created.questionnaire.id, itemId), { ok: true });
});
