import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// exercise the parked-gap human workflow route shapes directly (issue #158).

async function seedParkedQuestion(ctx: ReturnType<typeof makeTestContext>, summary = "How to configure X") {
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordVerificationGap(log.id, { summary, note: "awaiting a human", parked: true });
  return log;
}

test("GET /api/questions pages with limit/offset and reports the unpaginated total", async () => {
  const ctx = makeTestContext();
  for (let index = 0; index < 12; index += 1) {
    await ctx.stores.questionLogs.record({
      question: `Question ${index}?`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });
  }
  const app = buildApp(ctx);

  const first = await app.request("/api/questions");
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { questions: unknown[]; total: number };
  assert.equal(firstBody.questions.length, 12, "default limit of 50 covers the whole backlog");
  assert.equal(firstBody.total, 12);

  const page = await app.request("/api/questions?limit=5&offset=10");
  const pageBody = (await page.json()) as { questions: unknown[]; total: number };
  assert.equal(pageBody.questions.length, 2, "the final partial page is returned");
  assert.equal(pageBody.total, 12, "total stays unpaginated so the console can size its pager");
});

test("GET /api/questions/parked lists parked questions with their note (before /:id)", async () => {
  const ctx = makeTestContext();
  const log = await seedParkedQuestion(ctx);
  const app = buildApp(ctx);

  const res = await app.request("/api/questions/parked");
  assert.equal(res.status, 200, "resolves to the parked handler, not question_not_found");
  const body = (await res.json()) as { questions: Array<{ questionId: string; note?: string }>; proposals: unknown[] };
  assert.equal(body.questions.length, 1);
  assert.equal(body.questions[0]?.questionId, log.id);
  assert.equal(body.questions[0]?.note, "awaiting a human");
  assert.deepEqual(body.proposals, []);
});

test("GET /api/questions/parked surfaces a needs_attention proposal whose triggering question was deleted (#158 M1)", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# body",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: ["deleted-question-id"]
  });
  await ctx.stores.proposals.setClosureStatus(proposal.id, "needs_attention");
  const app = buildApp(ctx);

  const res = await app.request("/api/questions/parked");
  const body = (await res.json()) as { proposals: Array<{ proposalId: string; reason: string }> };
  assert.equal(body.proposals.length, 1, "the missing-log escalation is surfaced");
  assert.equal(body.proposals[0]?.proposalId, proposal.id);
  assert.equal(body.proposals[0]?.reason, "triggering_question_deleted");
});

test("POST /api/questions/:id/gap/retry re-admits a parked question to candidacy", async () => {
  const ctx = makeTestContext();
  const log = await seedParkedQuestion(ctx);
  const app = buildApp(ctx);

  assert.equal((await ctx.stores.questionLogs.listGapCandidates(50)).length, 0, "parked → not a candidate");

  const res = await app.request(`/api/questions/${log.id}/gap/retry`, { method: "POST" });
  assert.equal(res.status, 200);
  const candidates = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.ok(
    candidates.some((c) => c.summary === "How to configure X"),
    "re-admitted after retry"
  );
  assert.ok(!(await ctx.stores.questionLogs.listParkedQuestions(50)).some((p) => p.questionId === log.id));
});

test("POST /api/questions/:id/gap/dismiss abandons the topic", async () => {
  const ctx = makeTestContext();
  const log = await seedParkedQuestion(ctx);
  const app = buildApp(ctx);

  const res = await app.request(`/api/questions/${log.id}/gap/dismiss`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal((await ctx.stores.questionLogs.listGapCandidates(50)).length, 0, "never re-clusters");
  assert.ok(!(await ctx.stores.questionLogs.listParkedQuestions(50)).some((p) => p.questionId === log.id));
});

test("POST /api/questions/:id/gap/retry returns 404 for an unknown question", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/questions/nope/gap/retry", { method: "POST" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "question_not_found" });
});
