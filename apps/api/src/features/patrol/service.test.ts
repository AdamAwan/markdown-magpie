import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import type { VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import type { DedupeDocumentFn } from "../../scheduling/dedupe-lens.js";
import type { SplitDocumentFn } from "../../scheduling/split-lens.js";
import type {
  DedupeDocumentsJobInput,
  ImproveDocumentJobInput,
  ProvenanceClaim,
  SourceDescriptor,
  SplitDocumentJobInput
} from "@magpie/core";
import { verifyDocumentInputSchema } from "@magpie/jobs";
import type { JobView } from "@magpie/jobs";
import { cancelJob, completeJob, failJob } from "../jobs/service.js";
import * as patrol from "./service.js";
import type { CorrectDocumentFn } from "./service.js";

async function indexDocs(ctx: ReturnType<typeof makeTestContext>, paths: string[]): Promise<void> {
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: paths.map((path) => ({ path, content: `# ${path}` }))
  });
}

// Healthy verify + quiet dedupe, so the cursor/run tests get their verdict within
// the tick (the default verify enqueues a job whose verdict arrives later, at its
// completion — covered by the "non-blocking verify" tests below).
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
  assert.deepEqual(
    verified,
    [],
    "unchanged docs against an unchanged source configuration are gated — no provider calls"
  );
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
  ctx.knowledgeConfig.sources[0] = {
    id: "repo",
    name: "Product repo",
    kind: "git",
    url: "https://example.com/other.git"
  };
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

// The default verify path (no injected verifyDocument) enqueues a real
// verify_document job on the fake broker and returns without waiting for it; the
// job stays queued and its input inspectable via ctx.jobs.list. These tests pin
// down what that input carries (#214 phase 2: folded citedClaims).
const QUIET_LENS_DEPS = {
  correctDocument: (async () => {}) as CorrectDocumentFn,
  dedupeDocument: (async () => {}) as DedupeDocumentFn,
  splitDocument: (async () => {}) as SplitDocumentFn
};

async function seedMergedProposal(
  ctx: ReturnType<typeof makeTestContext>,
  targetPath: string,
  provenance: ProvenanceClaim[]
): Promise<void> {
  const proposal = await ctx.stores.proposals.create({
    title: `Provenance for ${targetPath}`,
    targetPath,
    markdown: `# ${targetPath}`,
    rationale: "r",
    evidence: [],
    provenance
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "merged");
}

test("the default verify job input carries citedClaims folded from merged-proposal provenance", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  // Two merged events for a.md: the later one supersedes the shared anchor.
  // indexDocs gives a.md the content "# a.md", whose heading slugs to "a-md".
  await seedMergedProposal(ctx, "a.md", [
    { claim: "old claim", anchor: "a-md", sources: [{ sourceId: "src-1", path: "docs/old.md" }] }
  ]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await seedMergedProposal(ctx, "a.md", [
    { claim: "new claim", anchor: "a-md", sources: [{ sourceId: "src-1", path: "docs/new.md" }] },
    { claim: "unanchored claim", sources: [{ sourceId: "src-1", path: "docs/free.md" }] }
  ]);

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);

  const { jobs } = await ctx.jobs.list({ type: "verify_document" });
  assert.equal(jobs.length, 1);
  const input = verifyDocumentInputSchema.parse(jobs[0].input);
  assert.deepEqual(input.citedClaims, [
    { claim: "new claim", anchor: "a-md", sources: [{ sourceId: "src-1", path: "docs/new.md" }] },
    { claim: "unanchored claim", sources: [{ sourceId: "src-1", path: "docs/free.md" }] }
  ]);
});

test("without merged provenance the default verify job input is byte-identical to today's", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  // A merged proposal WITHOUT provenance must contribute nothing (not an empty array).
  await seedMergedProposal(ctx, "a.md", []);

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);

  const { jobs } = await ctx.jobs.list({ type: "verify_document" });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].input, {
    provider: "codex",
    path: "a.md",
    content: "# a.md",
    sources: []
  });
});

