import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the route shapes directly. These cover the thin orchestration
// endpoint the maintenance watcher POSTs and confirm the removed run endpoints
// are no longer mounted.

test("POST /api/source-sync/run with no git sources returns an empty result", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/source-sync/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { maintenanceRunIds: [], proposalIds: [] });
});

test("POST /api/source-sync/run tolerates a missing body and a flowId", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/source-sync/run", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { maintenanceRunIds: [], proposalIds: [] });

  const withFlow = await app.request("/api/source-sync/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "flow-x" })
  });
  assert.equal(withFlow.status, 200);
  assert.deepEqual(await withFlow.json(), { maintenanceRunIds: [], proposalIds: [] });
});

test("retired source-sync run endpoints are not mounted", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  assert.equal((await app.request("/api/source-sync/runs")).status, 404);
  assert.equal((await app.request("/api/source-sync/runs/missing")).status, 404);
  assert.equal((await app.request("/api/source-sync/runs/missing/execution-context")).status, 404);
});
