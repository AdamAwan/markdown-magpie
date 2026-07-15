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

test("GET /api/insights/journey returns an empty graph envelope under the null store", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/journey");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { nodes: [], links: [] });
});

test("GET /api/insights/journey rejects a malformed from", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/journey?from=not-a-date");
  assert.equal(res.status, 400);
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

test("GET /api/insights/jobs/errors returns empty breakdowns under the null store", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/jobs/errors");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { byCategory: [], byType: [] });
});

test("GET /api/insights/jobs/errors rejects a malformed to", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/jobs/errors?to=not-a-date");
  assert.equal(res.status, 400);
});

test("GET /api/insights/freshness returns zeroed document and source splits", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/freshness");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    documents: { fresh: 0, due: 0, overdue: 0 },
    sources: { fresh: 0, stale: 0 }
  });
});

test("GET /api/insights/patrols returns an empty runs envelope under the null store", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/patrols");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { runs: [] });
});

test("GET /api/insights/patrols rejects a malformed from", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/patrols?from=not-a-date");
  assert.equal(res.status, 400);
});

test("GET /api/insights/feedback returns zeroed totals and empty series", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/feedback?bucket=day");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    totals: { helpful: 0, unhelpful: 0, unhelpfulConfident: 0 },
    series: []
  });
});

test("GET /api/insights/feedback rejects a bad bucket", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/feedback?bucket=fortnight");
  assert.equal(res.status, 400);
});

test("GET /api/insights/ai-usage returns an empty usage envelope under the null store", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/ai-usage");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { usage: [] });
});

test("GET /api/insights/ai-usage rejects a malformed from", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/ai-usage?from=not-a-date");
  assert.equal(res.status, 400);
});

test("GET /api/insights/ai-cost/by-flow returns an empty flows envelope under the null store", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/ai-cost/by-flow?flow=flow-1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { flows: [] });
});

test("GET /api/insights/ai-cost/by-flow rejects a malformed from", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/ai-cost/by-flow?from=not-a-date");
  assert.equal(res.status, 400);
});

test("GET /api/insights/ai-cost/by-schedule returns an empty schedules envelope under the null store", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/insights/ai-cost/by-schedule");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { schedules: [] });
});