test("a provenance change busts the verify reuse key; identical claims still reuse", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  await seedMergedProposal(ctx, "a.md", [
    { claim: "new claim", anchor: "a-md", sources: [{ sourceId: "src-1", path: "docs/new.md" }] }
  ]);

  // An in-flight verify for the same doc/sources/provider but WITHOUT the folded
  // claims (e.g. enqueued before the proposal merged) is now stale work: the
  // patrol must enqueue a fresh job, not piggyback on it.
  await ctx.jobs.create("verify_document", { provider: "codex", path: "a.md", content: "# a.md", sources: [] });
  const first = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(first.ok);
  const afterDifferentClaims = await ctx.jobs.list({ type: "verify_document" });
  assert.equal(afterDifferentClaims.jobs.length, 2, "different folded claims ⇒ different reuse key ⇒ new job");

  // An in-flight verify that already carries the SAME folded claims is the same
  // piece of work — the patrol reuses it instead of duplicating.
  const ctx2 = makeTestContext();
  await indexDocs(ctx2, ["a.md"]);
  await seedMergedProposal(ctx2, "a.md", [
    { claim: "new claim", anchor: "a-md", sources: [{ sourceId: "src-1", path: "docs/new.md" }] }
  ]);
  await ctx2.jobs.create("verify_document", {
    provider: "codex",
    path: "a.md",
    content: "# a.md",
    sources: [],
    citedClaims: [{ claim: "new claim", anchor: "a-md", sources: [{ sourceId: "src-1", path: "docs/new.md" }] }]
  });
  const second = await patrol.runFixPatrol(ctx2, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(second.ok);
  const afterIdenticalClaims = await ctx2.jobs.list({ type: "verify_document" });
  assert.equal(afterIdenticalClaims.jobs.length, 1, "identical folded claims ⇒ same reuse key ⇒ job reused");
});

// A verify spy that marks every document unprovable, so each selected doc yields
// one corrective enqueue that must pass through the fan-out budget.
const UNPROVABLE_VERIFY: VerifyDocumentFn = async () => ({
  verdict: "unprovable",
  claims: [{ claim: "stale", reason: "no source" }]
});

test("the fan-out budget caps corrective enqueues per tick and leaves deferred docs re-checkable (#288b)", async () => {
  const ctx = makeTestContext();
  // Budget of 2, but five docs each produce a finding → three corrections deferred.
  ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 2;
  await indexDocs(ctx, ["a.md", "b.md", "c.md", "d.md", "e.md"]);

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "scheduled" },
    { verifyDocument: UNPROVABLE_VERIFY, dedupeDocument: async () => {}, splitDocument: async () => {} }
  );
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.selectedCount, 5, "all five docs were selected");

  // Only two correct_document jobs were admitted this tick.
  assert.equal((await ctx.jobs.list({ type: "correct_document" })).total, 2);

  // The three deferred docs are NOT stamped with a fresh content hash, so they stay
  // re-checkable; only the two whose correction was enqueued carry a hash.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.equal(cursor.length, 5, "every selected doc still rotates in the cursor");
  assert.equal(cursor.filter((entry) => entry.contentHash).length, 2, "only the 2 corrected docs are stamped checked");

  // The tick records the fan-out summary for the audit.
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  const fanout = (run?.details as { fanout?: { enqueued: number; deferredByBudget: number; budget: number } }).fanout;
  assert.equal(fanout?.enqueued, 2);
  assert.equal(fanout?.deferredByBudget, 3);
  assert.equal(fanout?.budget, 2);
});

test("a capacity rejection skips the doc without failing the tick (#288b)", async () => {
  const ctx = makeTestContext();
  // Force the atomic admission to reject every maintenance enqueue.
  ctx.jobs.createIfAdmitted = async () => ({ admitted: false, inFlight: 99 });
  await indexDocs(ctx, ["a.md", "b.md"]);

  const outcome = await patrol.runFixPatrol(
    ctx,
    { trigger: "scheduled" },
    { verifyDocument: UNPROVABLE_VERIFY, dedupeDocument: async () => {}, splitDocument: async () => {} }
  );
  // The tick still completes cleanly — a capacity shed is a deferral, not a failure.
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal((await ctx.jobs.list({ type: "correct_document" })).total, 0, "no correction was admitted");
  // Nothing got a fresh hash, so all docs stay re-checkable next tick.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.equal(cursor.filter((entry) => entry.contentHash).length, 0);
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  const fanout = (run?.details as { fanout?: { rejectedByCapacity: number } }).fanout;
  assert.equal(fanout?.rejectedByCapacity, 2);
});

