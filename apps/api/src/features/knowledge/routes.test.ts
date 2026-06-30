import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the route shape directly.

test("GET /api/knowledge/flows returns id/name for each configured flow", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb", persona: "Be kind" },
    { id: "eng", name: "Engineering", sourceIds: ["s"], destinationId: "kb2" }
  ];
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/flows");

  assert.equal(res.status, 200);
  // Only id and name are exposed — personas/sources/destinations stay internal.
  assert.deepEqual(await res.json(), {
    flows: [
      { id: "support", name: "Support" },
      { id: "eng", name: "Engineering" }
    ]
  });
});

test("GET /api/knowledge/flows returns an empty list when none are configured", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/flows");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { flows: [] });
});
