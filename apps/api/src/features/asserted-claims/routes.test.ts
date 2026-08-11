import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

function flowContext(): ReturnType<typeof makeTestContext> {
  return makeTestContext({
    knowledgeConfig: {
      sources: [],
      destinations: [{ id: "docs", name: "Docs", kind: "local", path: "docs" }],
      flows: [{ id: "security", name: "Security", sourceIds: [], destinationId: "docs" }],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

const finding = {
  flowId: "security",
  questionnaireId: "q1",
  itemId: "i1",
  kind: "unsubstantiated" as const,
  question: "Do you hold ISO 27001?",
  claim: "We have held ISO 27001 since 2021.",
  positions: []
};

test("GET lists open findings", async () => {
  const ctx = flowContext();
  await ctx.stores.assertedClaims.open(finding);
  const res = await buildApp(ctx).request("/api/asserted-claims?status=open&flowId=security");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { claims: Array<{ kind: string; claim: string }> };
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0].kind, "unsubstantiated");
});

test("GET filters by flow", async () => {
  const ctx = flowContext();
  await ctx.stores.assertedClaims.open(finding);
  const res = await buildApp(ctx).request("/api/asserted-claims?flowId=other");
  const body = (await res.json()) as { claims: unknown[] };
  assert.equal(body.claims.length, 0);
});

test("PATCH resolves a finding with its note", async () => {
  const ctx = flowContext();
  const { claim } = await ctx.stores.assertedClaims.open(finding);
  const res = await buildApp(ctx).request(`/api/asserted-claims/${claim.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "resolved", note: "added the certificate to the compliance source repo" })
  });
  assert.equal(res.status, 200);
  const stored = await ctx.stores.assertedClaims.get(claim.id);
  assert.equal(stored?.status, "resolved");
  assert.equal(stored?.resolutionNote, "added the certificate to the compliance source repo");
});

test("PATCH dismisses a finding", async () => {
  const ctx = flowContext();
  const { claim } = await ctx.stores.assertedClaims.open(finding);
  const res = await buildApp(ctx).request(`/api/asserted-claims/${claim.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "dismissed", note: "certificate genuinely lapsed; answer withdrawn" })
  });
  assert.equal(res.status, 200);
  assert.equal((await ctx.stores.assertedClaims.get(claim.id))?.status, "dismissed");
});

test("closing a finding without a note is refused", async () => {
  // An entry closed with no reason defeats the register's whole purpose as an
  // audit trail.
  const ctx = flowContext();
  const { claim } = await ctx.stores.assertedClaims.open(finding);
  const res = await buildApp(ctx).request(`/api/asserted-claims/${claim.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "resolved" })
  });
  assert.equal(res.status, 400);
  assert.equal((await ctx.stores.assertedClaims.get(claim.id))?.status, "open");
});

test("an unknown status is rejected", async () => {
  const ctx = flowContext();
  const { claim } = await ctx.stores.assertedClaims.open(finding);
  const res = await buildApp(ctx).request(`/api/asserted-claims/${claim.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "reopened", note: "x" })
  });
  assert.equal(res.status, 400);
});

test("PATCH on an unknown id is a 404", async () => {
  const ctx = flowContext();
  const res = await buildApp(ctx).request("/api/asserted-claims/00000000-0000-0000-0000-000000000000", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "dismissed", note: "x" })
  });
  assert.equal(res.status, 404);
});
