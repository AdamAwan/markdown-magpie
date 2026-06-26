import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import type { VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import type { DedupeDocumentFn } from "../../scheduling/dedupe-lens.js";
import type { SplitDocumentFn } from "../../scheduling/split-lens.js";
import type { DedupeDocumentsJobInput, ImproveDocumentJobInput, SplitDocumentJobInput } from "@magpie/core";
import * as patrol from "./service.js";
import type { CorrectDocumentFn } from "./service.js";

async function indexDocs(ctx: ReturnType<typeof makeTestContext>, paths: string[]): Promise<void> {
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: paths.map((path) => ({ path, content: `# ${path}` }))
  });
}

// Healthy verify + quiet dedupe, so the cursor/run tests stay offline and fast (the
// real deps would enqueue jobs and bounded-wait on the never-completing fake broker).
const HEALTHY_DEPS: {
  verifyDocument: VerifyDocumentFn;
  dedupeDocument: DedupeDocumentFn;
  splitDocument: SplitDocumentFn;
} = {
  verifyDocument: async () => ({ verdict: "healthy", claims: [] }),
  dedupeDocument: async () => {},
  splitDocument: async () => {}
};

test("runFixPatrol checks a batch, stamps the cursor, and records a run", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md", "c.md"]);

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, HEALTHY_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.run.universeCount, 3);
  assert.equal(outcome.run.selectedCount, outcome.run.selected.length);
  assert.ok(outcome.run.selectedCount > 0 && outcome.run.selectedCount <= 3);

  // The selected docs are now stamped in the cursor.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.deepEqual(cursor.map((e) => e.docPath).sort(), [...outcome.run.selected].sort());

  // It is the most recent run, fetchable by id.
  assert.equal((await patrol.listRuns(ctx, 10))[0].id, outcome.run.id);
  assert.equal((await patrol.getRun(ctx, outcome.run.id))?.id, outcome.run.id);
});

test("with a universe no larger than a batch, the cursor covers every document after one tick", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md", "c.md", "d.md", "e.md"]);

  const first = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, HEALTHY_DEPS);
  assert.ok(first.ok);
  assert.equal((await ctx.stores.patrol.listCursor(undefined)).length, 5);
});

test("an unknown flow is rejected without recording a run", async () => {
  const ctx = makeTestContext();
  const outcome = await patrol.runFixPatrol(ctx, { flowId: "ghost", trigger: "scheduled" }, HEALTHY_DEPS);
  assert.deepEqual(outcome, { ok: false, code: "unknown_flow" });
  assert.deepEqual(await patrol.listRuns(ctx, 10), []);
});

test("an empty universe records a zero-selected run", async () => {
  const ctx = makeTestContext();
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, HEALTHY_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.run.universeCount, 0);
  assert.equal(outcome.run.selectedCount, 0);
});

test("runFixPatrol records verify findings for unprovable documents", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const verifyDocument: VerifyDocumentFn = async (_ctx, input) =>
    input.path === "a.md"
      ? { verdict: "unprovable", claims: [{ claim: "stale", reason: "no source" }] }
      : { verdict: "healthy", claims: [] };

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, { verifyDocument, correctDocument: async () => {}, dedupeDocument: async () => {} });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  // Every selected doc is still stamped, regardless of verdict.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.deepEqual(cursor.map((e) => e.docPath).sort(), [...outcome.run.selected].sort());

  // The unprovable doc produced one open-new finding; the healthy one produced none.
  const aFindings = outcome.run.findings.filter((f) => f.path === "a.md");
  assert.equal(aFindings.length, 1);
  assert.equal(aFindings[0].decision, "open-new");
  assert.equal(
    outcome.run.findings.some((f) => f.path === "b.md"),
    false
  );
});

