import { test } from "node:test";
import assert from "node:assert/strict";
import type { Questionnaire } from "@magpie/core";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and
// we exercise the endpoints' shape directly (the seed routes test's model).

function flowContext() {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "security", name: "Security", sourceIds: [], destinationId: "kb" }];
  return ctx;
}

function createRequest(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.request("/api/questionnaires", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("POST /api/questionnaires creates a batch and starts the drip", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const res = await createRequest(app, {
    name: "Acme SIG Q3",
    flowId: "security",
    questions: ["What certs do you hold?", "Where is data stored?"]
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { questionnaire: Questionnaire };
  assert.equal(body.questionnaire.name, "Acme SIG Q3");
  assert.equal(body.questionnaire.items.length, 2);

  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
  assert.equal(jobs.length, 2, "both items fit inside the drip cap");
});

test("POST /api/questionnaires 404s an unknown flow and 400s an empty body", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const unknown = await createRequest(app, { name: "x", flowId: "nope", questions: ["q"] });
  assert.equal(unknown.status, 404);

  const invalid = await createRequest(app, { name: "x", flowId: "security", questions: [] });
  assert.equal(invalid.status, 400);
});

test("GET list and worksheet detail round-trip; unknown ids 404", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const created = await createRequest(app, { name: "list me", flowId: "security", questions: ["q0"] });
  const { questionnaire } = (await created.json()) as { questionnaire: Questionnaire };

  const list = await app.request("/api/questionnaires");
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as { questionnaires: Array<{ id: string; counts: { total: number } }> };
  const summary = listBody.questionnaires.find((entry) => entry.id === questionnaire.id);
  assert.equal(summary?.counts.total, 1);

  const detail = await app.request(`/api/questionnaires/${questionnaire.id}`);
  assert.equal(detail.status, 200);

  const missing = await app.request("/api/questionnaires/no-such-id");
  assert.equal(missing.status, 404);
});

test("approve endpoints enforce answered-state; export streams markdown and csv", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const created = await createRequest(app, { name: "approve", flowId: "security", questions: ["q0"] });
  const { questionnaire } = (await created.json()) as { questionnaire: Questionnaire };
  const itemId = questionnaire.items[0].id;

  // Pending item → 409.
  const early = await app.request(`/api/questionnaires/${questionnaire.id}/items/${itemId}/approve`, {
    method: "POST"
  });
  assert.equal(early.status, 409);

  const bulk = await app.request(`/api/questionnaires/${questionnaire.id}/approve-reused`, { method: "POST" });
  assert.equal(bulk.status, 200);
  assert.deepEqual(await bulk.json(), { approved: 0 });

  const markdown = await app.request(`/api/questionnaires/${questionnaire.id}/export?format=md`);
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(await markdown.text(), /# approve/);

  const csv = await app.request(`/api/questionnaires/${questionnaire.id}/export?format=csv`);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(await csv.text(), /position,question,answer,status/);

  const bad = await app.request(`/api/questionnaires/${questionnaire.id}/export?format=xlsx`);
  assert.equal(bad.status, 400);
});
