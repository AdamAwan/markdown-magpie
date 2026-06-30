import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the route shape directly. These cover the thin reconcile endpoint
// the maintenance watcher POSTs.

test("POST /api/gaps/reconcile returns 400 when flowId is missing", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "flow_id_required" });
});

test("POST /api/gaps/reconcile accepts a configured flowId and returns ok", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "flow-x" })
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /api/gaps/reconcile returns 404 for an unknown flowId", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "missing" })
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "flow_not_found" });
});

test("POST /api/gaps/reconcile returns 400 invalid_json for a malformed body", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid"
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_json" });
});

test("POST /api/gaps/reconcile returns 400 when flowId is whitespace-only", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "   " })
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "flow_id_required" });
});

test("POST /api/gaps/clusters/:id/proposal returns 400 invalid_json for a malformed body", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/clusters/abc/proposal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid"
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_json" });
});

test("POST /api/gaps/clusters/:id/proposal returns 400 for a wrong-typed override", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/clusters/abc/proposal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetPath: 123 })
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_proposal_overrides" });
});

test("POST /api/gaps/clusters/:id/proposal accepts valid overrides and reaches the service", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  // Unknown cluster => the service is reached and returns its 404, proving the
  // valid body passed validation rather than being rejected with a 400.
  const res = await app.request("/api/gaps/clusters/abc/proposal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetPath: "docs/x.md", destinationId: "kb" })
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "cluster_not_found" });
});

test("POST /api/gaps/clusters/:id/proposal allows an empty (default) body", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/clusters/abc/proposal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "cluster_not_found" });
});

test("malformed JSON to a zValidator route returns 400 invalid_json, not 500", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid"
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_json" });
});
