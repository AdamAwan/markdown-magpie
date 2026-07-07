import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import type { VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import type { DedupeDocumentFn } from "../../scheduling/dedupe-lens.js";
import type { SplitDocumentFn } from "../../scheduling/split-lens.js";
import type {
  DedupeDocumentsJobInput,
  ImproveDocumentJobInput,
  SourceDescriptor,
  SplitDocumentJobInput
} from "@magpie/core";
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

test("runFixPatrol checks a batch, stamps the cursor, and records a maintenance run", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md", "c.md"]);

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, HEALTHY_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.universeCount, 3);
  assert.equal(outcome.selectedCount, outcome.selected.length);
  assert.ok(outcome.selectedCount > 0 && outcome.selectedCount <= 3);

  // The selected docs are now stamped in the cursor.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.deepEqual(cursor.map((e) => e.docPath).sort(), [...outcome.selected].sort());

  // It is recorded as a correctness_patrol maintenance run, fetchable by id.
  const runs = await ctx.stores.maintenanceRuns.list({ limit: 10 });
  assert.equal(runs[0].id, outcome.runId);
  assert.equal(runs[0].taskType, "correctness_patrol");
  assert.equal((await ctx.stores.maintenanceRuns.get(outcome.runId))?.id, outcome.runId);
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
  assert.deepEqual(await ctx.stores.maintenanceRuns.list({ limit: 10 }), []);
});

test("an empty universe records a zero-selected run", async () => {
  const ctx = makeTestContext();
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, HEALTHY_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.universeCount, 0);
  assert.equal(outcome.selectedCount, 0);
  const runs = await ctx.stores.maintenanceRuns.list({ limit: 10 });
  assert.equal(runs[0].status, "completed");
});

test("runFixPatrol records verify findings for unprovable documents", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const verifyDocument: VerifyDocumentFn = async (_ctx, input) =>
    input.path === "a.md"
      ? { verdict: "unprovable", claims: [{ claim: "stale", reason: "no source" }] }
      : { verdict: "healthy", claims: [] };

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "scheduled" },
    { verifyDocument, correctDocument: async () => {}, dedupeDocument: async () => {} }
  );
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  // Every selected doc is still stamped, regardless of verdict.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.deepEqual(cursor.map((e) => e.docPath).sort(), [...outcome.selected].sort());

  // The unprovable doc produced one open-new finding; the healthy one produced none.
  const aFindings = outcome.findings.filter((f) => f.path === "a.md");
  assert.equal(aFindings.length, 1);
  assert.equal(aFindings[0].decision, "open-new");
  assert.equal(
    outcome.findings.some((f) => f.path === "b.md"),
    false
  );

  // The findings and their emitted intents are persisted on the run details for the audit.
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.deepEqual((run?.details as { findings?: unknown }).findings, outcome.findings);
  const traces = (
    run?.details as {
      intentTraces?: Array<{ intent: { lens: string; targets: string[] }; decision: { kind: string } }>;
    }
  ).intentTraces;
  assert.equal(traces?.length, 1);
  assert.equal(traces?.[0].intent.lens, "verify");
  assert.deepEqual(traces?.[0].intent.targets, ["a.md"]);
  assert.equal(traces?.[0].decision.kind, "open-new");
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

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "scheduled" },
    { verifyDocument, correctDocument, dedupeDocument: async () => {} }
  );
  assert.ok(outcome.ok);
  assert.deepEqual(corrected, [{ path: "a.md", claims: 1 }]);
});