test("runImprovePatrol defers an improve scan past the budget without stamping the doc (#288b)", async () => {
  const ctx = makeTestContext();
  // The editorial batch selects 2 docs; a budget of 1 defers one of them.
  ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 1;
  await indexDocs(ctx, ["a.md", "b.md"]);

  const outcome = await patrol.runImprovePatrol(ctx, { trigger: "scheduled" }, {});
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.selectedCount, 2);
  assert.equal(outcome.enqueuedCount, 1, "only one improve scan fit the budget");
  assert.equal((await ctx.jobs.list({ type: "improve_document" })).total, 1);
  // The deferred doc is unstamped (re-checkable); only the enqueued one carries a hash.
  const cursor = await ctx.stores.patrol.listCursor(undefined, "improve");
  assert.equal(cursor.filter((entry) => entry.contentHash).length, 1);
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

// --- Non-blocking verify -------------------------------------------------------
// The default verify enqueues a verify_document job per document and returns; each
// job's completion applies its own verdict. These tests complete the jobs the way
// a watcher does (completeJob / failJob), so nothing completes "by itself" — the
// single watcher that ran the patrol tick is enough to run its verifies.

const UNPROVABLE_OUTPUT = { verdict: "unprovable", claims: [{ claim: "stale", reason: "no source" }] };
const HEALTHY_OUTPUT = { verdict: "healthy", claims: [] };

async function verifyJobs(ctx: ReturnType<typeof makeTestContext>): Promise<JobView[]> {
  return (await ctx.jobs.list({ type: "verify_document", limit: 50 })).jobs;
}

function verifyJobFor(jobs: JobView[], path: string): JobView {
  const job = jobs.find((candidate) => (candidate.input as { path: string }).path === path);
  assert.ok(job, `expected a verify_document job for ${path}`);
  return job;
}

async function cursorEntry(ctx: ReturnType<typeof makeTestContext>, path: string) {
  return (await ctx.stores.patrol.listCursor(undefined)).find((entry) => entry.docPath === path);
}

test("the default verify enqueues and returns: nothing checked yet, the run is still running", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  const jobs = await verifyJobs(ctx);
  assert.equal(jobs.length, 2, "one verify per document");
  assert.ok(
    jobs.every((job) => job.state === "created"),
    "the verifies are queued for a watcher — never cancelled, never waited on"
  );
  assert.equal(outcome.pendingVerifyCount, 2);
  assert.deepEqual(outcome.findings, []);

  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.equal(run?.status, "running");
  assert.equal(run?.completedAt, undefined);
  assert.equal(run?.details.pendingVerifies, 2);
  assert.match(run?.summary ?? "", /checked 0\/2 docs · 0 findings · 2 verifies in progress/);

  // The cursor rotated, but no verified hash is recorded for an unanswered verify.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.equal(cursor.length, 2);
  assert.equal(cursor.filter((entry) => entry.contentHash).length, 0);
});