test("runFixPatrol enqueues a correction for each unprovable finding, none for healthy", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const verifyDocument: VerifyDocumentFn = async (_ctx, input) =>
    input.path === "a.md"
      ? { verdict: "unprovable", claims: [{ claim: "stale", reason: "no source" }] }
      : { verdict: "healthy", claims: [] };
  const corrected: Array<{ path: string; claims: number }> = [];
  const correctDocument: CorrectDocumentFn = async (_ctx, input) => {
    corrected.push({ path: input.path, claims: input.claims.length });
  };

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, { verifyDocument, correctDocument, dedupeDocument: async () => {} });
  assert.ok(outcome.ok);
  assert.deepEqual(corrected, [{ path: "a.md", claims: 1 }]);
});

test("runFixPatrol runs the dedupe lens over the batch, enqueuing a scan per doc with a near-duplicate", async () => {
  const ctx = makeTestContext();
  // Two documents that share a heading — the keyword index ranks each as a strong
  // neighbour of the other (heading-term matches clear the similarity bar).
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: [
      { path: "refunds.md", content: "# Refunds Policy Guide\nHow refunds work." },
      { path: "partial-refunds.md", content: "# Refunds Policy Guide\nHow partial refunds work." }
    ]
  });
  const scanned: DedupeDocumentsJobInput[] = [];
  const dedupeDocument: DedupeDocumentFn = async (_ctx, input) => {
    scanned.push(input);
  };

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "scheduled" },
    { verifyDocument: async () => ({ verdict: "healthy", claims: [] }), dedupeDocument }
  );
  assert.ok(outcome.ok);

  // Each doc found the other as a neighbour, so a dedupe scan was enqueued for both.
  assert.deepEqual(
    scanned.map((s) => s.path).sort(),
    ["partial-refunds.md", "refunds.md"]
  );
  const refunds = scanned.find((s) => s.path === "refunds.md");
  assert.deepEqual(
    refunds?.neighbours.map((n) => n.path),
    ["partial-refunds.md"]
  );
  // Verify produced no findings, so dedupe runs independently of the verify path.
  assert.equal(outcome.run.findings.length, 0);
});

test("runFixPatrol runs the split lens over broad selected documents", async () => {
  const ctx = makeTestContext();
  const broadContent =
    "# Customer Operations\n\n" +
    ["Intake", "Triage", "Billing", "Escalations", "Reporting", "Review"]
      .map((heading) => `## ${heading}\nDetails.`)
      .join("\n");
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: [
      { path: "customer-operations.md", content: broadContent },
      { path: "customer-billing.md", content: "# Customer Billing\nDetails." }
    ]
  });
  const scanned: SplitDocumentJobInput[] = [];
  const splitDocument: SplitDocumentFn = async (_ctx, input) => {
    scanned.push(input);
  };

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, { ...HEALTHY_DEPS, splitDocument });
  assert.ok(outcome.ok);

  assert.deepEqual(scanned.map((s) => s.path), ["customer-operations.md"]);
  assert.equal(scanned[0].destinationId, "docs");
  assert.deepEqual(
    scanned[0].neighbours.map((n) => n.path),
    ["customer-billing.md"]
  );
});

test("runImprovePatrol uses its own cursor and enqueues an improve job for every selected doc", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md", "c.md"]);

  const fix = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, HEALTHY_DEPS);
  assert.ok(fix.ok);
  assert.equal((await ctx.stores.patrol.listCursor(undefined)).length, 3, "fix cursor stamped all docs in the small universe");

  const improved: ImproveDocumentJobInput[] = [];
  const outcome = await patrol.runImprovePatrol(ctx, { trigger: "scheduled" }, {
    improveDocument: async (_ctx, input) => {
      improved.push(input);
    }
  });

  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.run.selectedCount, 2, "improve-patrol uses the smaller editorial batch");
  assert.equal(outcome.enqueuedCount, outcome.run.selectedCount);
  assert.deepEqual(
    improved.map((job) => job.path).sort(),
    [...outcome.run.selected].sort()
  );
  assert.deepEqual((await ctx.stores.patrol.listCursor(undefined)).map((e) => e.docPath).sort(), ["a.md", "b.md", "c.md"]);
  assert.deepEqual((await ctx.stores.patrol.listCursor(undefined, "improve")).map((e) => e.docPath).sort(), [...outcome.run.selected].sort());
  assert.ok(improved.every((job) => job.destinationId === "docs"));
});