test("runFixPatrol projects descriptors once and threads the same sources to verify and correct", async () => {
  const ctx = makeTestContext({
    knowledgeConfig: {
      sources: [
        { id: "repo", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" }
      ],
      destinations: [],
      flows: [],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
  await indexDocs(ctx, ["a.md"]);
  const verifySources: SourceDescriptor[][] = [];
  const correctSources: SourceDescriptor[][] = [];
  const verifyDocument: VerifyDocumentFn = async (_ctx, input) => {
    verifySources.push(input.sources);
    return { verdict: "unprovable", claims: [{ claim: "stale", reason: "no source" }] };
  };
  const correctDocument: CorrectDocumentFn = async (_ctx, input) => {
    correctSources.push(input.sources);
  };

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "scheduled" },
    { verifyDocument, correctDocument, dedupeDocument: async () => {} }
  );
  assert.ok(outcome.ok);
  // Every job in the tick carries the SAME projected descriptor set — references
  // only, no sampled file content.
  const expected = [
    { id: "repo", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" }
  ];
  assert.equal(verifySources.length, 1);
  assert.equal(correctSources.length, 1);
  assert.deepEqual(verifySources[0], expected);
  assert.deepEqual(correctSources[0], expected);
  assert.equal(verifySources[0], correctSources[0], "verify and correct share one projected array");
});

test("runImprovePatrol threads the projected descriptors to every improve scan", async () => {
  const ctx = makeTestContext({
    knowledgeConfig: {
      sources: [
        { id: "repo", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" }
      ],
      destinations: [],
      flows: [],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
  await indexDocs(ctx, ["a.md"]);
  const improved: ImproveDocumentJobInput[] = [];
  const outcome = await patrol.runImprovePatrol(
    ctx,
    { trigger: "scheduled" },
    {
      improveDocument: async (_ctx, input) => {
        improved.push(input);
      }
    }
  );
  assert.ok(outcome.ok);
  assert.equal(improved.length, 1);
  assert.deepEqual(improved[0].sources, [
    { id: "repo", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" }
  ]);
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
  if (!outcome.ok) return;

  // Each doc found the other as a neighbour, so a dedupe scan was enqueued for both.
  assert.deepEqual(scanned.map((s) => s.path).sort(), ["partial-refunds.md", "refunds.md"]);
  const refunds = scanned.find((s) => s.path === "refunds.md");
  assert.deepEqual(
    refunds?.neighbours.map((n) => n.path),
    ["partial-refunds.md"]
  );
  // Verify produced no findings, so dedupe runs independently of the verify path.
  assert.equal(outcome.findings.length, 0);
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

  assert.deepEqual(
    scanned.map((s) => s.path),
    ["customer-operations.md"]
  );
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
  assert.equal(
    (await ctx.stores.patrol.listCursor(undefined)).length,
    3,
    "fix cursor stamped all docs in the small universe"
  );

  const improved: ImproveDocumentJobInput[] = [];
  const outcome = await patrol.runImprovePatrol(
    ctx,
    { trigger: "scheduled" },
    {
      improveDocument: async (_ctx, input) => {
        improved.push(input);
      }
    }
  );

  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.selectedCount, 2, "improve-patrol uses the smaller editorial batch");
  assert.equal(outcome.enqueuedCount, outcome.selectedCount);
  assert.deepEqual(improved.map((job) => job.path).sort(), [...outcome.selected].sort());
  assert.deepEqual((await ctx.stores.patrol.listCursor(undefined)).map((e) => e.docPath).sort(), [
    "a.md",
    "b.md",
    "c.md"
  ]);
  assert.deepEqual(
    (await ctx.stores.patrol.listCursor(undefined, "improve")).map((e) => e.docPath).sort(),
    [...outcome.selected].sort()
  );
  assert.ok(improved.every((job) => job.destinationId === "docs"));

  // The tick is recorded as an editorial_patrol maintenance run.
  const runs = await ctx.stores.maintenanceRuns.list({ taskType: "editorial_patrol", limit: 10 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, outcome.runId);
});

test("runImprovePatrol skips a document already covered by an open same-flow proposal", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["covered.md", "free.md"]);
  // An open proposal already touches covered.md — its change is sitting in an
  // unmerged PR, so re-improving it would just redraft-and-fold every tick.
  await ctx.stores.proposals.create({
    title: "Improve: expand covered.md",
    targetPath: "covered.md",
    markdown: "# covered.md\nexpanded",
    rationale: "thin",
    evidence: []
  });

  const improved: ImproveDocumentJobInput[] = [];
  const outcome = await patrol.runImprovePatrol(
    ctx,
    { trigger: "scheduled" },
    {
      improveDocument: async (_ctx, input) => {
        improved.push(input);
      }
    }
  );

  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  // The cursor still selected both docs, but only the uncovered one was scanned.
  assert.equal(outcome.selectedCount, 2);
  assert.deepEqual(
    improved.map((job) => job.path),
    ["free.md"]
  );
  assert.equal(outcome.enqueuedCount, 1);
});

// A verify spy that records which docs it was actually asked to check, so the
// change gate's effect (which docs re-verify on a later tick) is observable.
function recordingDeps(verified: string[], verdict: "healthy" | "undefined" = "healthy") {
  return {
    verifyDocument: (async (_ctx, { path }) => {
      verified.push(path);
      return verdict === "undefined" ? undefined : { verdict: "healthy" as const, claims: [] };
    }) as VerifyDocumentFn,
    dedupeDocument: (async () => {}) as DedupeDocumentFn,
    splitDocument: (async () => {}) as SplitDocumentFn
  };
}

test("the change gate skips re-verifying an unchanged doc on the next tick (idle KB → zero calls)", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const verified: string[] = [];

  const first = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified));
  assert.ok(first.ok);
  assert.deepEqual(verified.sort(), ["a.md", "b.md"], "first tick verifies both — no hash recorded yet");
  const firstStamp = (await ctx.stores.patrol.listCursor(undefined)).find((e) => e.docPath === "a.md")!.lastCheckedAt;

  verified.length = 0;
  const second = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified));
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.deepEqual(verified, [], "unchanged docs against an unchanged source configuration are gated — no provider calls");
  assert.equal((second.selected as string[]).length, 2, "the cursor still selected both docs");

  // The cursor still rotates: last_checked_at advances even for a gated doc.
  const secondStamp = (await ctx.stores.patrol.listCursor(undefined)).find((e) => e.docPath === "a.md")!.lastCheckedAt;
  assert.ok(secondStamp >= firstStamp);
  // The run reports the gated count for the audit.
  const run = await ctx.stores.maintenanceRuns.get(second.runId);
  assert.equal((run?.details as { gated?: number }).gated, 2);
});

test("the change gate re-verifies a doc whose content changed, and only that doc", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const verified: string[] = [];
  await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified));

  // Edit a.md; b.md is byte-identical.
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: [
      { path: "a.md", content: "# a.md edited" },
      { path: "b.md", content: "# b.md" }
    ]
  });

  verified.length = 0;
  const second = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified));
  assert.ok(second.ok);
  assert.deepEqual(verified, ["a.md"], "only the changed doc is re-verified; the unchanged one stays gated");
});