test("each verify's completion applies its verdict; the last one completes the run", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const jobs = await verifyJobs(ctx);

  // a.md is unprovable: a corrective job is enqueued and the finding lands on the run.
  assert.equal((await completeJob(ctx, verifyJobFor(jobs, "a.md").id, UNPROVABLE_OUTPUT)).ok, true);
  const corrections = (await ctx.jobs.list({ type: "correct_document" })).jobs;
  assert.equal(corrections.length, 1);
  assert.deepEqual(
    {
      path: (corrections[0]?.input as { path: string }).path,
      claims: (corrections[0]?.input as { claims: unknown }).claims
    },
    { path: "a.md", claims: UNPROVABLE_OUTPUT.claims }
  );
  assert.ok((await cursorEntry(ctx, "a.md"))?.contentHash, "the verified document is stamped");
  assert.equal((await cursorEntry(ctx, "b.md"))?.contentHash, undefined, "its unanswered sibling is not");

  let run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.equal(run?.status, "running", "one verify is still outstanding");
  assert.equal((run?.details.findings as unknown[]).length, 1);
  assert.equal(run?.details.pendingVerifies, 1);

  // b.md is healthy: no correction, and the run is now complete.
  assert.equal((await completeJob(ctx, verifyJobFor(jobs, "b.md").id, HEALTHY_OUTPUT)).ok, true);
  assert.equal((await ctx.jobs.list({ type: "correct_document" })).jobs.length, 1);
  run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.equal(run?.status, "completed");
  assert.ok(run?.completedAt);
  assert.equal(run?.summary, "checked 2/2 docs · 1 finding");
  assert.deepEqual(
    (run?.details.findings as Array<{ path: string }>).map((finding) => finding.path),
    ["a.md"]
  );
  assert.equal((run?.details.intentTraces as unknown[]).length, 1);
  assert.equal(run?.details.pendingVerifies, 0);

  // Both docs now carry a verified hash, so the next tick gates them: no new verifies.
  const second = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal((await verifyJobs(ctx)).length, 2);
  assert.equal(second.pendingVerifyCount, 0);
  assert.equal((await ctx.stores.maintenanceRuns.get(second.runId))?.status, "completed");
});

test("a replayed verify completion enqueues no second correction", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const [job] = await verifyJobs(ctx);

  await completeJob(ctx, job!.id, UNPROVABLE_OUTPUT);
  await completeJob(ctx, job!.id, UNPROVABLE_OUTPUT);

  assert.equal((await ctx.jobs.list({ type: "correct_document" })).jobs.length, 1);
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.equal((run?.details.findings as unknown[]).length, 1, "the finding is counted once");
});

test("a completion that died after enqueueing the correction but before settling does not buy it twice", async () => {
  // The paid correct_document enqueue happened; then the settle failed. The
  // watcher re-POSTs the completion and the verdict is acted on a second time.
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const [job] = await verifyJobs(ctx);
  const store = ctx.stores.orchestrationFollowups;
  const realSettle = store.settle.bind(store);
  let failures = 1;
  store.settle = async (jobId, result) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("database blip");
    }
    return realSettle(jobId, result);
  };

  assert.deepEqual(await completeJob(ctx, job!.id, UNPROVABLE_OUTPUT), { ok: false, code: "side_effects_failed" });
  assert.equal((await ctx.jobs.list({ type: "correct_document" })).jobs.length, 1, "enqueued before the failure");

  assert.equal((await completeJob(ctx, job!.id, UNPROVABLE_OUTPUT)).ok, true);

  assert.equal(
    (await ctx.jobs.list({ type: "correct_document" })).jobs.length,
    1,
    "the replay reused the correction already enqueued"
  );
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.equal(run?.status, "completed");
  assert.equal((run?.details.findings as unknown[]).length, 1);
  assert.ok((await cursorEntry(ctx, "a.md"))?.contentHash, "and the doc is stamped as verified");
});

test("the correction reuse key tells different corrections apart and ignores a failed one", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  const jobs = await verifyJobs(ctx);

  // An identical correction for a.md already exists but FAILED: it never
  // happened, so the verdict must still buy one.
  const failed = await ctx.jobs.create("correct_document", {
    provider: "codex",
    path: "a.md",
    content: "# a.md",
    claims: UNPROVABLE_OUTPUT.claims,
    sources: [],
    destinationId: "docs"
  });
  await failJob(ctx, failed.id, { code: "provider_down", message: "down", category: "provider" }, { terminal: true });

  await completeJob(ctx, verifyJobFor(jobs, "a.md").id, UNPROVABLE_OUTPUT);
  const afterA = (await ctx.jobs.list({ type: "correct_document" })).jobs;
  assert.equal(afterA.filter((job) => job.state === "created").length, 1, "a fresh correction replaces the failed one");

  // A different document with the same claims text is a different correction.
  await completeJob(ctx, verifyJobFor(jobs, "b.md").id, UNPROVABLE_OUTPUT);
  const live = (await ctx.jobs.list({ type: "correct_document" })).jobs.filter((job) => job.state === "created");
  assert.deepEqual(live.map((job) => (job.input as { path: string }).path).sort(), ["a.md", "b.md"]);
});

