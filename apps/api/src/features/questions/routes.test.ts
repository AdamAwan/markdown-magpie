import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AnswerResult } from "@magpie/core";
import type { Principal } from "@magpie/auth";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";
import { onError } from "../../http/errors.js";
import { questionRoutes } from "./routes.js";

// An answer that raises a single auto gap, so the logged question seeds a gap
// (and can be assigned to a cluster) for the scrub tests.
const secretGapAnswer: AnswerResult = {
  answer: "…",
  confidence: "low",
  citations: [],
  gaps: [{ summary: "secret topic", question: "q?", confidence: "low", citedSectionIds: [], source: "auto" }]
};

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

test("GET /api/questions?q= searches the whole history and pages within the matches", async () => {
  const ctx = makeTestContext();
  for (let index = 0; index < 6; index += 1) {
    await ctx.stores.questionLogs.record({
      question: index % 2 === 0 ? `How do I deploy service ${index}?` : `What is widget ${index}?`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });
  }
  const app = buildApp(ctx);

  const res = await app.request("/api/questions?q=DEPLOY&limit=2");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { questions: Array<{ question: string }>; total: number; matching: number };
  assert.equal(body.questions.length, 2, "matches page at the requested limit");
  assert.ok(
    body.questions.every((item) => item.question.toLowerCase().includes("deploy")),
    "only matching questions are returned (case-insensitive)"
  );
  assert.equal(body.matching, 3, "matching counts the filtered set for the pager");
  assert.equal(body.total, 6, "total stays the unfiltered backlog for the sidebar badge");

  const secondPage = await app.request("/api/questions?q=deploy&limit=2&offset=2");
  const secondBody = (await secondPage.json()) as { questions: unknown[]; matching: number };
  assert.equal(secondBody.questions.length, 1, "offset pages within the matches, not the backlog");
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

test("DELETE /api/questions/:id (no scrub) removes the question and reports it", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "here is my API key sk-123",
    chatProvider: "codex",
    retrievedSectionIds: [],
    answer: secretGapAnswer
  });
  const app = buildApp(ctx);

  const res = await app.request(`/api/questions/${log.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { deleted: { question: boolean; gaps: number; proposals: number }; warnings: [] };
  assert.equal(body.deleted.question, true);
  assert.equal(body.deleted.gaps, 1);
  assert.equal(body.deleted.proposals, 0, "no scrub → downstream untouched");
  assert.deepEqual(body.warnings, []);
  assert.equal(await ctx.stores.questionLogs.get(log.id), undefined, "the question is gone");
});

test("DELETE /api/questions/:id returns 404 for an unknown question", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/questions/nope", { method: "DELETE" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "question_not_found" });
});

test("DELETE ?scrub=true dismisses an emptied cluster and scrubs its label", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "sensitive",
    chatProvider: "codex",
    retrievedSectionIds: [],
    answer: secretGapAnswer
  });
  const [gapId] = await ctx.stores.questionLogs.gapIdsForQuestion(log.id);
  const cluster = await ctx.stores.gapClusters.createCluster({ title: "secret topic", revision: 1 });
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId!);
  const app = buildApp(ctx);

  const res = await app.request(`/api/questions/${log.id}?scrub=true`, { method: "DELETE" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { deleted: { clustersDismissed: number; clustersRecomputed: number } };
  assert.equal(body.deleted.clustersDismissed, 1);
  assert.equal(body.deleted.clustersRecomputed, 0);

  const after = await ctx.stores.gapClusters.getCluster(cluster.id);
  assert.equal(after?.status, "dismissed", "an emptied cluster leaves the active set");
  assert.equal(after?.title, "[scrubbed]", "no question-derived label survives");
});

test("DELETE ?scrub=true clears the representative of a still-populated cluster", async () => {
  const ctx = makeTestContext();
  const target = await ctx.stores.questionLogs.record({
    question: "sensitive",
    chatProvider: "codex",
    retrievedSectionIds: [],
    answer: secretGapAnswer
  });
  // A second question keeps the cluster populated after the target is deleted.
  const survivor = await ctx.stores.questionLogs.record({
    question: "unrelated but same topic",
    chatProvider: "codex",
    retrievedSectionIds: [],
    answer: secretGapAnswer
  });
  const [targetGap] = await ctx.stores.questionLogs.gapIdsForQuestion(target.id);
  const [survivorGap] = await ctx.stores.questionLogs.gapIdsForQuestion(survivor.id);
  const cluster = await ctx.stores.gapClusters.createCluster({
    title: "secret topic",
    revision: 1,
    representativeEmbedding: [0.1, 0.2, 0.3]
  });
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, targetGap!);
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, survivorGap!);
  const app = buildApp(ctx);

  const res = await app.request(`/api/questions/${target.id}?scrub=true`, { method: "DELETE" });
  const body = (await res.json()) as { deleted: { clustersDismissed: number; clustersRecomputed: number } };
  assert.equal(body.deleted.clustersDismissed, 0);
  assert.equal(body.deleted.clustersRecomputed, 1);

  const after = await ctx.stores.gapClusters.getCluster(cluster.id);
  assert.equal(after?.status, "active", "still-populated cluster stays active");
  assert.equal(after?.representativeEmbedding, undefined, "representative cleared for lazy recompute");
});

test("DELETE ?scrub=true deletes unpublished proposals and warns on published ones", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "sensitive",
    chatProvider: "codex",
    retrievedSectionIds: [],
    answer: secretGapAnswer
  });
  const draft = await ctx.stores.proposals.create({
    title: "Draft doc",
    targetPath: "draft.md",
    markdown: "# body with the secret",
    rationale: "r",
    evidence: [],
    triggeringQuestionIds: [log.id]
  });
  const published = await ctx.stores.proposals.create({
    title: "Published doc",
    targetPath: "published.md",
    markdown: "# body",
    rationale: "r",
    evidence: [],
    triggeringQuestionIds: [log.id]
  });
  await ctx.stores.proposals.recordPublication(published.id, {
    provider: "local-git",
    branchName: "magpie/proposal-x",
    commitSha: "abc123",
    pullRequestUrl: "https://example.com/pr/1",
    publishedAt: new Date().toISOString()
  });
  const app = buildApp(ctx);

  const res = await app.request(`/api/questions/${log.id}?scrub=true`, { method: "DELETE" });
  const body = (await res.json()) as {
    deleted: { proposals: number };
    warnings: Array<{ proposalId: string; pullRequestUrl?: string; status: string }>;
  };
  assert.equal(body.deleted.proposals, 1, "the unpublished draft is deleted");
  assert.equal(await ctx.stores.proposals.get(draft.id), undefined);
  assert.equal(body.warnings.length, 1, "the published proposal is warned about, not deleted");
  assert.equal(body.warnings[0]?.proposalId, published.id);
  assert.equal(body.warnings[0]?.pullRequestUrl, "https://example.com/pr/1");
  assert.ok(await ctx.stores.proposals.get(published.id), "the published proposal is left intact");
});

test("DELETE /api/questions/:id requires the manage:admin scope", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "sensitive",
    chatProvider: "codex",
    retrievedSectionIds: []
  });

  function appFor(principal: Principal): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("authRequired", true);
      c.set("principal", principal);
      await next();
    });
    app.route("/questions", questionRoutes(ctx));
    app.onError(onError);
    return app;
  }

  const forbidden = await appFor({ subject: "auth0|t", scopes: ["read:knowledge"], roles: undefined, payload: {} }).request(
    `/questions/${log.id}`,
    { method: "DELETE" }
  );
  assert.equal(forbidden.status, 403, "read:knowledge is not enough to purge a question");
  assert.ok(await ctx.stores.questionLogs.get(log.id), "the question survives a forbidden request");

  const allowed = await appFor({ subject: "auth0|t", scopes: ["manage:admin"], roles: undefined, payload: {} }).request(
    `/questions/${log.id}`,
    { method: "DELETE" }
  );
  assert.equal(allowed.status, 200, "manage:admin may purge");
});
