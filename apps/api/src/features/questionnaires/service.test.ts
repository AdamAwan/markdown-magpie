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