test("a verify that FAILS leaves its document unchecked and re-checkable, and the run stops waiting", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const [job] = await verifyJobs(ctx);

  await failJob(ctx, job!.id, { code: "provider_down", message: "down", category: "provider" }, { terminal: true });

  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.equal(run?.status, "completed");
  assert.equal(run?.summary, "checked 0/1 docs · 0 findings");
  assert.equal((await cursorEntry(ctx, "a.md"))?.contentHash, undefined, "no verified hash for a doc never verified");

  // Not gated: the next tick verifies it again.
  await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.equal((await verifyJobs(ctx)).length, 2);
});

test("a cancelled verify is written off the same way", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const [job] = await verifyJobs(ctx);

  await cancelJob(ctx, job!.id);

  assert.equal((await ctx.stores.maintenanceRuns.get(outcome.runId))?.status, "completed");
  assert.equal((await cursorEntry(ctx, "a.md"))?.contentHash, undefined);
});

test("a verdict for content that changed while the verify ran is dropped, not applied or stamped", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const [job] = await verifyJobs(ctx);

  // The document is re-indexed with new content before the verify answers.
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: [{ path: "a.md", content: "# a.md\n\nrewritten" }]
  });
  await completeJob(ctx, job!.id, UNPROVABLE_OUTPUT);

  assert.equal((await ctx.jobs.list({ type: "correct_document" })).jobs.length, 0, "no correction against stale text");
  assert.equal((await cursorEntry(ctx, "a.md"))?.contentHash, undefined, "the new content is not gated as verified");
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.equal(run?.status, "completed");
  assert.equal(run?.summary, "checked 0/1 docs · 0 findings");
});

test("a later tick reuses a verify still in flight instead of enqueueing a duplicate", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const first = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  const second = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;

  const jobs = await verifyJobs(ctx);
  assert.equal(jobs.length, 1, "the in-flight verify is reused");
  // It still belongs to the tick that enqueued it; the second run has nothing of its own to wait for.
  assert.equal((await ctx.stores.maintenanceRuns.get(second.runId))?.status, "completed");

  await completeJob(ctx, jobs[0]!.id, UNPROVABLE_OUTPUT);
  const firstRun = await ctx.stores.maintenanceRuns.get(first.runId);
  assert.equal(firstRun?.status, "completed");
  assert.equal((firstRun?.details.findings as unknown[]).length, 1);
  assert.equal((await ctx.jobs.list({ type: "correct_document" })).jobs.length, 1);
});

test("self-heals: a tick applies a completed verify whose completion-side continuation never ran", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const first = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(first.ok);
  if (!first.ok) return;
  const [job] = await verifyJobs(ctx);

  // The job reached `completed` in the broker, but the dispatcher's side effects
  // never ran (the watcher gave up re-POSTing; the API restarted mid-completion).
  await ctx.jobs.complete(job!.id, { result: UNPROVABLE_OUTPUT, executor: "watcher" });
  assert.equal((await ctx.stores.maintenanceRuns.get(first.runId))?.status, "running");

  await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);

  const healed = await ctx.stores.maintenanceRuns.get(first.runId);
  assert.equal(healed?.status, "completed", "the next tick applied the verdict and finished the earlier run");
  assert.equal((healed?.details.findings as unknown[]).length, 1);
  assert.equal((await ctx.jobs.list({ type: "correct_document" })).jobs.length, 1);
  assert.equal((await verifyJobs(ctx)).length, 1, "and, now stamped, the doc is gated rather than re-verified");
});

