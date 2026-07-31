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

test("a healthy verdict produces no finding but still counts as checked", async () => {
  const ctx = makeTestContext();
  const { findings, checkedPaths } = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({})
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(checkedPaths, ["a.md"], "a healthy verdict is a real check, so the doc is gate-eligible");
});

test("an unprovable verdict with no overlapping PR yields an open-new finding", async () => {
  const ctx = makeTestContext();
  const { findings, checkedPaths } = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({ "a.md": UNPROVABLE })
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "a.md");
  assert.equal(findings[0].decision, "open-new");
  assert.equal(findings[0].claims.length, 1);
  assert.deepEqual(checkedPaths, ["a.md"]);
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

  const { findings } = await runVerifyLens(ctx, {
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
  const { findings, checkedPaths } = await runVerifyLens(ctx, {
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
  assert.deepEqual(checkedPaths, ["good.md"], "the doc whose verify threw is not counted as checked");
});

test("a verifier that returns undefined does not count the doc as checked", async () => {
  const ctx = makeTestContext();
  const verifyDocument: VerifyDocumentFn = async () => undefined;
  const { findings, checkedPaths } = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(checkedPaths, [], "a doc whose verify did not complete stays re-checkable");
});

const CONFLICT = {
  topic: "log retention period",
  summary: "One source states 1 year, another enforces 60 days.",
  anchor: "logging-retention",
  claim: "Logs are retained for 1 year.",
  positions: [
    { sourceId: "policy", path: "security/logging.md", statement: "retained for 1 year" },
    { sourceId: "ingest", path: "src/retention.ts", statement: "RETENTION_DAYS = 60" }
  ]
};

test("a conflicted claim never becomes a corrective finding", async () => {
  // The regression this whole feature exists for: routing a source disagreement
  // into correct_document rewrites the doc to one side, silently picking a
  // winner between two sources.
  const ctx = makeTestContext();
  const { findings, conflicts, checkedPaths } = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({ "a.md": { verdict: "healthy", claims: [], conflicts: [CONFLICT] } })
  });
  assert.deepEqual(findings, [], "a conflict must not produce a corrective intent");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, "a.md");
  assert.equal(conflicts[0].topic, "log retention period");
  assert.deepEqual(checkedPaths, ["a.md"], "conflict-only docs are still genuinely checked");
});

test("a stale claim and a conflict in one document produce both outcomes", async () => {
  // Per-claim granularity: one unresolved conflict must not freeze the rest of
  // the document's corrective work.
  const ctx = makeTestContext();
  const { findings, conflicts } = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({
      "a.md": { verdict: "unprovable", claims: UNPROVABLE.claims, conflicts: [CONFLICT] }
    })
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].claims.length, 1);
  assert.equal(conflicts.length, 1);
});

test("resolved conflicts are carried out of the lens with their document", async () => {
  const ctx = makeTestContext();
  const { resolved } = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({
      "a.md": {
        verdict: "healthy",
        claims: [],
        resolvedConflicts: [{ id: "c1", agreedStatement: "Logs are retained for 60 days." }]
      }
    })
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, "c1");
  assert.equal(resolved[0].path, "a.md");
});

test("a document with no conflicts yields empty conflict arrays", async () => {
  const ctx = makeTestContext();
  const { conflicts, resolved } = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({})
  });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(resolved, []);
});
