import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "./test-support/context.js";
import { buildApp } from "./app.js";

test("GET /api/health returns ok", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "markdown-magpie-api" });
});

test("POST /api/ask with empty question returns 400 question_required", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "" })
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "question_required" });
});

test("unknown route returns not_found", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("OPTIONS preflight returns 204", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/ask", { method: "OPTIONS" });
  assert.equal(res.status, 204);
});

test("GET /api/proposals returns an empty list", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/proposals");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { proposals: [] });
});

test("POST /api/ai-jobs with a bad type returns 400 valid_job_type_required", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/ai-jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "not_a_real_type" })
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "valid_job_type_required" });
});

test("GET /api/questions/bogus returns 404 question_not_found", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/questions/bogus");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "question_not_found" });
});
