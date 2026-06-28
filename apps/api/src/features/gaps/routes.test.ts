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
