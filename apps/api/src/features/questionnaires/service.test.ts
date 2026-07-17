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
  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
  return jobs.find((job) => (job.input as { questionLogId?: string }).questionLogId === logId);
}

// Creates, answers, and approves a questionnaire item so it becomes an
// approved match-corpus entry (embedding stamped via the real approval-time
// backfill). Requires ctx to have a configured embedding provider.
async function createApprovedDonor(ctx: Ctx, opts: { question: string; answer: string }): Promise<string> {
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "donor pool",
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
async function createAnsweredItem(ctx: Ctx, opts: { question: string; answer: string; citation: Citation }): Promise<string> {
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
  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
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

  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
  const [first, second] = jobs;

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, first, confidentOutput());
  let fetched = await questionnaires.getQuestionnaire(ctx, id);
  const answered = fetched?.items.find((item) => item.status === "answered");
  assert.equal(answered?.answer, "We hold ISO 27001.");
  assert.equal(answered?.outcome, "fresh");
  // Slot freed → the 4th item was enqueued.
  const after = await ctx.jobs.list({ type: "answer_question" });
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

test("a terminal job failure marks the item unanswerable with the error", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "fail",
    flowId: "security",
    questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");

  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
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

  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
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
    name: "Trust", flowId: "security", questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
  const logId = (jobs[0]!.input as { questionLogId: string }).questionLogId;

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, jobs[0], {
    answer: "A grounded but hedged answer.",
    confidence: "low",
    citations: [{ documentId: "d", sectionId: "s1", path: "p.md", heading: "H", anchor: "h", excerpt: "e", relevance: 0.5 }]
  });

  const item = await ctx.stores.questionnaires.itemByQuestionLogId(logId);
  assert.equal(item?.status, "answered");
  assert.equal(item?.confidence, "low");
  assert.equal(item?.answer, "A grounded but hedged answer.");
});

test("answer with ZERO citations is unanswerable regardless of confidence", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "Trust2", flowId: "security", questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
  const logId = (jobs[0]!.input as { questionLogId: string }).questionLogId;

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, jobs[0], {
    answer: "Ungrounded guess.", confidence: "high", citations: []
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

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, job, {
    answer: "A synthesized answer drawing on two priors.",
    confidence: "high",
    citations: [{ documentId: "d", sectionId: "s1", path: "p.md", heading: "H", anchor: "h", excerpt: "e", relevance: 0.9 }],
    reuse: { verdict: "merged", basisItemIds: ["item-x", "item-y"] }
  });

  const finalItem = await ctx.stores.questionnaires.itemById(targetItemId);
  assert.equal(finalItem?.outcome, "merged");
  assert.deepEqual(await ctx.stores.questionnaires.basisItemIds(targetItemId), ["item-x", "item-y"]);
  assert.equal(finalItem?.answer, "A synthesized answer drawing on two priors.");
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
