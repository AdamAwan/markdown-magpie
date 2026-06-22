import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the route shapes directly. These cover the thin orchestration
// endpoint the maintenance watcher POSTs and the execution-context endpoint the
// publication runner GETs.

test("POST /api/source-sync/run with no git sources returns an empty run set", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/source-sync/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { runIds: [] });
});

test("POST /api/source-sync/run tolerates a missing body and a flowId", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/source-sync/run", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { runIds: [] });

  const withFlow = await app.request("/api/source-sync/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "flow-x" })
  });
  assert.equal(withFlow.status, 200);
  assert.deepEqual(await withFlow.json(), { runIds: [] });
});

test("GET /api/source-sync/runs/:id/execution-context returns 404 for an unknown run", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/source-sync/runs/missing/execution-context");
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "source_sync_run_not_found");
});

test("GET /api/source-sync/runs/:id returns 404 for an unknown run", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/source-sync/runs/missing");
  assert.equal(res.status, 404);
});
