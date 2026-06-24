import { test } from "node:test";
import assert from "node:assert/strict";
import type { VerifyDocumentJobOutput } from "@magpie/core";
import { makeTestContext } from "../test-support/context.js";
import { runVerifyLens, verifyIntent, type VerifyDocumentFn } from "./verify-lens.js";

const HEALTHY: VerifyDocumentJobOutput = { verdict: "healthy", claims: [] };
const UNPROVABLE: VerifyDocumentJobOutput = {
  verdict: "unprovable",
  claims: [{ claim: "Refunds take 5 days", reason: "source says 7" }]
};

function fixedVerifier(byPath: Record<string, VerifyDocumentJobOutput>): VerifyDocumentFn {
  return async (_ctx, input) => byPath[input.path] ?? HEALTHY;
}

test("verifyIntent builds a verify intent targeting the document with claims as evidence", () => {
  const intent = verifyIntent("billing", "kb/a.md", UNPROVABLE.claims);
  assert.equal(intent.lens, "verify");
  assert.equal(intent.flowId, "billing");
  assert.deepEqual(intent.targets, ["kb/a.md"]);
  assert.deepEqual(intent.evidence, ["Refunds take 5 days"]);
});

test("a healthy verdict produces no finding", async () => {
  const ctx = makeTestContext();
  const findings = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({})
  });
  assert.deepEqual(findings, []);
});

test("an unprovable verdict with no overlapping PR yields an open-new finding", async () => {
  const ctx = makeTestContext();
  const findings = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({ "a.md": UNPROVABLE })
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "a.md");
  assert.equal(findings[0].decision, "open-new");
  assert.equal(findings[0].claims.length, 1);
});

test("an unprovable verdict overlapping a touchable open PR folds into it", async () => {
  const ctx = makeTestContext();
  await ctx.stores.proposals.create({
    title: "Refunds",
    targetPath: "a.md",
    markdown: "m",
    rationale: "r",
    evidence: []
  });
  const open = (await ctx.stores.proposals.list(10))[0];
  await ctx.stores.proposals.updateStatus(open.id, "pr-opened");

  const findings = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({ "a.md": UNPROVABLE })
  });
  assert.equal(findings[0].decision, "fold");
  assert.equal(findings[0].intoProposalId, open.id);
});

test("a verifier that throws for one doc skips it and still processes the rest", async () => {
  const ctx = makeTestContext();
  const verifyDocument: VerifyDocumentFn = async (_ctx, input) => {
    if (input.path === "bad.md") throw new Error("model exploded");
    return UNPROVABLE;
  };
  const findings = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [
      { path: "bad.md", content: "x" },
      { path: "good.md", content: "y" }
    ],
    sources: [],
    verifyDocument
  });
  assert.deepEqual(
    findings.map((f) => f.path),
    ["good.md"]
  );
});
