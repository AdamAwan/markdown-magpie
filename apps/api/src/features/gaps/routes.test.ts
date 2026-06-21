import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the route shape directly. These cover the thin reconcile endpoint
// the maintenance watcher POSTs.

test("POST /api/gaps/reconcile runs the reconciler and returns ok (default flow)", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /api/gaps/reconcile accepts a flowId and still returns ok", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "flow-x" })
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /api/gaps/reconcile tolerates a missing/empty body", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/gaps/reconcile", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
