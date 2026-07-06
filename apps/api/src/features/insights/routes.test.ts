import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// The test context has no Postgres pool, so ctx.stores.insights is a
// NullInsightsStore: every endpoint returns a well-formed empty envelope. These
// assert the envelope shape and query-param validation without a database.

test("GET /api/insights/gaps/backlog returns an empty series under the null store", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/gaps/backlog?bucket=day");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { series: [] });
});

test("GET /api/insights/answers/latency returns an empty bins envelope", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/answers/latency");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { bins: [] });
});

test("GET /api/insights/answers/latency rejects a malformed from", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/answers/latency?from=not-a-date");
  assert.equal(res.status, 400);
});

test("GET /api/insights/verification/success returns zeroed totals and empty series", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/verification/success?bucket=day");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { totals: { closed: 0, stillOpen: 0 }, series: [] });
});

test("GET /api/insights/verification/success rejects a bad bucket", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/verification/success?bucket=fortnight");
  assert.equal(res.status, 400);
});