test("a source conflict reported by a completed verify annotates the document", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const [job] = await verifyJobs(ctx);

  await completeJob(ctx, job!.id, {
    verdict: "healthy",
    claims: [],
    conflicts: [
      {
        topic: "Retention period",
        summary: "The policy says 30 days; the code enforces 90.",
        anchor: "a-md",
        claim: "Data is retained for 30 days.",
        positions: [
          { sourceId: "policy", path: "retention.md", statement: "30 days" },
          { sourceId: "code", path: "retention.ts", statement: "90 days" }
        ]
      }
    ]
  });

  assert.equal((await ctx.stores.sourceConflicts.listOpenPaths(undefined)).length, 1);
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  assert.equal(run?.summary, "checked 1/1 doc · 0 findings · 1 source conflict");
  assert.equal((await ctx.jobs.list({ type: "correct_document" })).jobs.length, 0, "a conflict is never 'corrected'");
});

test("a verify whose doc had its dedupe/split enqueue shed applies its verdict but records no verified hash", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  // The dedupe lens reports a shed for this doc by marking it deferred — modelled
  // here through the default enqueue path with the budget spent on the verify.
  ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 1;
  // Force the split lens to want a job for a.md so it meets the exhausted budget.
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: [
      {
        path: "a.md",
        content: ["# A", ...Array.from({ length: 40 }, (_, i) => `## Topic ${i}\n\n${"word ".repeat(400)}`)].join(
          "\n\n"
        )
      }
    ]
  });

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, {});
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  const fanout = run?.details.fanout as { enqueued: number; deferredByBudget: number };
  assert.equal(fanout.enqueued, 1, "the budget admitted only the verify");
  assert.ok(fanout.deferredByBudget >= 1, "the split scan was shed");

  const [job] = await verifyJobs(ctx);
  await completeJob(ctx, job!.id, HEALTHY_OUTPUT);

  assert.equal(
    (await cursorEntry(ctx, "a.md"))?.contentHash,
    undefined,
    "the doc stays re-checkable so its shed split scan is retried"
  );
  assert.equal((await ctx.stores.maintenanceRuns.get(outcome.runId))?.summary, "checked 1/1 doc · 0 findings");
});

test("a verify shed by the fan-out budget is skipped, not waited for, and its doc stays re-checkable (#288b)", async () => {
  const ctx = makeTestContext();
  ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 1;
  await indexDocs(ctx, ["a.md", "b.md"]);

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  assert.equal((await verifyJobs(ctx)).length, 1, "the budget admitted one verify");
  assert.equal(outcome.pendingVerifyCount, 1, "the shed verify is not pending — there is nothing to wait for");
  const run = await ctx.stores.maintenanceRuns.get(outcome.runId);
  const fanout = run?.details.fanout as { enqueued: number; deferredByBudget: number };
  assert.deepEqual(
    { enqueued: fanout.enqueued, deferredByBudget: fanout.deferredByBudget },
    { enqueued: 1, deferredByBudget: 1 }
  );

  // The reused in-flight verify spends no budget on the next tick, so the doc
  // that was shed gets its turn.
  const second = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, QUIET_LENS_DEPS);
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal((await verifyJobs(ctx)).length, 2);
  const secondFanout = (await ctx.stores.maintenanceRuns.get(second.runId))?.details.fanout as { attempted: number };
  assert.equal(secondFanout.attempted, 1, "only the new verify was admitted; the reuse cost nothing");
});

test("a verify_document with no follow-up row (created by hand) completes without touching the patrol", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md"]);
  const job = await ctx.jobs.create("verify_document", {
    provider: "codex",
    path: "a.md",
    content: "# a.md",
    sources: []
  });

  assert.equal((await completeJob(ctx, job.id, UNPROVABLE_OUTPUT)).ok, true);

  assert.equal((await ctx.jobs.list({ type: "correct_document" })).jobs.length, 0);
  assert.deepEqual(await ctx.stores.maintenanceRuns.list({ limit: 10 }), []);
});