test("the change gate re-verifies unchanged docs when the source configuration changes", async () => {
  const ctx = makeTestContext({
    knowledgeConfig: {
      sources: [{ id: "repo", name: "Product repo", kind: "git", url: "https://example.com/repo.git" }],
      destinations: [],
      flows: [],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
  await indexDocs(ctx, ["a.md"]);
  const verified: string[] = [];
  await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified));
  assert.deepEqual(verified, ["a.md"]);

  // Re-point the configured source; the doc body is untouched. The config half of
  // the gate (the descriptor hash) must re-arm.
  ctx.knowledgeConfig.sources[0] = { id: "repo", name: "Product repo", kind: "git", url: "https://example.com/other.git" };
  verified.length = 0;
  const second = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified));
  assert.ok(second.ok);
  assert.deepEqual(verified, ["a.md"], "a source-configuration change re-arms the gate for unchanged docs");

  // And with the config now stable again, the doc gates as usual — guards against
  // the descriptor hash being noisy (re-arming every tick would defeat the gate).
  verified.length = 0;
  const third = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified));
  assert.ok(third.ok);
  assert.deepEqual(verified, [], "same configuration + same content stays gated");
});

test("the change gate keeps a doc whose verify did not complete re-checkable next tick", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const verified: string[] = [];

  // Verify never completes (e.g. no provider watcher) — returns undefined.
  const first = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified, "undefined"));
  assert.ok(first.ok);
  assert.deepEqual(verified, ["a.md"]);

  // No hash was recorded (the check never completed), so the next tick re-verifies it
  // rather than gating on a state it was never verified at.
  verified.length = 0;
  const second = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, recordingDeps(verified, "undefined"));
  assert.ok(second.ok);
  assert.deepEqual(verified, ["a.md"], "an unverified doc is never gated");
});

test("runImprovePatrol gates an unchanged doc on the next tick", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const improved: string[] = [];
  const deps = {
    improveDocument: async (_ctx: unknown, input: ImproveDocumentJobInput) => {
      improved.push(input.path);
    }
  };

  const first = await patrol.runImprovePatrol(ctx, { trigger: "scheduled" }, deps);
  assert.ok(first.ok);
  const firstEnqueued = [...improved];
  assert.ok(firstEnqueued.length > 0);

  improved.length = 0;
  const second = await patrol.runImprovePatrol(ctx, { trigger: "scheduled" }, deps);
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.deepEqual(improved, [], "unchanged docs are gated — no improve scans enqueued");
  assert.equal(second.enqueuedCount, 0);
});

test("runFixPatrol skips a document already covered by an open same-flow proposal", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["covered.md", "free.md"]);
  await ctx.stores.proposals.create({
    title: "Dedupe: reconcile covered.md",
    targetPath: "covered.md",
    markdown: "# covered.md\nreconciled",
    rationale: "duplicate",
    evidence: []
  });

  const verified: string[] = [];
  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "scheduled" },
    {
      verifyDocument: async (_ctx, { path }) => {
        verified.push(path);
        return { verdict: "healthy", claims: [] };
      },
      dedupeDocument: async () => {},
      splitDocument: async () => {}
    }
  );

  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  // covered.md was selected by the cursor but no lens ran against it.
  assert.deepEqual(verified, ["free.md"]);
});
