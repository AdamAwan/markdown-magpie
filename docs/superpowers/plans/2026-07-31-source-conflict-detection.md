# Source-conflict detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect disagreements between sources while fact-checking KB documents, record them in a reviewable register, annotate the affected document, and repair it once the sources agree again.

**Architecture:** Extends the existing `verify_document` job with a `conflicts[]` output (separate from `claims[]`) plus a `knownConflicts` → `resolvedConflicts` round-trip. The verify lens routes conflicts to a new `source_conflicts` store instead of `correct_document`. Annotation and marker-stripping are deterministic markdown edits made by the API; repair reuses `correct_document`. No new job types.

**Tech Stack:** TypeScript (ESM/NodeNext), node:test, Zod job schemas, Postgres (custom SQL migrator), Next.js App Router + Emotion for the console.

**Spec:** `docs/superpowers/specs/2026-07-31-source-conflict-detection-design.md`

## Global Constraints

- ESM/NodeNext — every relative import needs an explicit `.js` extension, including from `.ts` sources.
- Never cast through `unknown` or `any` to silence types.
- Every job output field must be declared in `packages/jobs/src/schemas.ts` or the broker strips it before the API sees it.
- Run `npm run verify` (format:check, lint, deadcode, typecheck) before pushing. Knip runs in strict mode: an `export` on a symbol used only within its own file is a failure — drop the `export`.
- Tests use `node:test` + `node:assert/strict`, colocated as `<name>.test.ts`. Run per-workspace: `npm test -w <pkg>`, never root-cwd `node --test`.
- Postgres-backed tests are gated by `RUN_PG_INTEGRATION` and named `*.integration.test.ts` or run via `npm run test:db`.
- The conflict marker must never contain source repository paths or source names (#214).
- Commit after every task.

---

### Task 1: Core types and job contract

**Files:**
- Modify: `packages/core/src/index.ts` (near `UnprovableClaim`, ~line 945, and `VerifyDocumentJobInput`/`VerifyDocumentJobOutput`, ~lines 956-980)
- Modify: `packages/jobs/src/schemas.ts` (`verifyDocumentInputSchema` ~504, `verifyDocumentOutputSchema` ~518; delete `detectContradictionInputSchema`/`detectContradictionOutputSchema` ~401-407)
- Modify: `packages/jobs/src/types.ts` (remove `"detect_contradiction"` from `JOB_TYPES`, ~line 12)
- Modify: `packages/jobs/src/catalog.ts` (remove the `detect_contradiction` entry ~204-209 and its membership in the AI-type and repairable lists, ~85 and ~372)
- Test: `packages/jobs/src/catalog.test.ts` (remove `detect_contradiction` expectations at ~37 and ~128; add the new verify contract assertions)

**Interfaces:**
- Produces: `SourceConflictPosition`, `DetectedSourceConflict`, `ResolvedSourceConflict`, `KnownSourceConflict` exported from `@magpie/core`; `VerifyDocumentJobInput.knownConflicts`, `VerifyDocumentJobOutput.conflicts`, `VerifyDocumentJobOutput.resolvedConflicts`.

- [ ] **Step 1: Write the failing test**

In `packages/jobs/src/catalog.test.ts`:

```ts
test("verify_document output schema carries conflicts and resolvedConflicts", () => {
  const parsed = verifyDocumentOutputSchema.parse({
    verdict: "healthy",
    claims: [],
    conflicts: [
      {
        topic: "log retention period",
        summary: "One source states 1 year, another enforces 60 days.",
        anchor: "retention",
        claim: "Logs are retained for 1 year.",
        positions: [
          { sourceId: "policy", path: "security/logging.md", statement: "retained for 1 year" },
          { sourceId: "ingest", path: "src/retention.ts", statement: "RETENTION_DAYS = 60" }
        ]
      }
    ],
    resolvedConflicts: [{ id: "c1", agreedStatement: "Logs are retained for 60 days." }]
  });
  assert.equal(parsed.conflicts?.[0]?.positions.length, 2);
  assert.equal(parsed.resolvedConflicts?.[0]?.id, "c1");
});

test("a conflict needs at least two positions", () => {
  assert.throws(() =>
    verifyDocumentOutputSchema.parse({
      verdict: "healthy",
      claims: [],
      conflicts: [
        {
          topic: "t",
          summary: "s",
          anchor: "a",
          claim: "c",
          positions: [{ sourceId: "policy", path: "p.md", statement: "x" }]
        }
      ]
    })
  );
});

test("detect_contradiction is gone", () => {
  assert.ok(!JOB_TYPES.includes("detect_contradiction" as JobType));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/jobs`
Expected: FAIL — `conflicts` stripped by the `z.object`, `detect_contradiction` still present.

- [ ] **Step 3: Add the core types**

In `packages/core/src/index.ts`, after `UnprovableClaim`:

```ts
// One side of a source conflict: what a specific source location actually says.
export interface SourceConflictPosition {
  sourceId: string;
  path: string;
  statement: string;
  lines?: string;
}

// A disagreement between two or more source locations about a fact a KB document
// asserts. Distinct from an UnprovableClaim: there the sources agree the document
// is wrong; here the sources disagree with EACH OTHER, so no correction can be
// made without inventing an authority Magpie does not have.
export interface DetectedSourceConflict {
  topic: string;
  summary: string;
  // Slugified heading path of the KB section the claim lives under — the same
  // (documentId, anchor) section identity claim provenance uses.
  anchor: string;
  claim: string;
  positions: SourceConflictPosition[];
}

// An open conflict handed to the verify agent as advisory input (citedClaims
// precedent) so it re-checks known disagreements and reports them as known
// rather than novel.
export interface KnownSourceConflict {
  id: string;
  topic: string;
  summary: string;
}

// A known conflict the agent found the sources now agree on. Resolution requires
// this POSITIVE signal — the verify prompt runs under CONSERVATIVE_CONTRACT, so
// silence is the agent's default and would close live conflicts.
export interface ResolvedSourceConflict {
  id: string;
  agreedStatement: string;
}
```

Extend the job types in the same file:

```ts
export interface VerifyDocumentJobInput {
  // ...existing fields...
  knownConflicts?: KnownSourceConflict[];
}

export interface VerifyDocumentJobOutput {
  verdict: "healthy" | "unprovable";
  claims: UnprovableClaim[];
  conflicts?: DetectedSourceConflict[];
  resolvedConflicts?: ResolvedSourceConflict[];
  mapUpdates?: SourceMapUpdate[];
}
```

- [ ] **Step 4: Extend the Zod schemas and delete `detect_contradiction`**

In `packages/jobs/src/schemas.ts`:

```ts
const sourceConflictPositionSchema = z.object({
  sourceId: z.string(),
  path: z.string(),
  statement: z.string(),
  lines: z.string().optional()
}) satisfies z.ZodType<SourceConflictPosition>;

const detectedSourceConflictSchema = z.object({
  topic: z.string(),
  summary: z.string(),
  anchor: z.string(),
  claim: z.string(),
  // Fewer than two positions is not a conflict — it is an unprovable claim, and
  // accepting it here would route a correctable defect into the register where
  // nothing ever fixes it.
  positions: z.array(sourceConflictPositionSchema).min(2)
}) satisfies z.ZodType<DetectedSourceConflict>;
```

Add to `verifyDocumentInputSchema`: `knownConflicts: z.array(knownSourceConflictSchema).optional()`.
Add to `verifyDocumentOutputSchema`: `conflicts: z.array(detectedSourceConflictSchema).optional()` and `resolvedConflicts: z.array(resolvedSourceConflictSchema).optional()`.

Delete `detectContradictionInputSchema` and `detectContradictionOutputSchema`, the `detect_contradiction` entry in `catalog.ts`, and its membership in the AI-type and repairable lists in `catalog.ts` and `types.ts`.

- [ ] **Step 5: Run the tests**

Run: `npm test -w @magpie/jobs && npm test -w @magpie/core && npm run typecheck`
Expected: PASS. Typecheck will surface every other `detect_contradiction` reference — remove those too (`apps/web/src/components/JobsPanel.tsx` may list it).

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/jobs apps/web && git commit -m "feat(jobs): add source-conflict fields to verify_document; drop dead detect_contradiction"
```

---

### Task 2: Verify prompt

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (`VERIFY_DOCUMENT`, ~line 479)
- Test: `packages/prompts/src/catalog.test.ts`

**Interfaces:**
- Consumes: the output shape from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
test("verify-document prompt separates source conflicts from unprovable claims", () => {
  const text = VERIFY_DOCUMENT.instructions;
  assert.match(text, /disagree with EACH OTHER/);
  assert.match(text, /resolvedConflicts/);
  assert.match(text, /knownConflicts/);
  // The marker must never carry source paths into published content (#214).
  assert.match(text, /never name source paths/i);
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @magpie/prompts` — Expected: FAIL.

- [ ] **Step 3: Update the prompt**

Change the existing conservative-contract line so the two failure modes are distinguished, and add:

```
- Distinguish two different failures. If the sources AGREE with each other but the
  document is out of date, that is an unprovable claim: report it in "claims". If
  the sources disagree with EACH OTHER about the same fact — within one source or
  across several — that is a source conflict: report it in "conflicts" and do NOT
  report it in "claims". Magpie must never choose which source is right.
- Report a conflict only when you have READ BOTH SIDES: every entry in "positions"
  must name a real repo-relative path you opened and quote what it says. Never
  raise a conflict from a reference-only (internet/agent) source — you cannot
  check it. Two positions minimum.
- "anchor" is the slugified heading path of the section in the document under
  review where the conflicting claim lives.
- The conflict summary is published into the document body, so it must never name
  source paths or source names. State what the disagreement is and what the
  competing values are; the evidence lives elsewhere.
- The input may include "knownConflicts": conflicts already recorded for this
  document. Check each one FIRST. If the sources still disagree, report it in
  "conflicts" as usual. If the sources now AGREE, report it in "resolvedConflicts"
  with the statement they agree on. Say nothing about a known conflict you could
  not check — silence leaves it open, which is the safe default.
```

Update `outputShape` to `"{ verdict, claims[], conflicts[], resolvedConflicts[], mapUpdates? }"` and extend the JSON template.

- [ ] **Step 4: Run the tests**

Run: `npm test -w @magpie/prompts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/prompts && git commit -m "feat(prompts): teach verify-document to separate source conflicts from unprovable claims"
```

---

### Task 3: Markdown conflict marker

**Files:**
- Create: `packages/markdown/src/conflict-marker.ts`
- Test: `packages/markdown/src/conflict-marker.test.ts`
- Modify: `packages/markdown/src/index.ts` (barrel export)

**Interfaces:**
- Produces:
  - `insertConflictMarker(content: string, args: { conflictId: string; anchor: string; summary: string }): string`
  - `stripConflictMarker(content: string, conflictId: string): string`
  - `hasConflictMarker(content: string, conflictId: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
const DOC = `# Logging\n\nIntro.\n\n## Retention\n\nLogs are retained for 1 year.\n`;

test("inserts a marker directly under the target heading", () => {
  const out = insertConflictMarker(DOC, {
    conflictId: "c1",
    anchor: "retention",
    summary: "Sources disagree on the log retention period: one states 1 year, another enforces 60 days."
  });
  assert.match(out, /## Retention\n\n<!-- magpie:conflict id=c1 -->/);
  assert.match(out, /> \*\*Unresolved source conflict\.\*\*/);
  // The original prose survives — annotation is insert-only.
  assert.match(out, /Logs are retained for 1 year\./);
});

test("strip is an exact inverse of insert", () => {
  const args = { conflictId: "c1", anchor: "retention", summary: "s" };
  assert.equal(stripConflictMarker(insertConflictMarker(DOC, args), "c1"), DOC);
});

test("insert is idempotent for the same conflict id", () => {
  const args = { conflictId: "c1", anchor: "retention", summary: "s" };
  const once = insertConflictMarker(DOC, args);
  assert.equal(insertConflictMarker(once, args), once);
});

test("strip leaves another conflict's marker alone", () => {
  const a = insertConflictMarker(DOC, { conflictId: "a", anchor: "retention", summary: "sa" });
  const both = insertConflictMarker(a, { conflictId: "b", anchor: "retention", summary: "sb" });
  assert.ok(hasConflictMarker(stripConflictMarker(both, "b"), "a"));
});

test("an unknown anchor appends at end of document rather than dropping the marker", () => {
  const out = insertConflictMarker(DOC, { conflictId: "c1", anchor: "nope", summary: "s" });
  assert.ok(hasConflictMarker(out, "c1"));
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @magpie/markdown` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Reuse the package's existing heading-slug helper so anchors match the sectioning the rest of the system uses. Marker block:

```
<!-- magpie:conflict id=<id> -->
> **Unresolved source conflict.** <summary>
<!-- /magpie:conflict -->
```

The summary is untrusted source-derived text: strip any line that would break out of the blockquote, and prefix every line with `> `.

- [ ] **Step 4: Run the tests**

Run: `npm test -w @magpie/markdown` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/markdown && git commit -m "feat(markdown): conflict marker insert/strip helpers"
```

---

### Task 4: Migration and store

**Files:**
- Create: `packages/db/migrations/0061_source_conflicts.sql`
- Create: `apps/api/src/stores/source-conflict-store.ts` (interface + in-memory impl + fingerprint)
- Create: `apps/api/src/stores/postgres-source-conflict-store.ts`
- Test: `apps/api/src/stores/source-conflict-store.test.ts`, `apps/api/src/stores/postgres-source-conflict-store.test.ts`
- Modify: `apps/api/src/context.ts` (register `stores.sourceConflicts`), `apps/api/src/platform/*` composition root, `apps/api/src/stores/reset-stores.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SourceConflict {
  id: string;
  flowId?: string;
  documentPath: string;
  anchor: string;
  topic: string;
  summary: string;
  claim: string;
  positions: SourceConflictPosition[];
  status: "open" | "resolved" | "dismissed";
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  annotatedProposalId?: string;
  resolvedAt?: string;
  agreedStatement?: string;
  dismissalNote?: string;
}

export interface SourceConflictStore {
  // Insert-or-bump on fingerprint. Returns the row and whether it was created.
  upsert(input: SourceConflictUpsert): Promise<{ conflict: SourceConflict; created: boolean }>;
  listOpenForDocument(flowId: string | undefined, documentPath: string): Promise<SourceConflict[]>;
  listOpenPaths(flowId: string | undefined): Promise<string[]>;
  list(options: { flowId?: string; status?: SourceConflict["status"]; limit: number }): Promise<SourceConflict[]>;
  get(id: string): Promise<SourceConflict | undefined>;
  resolve(id: string, agreedStatement: string): Promise<SourceConflict | undefined>;
  dismiss(id: string, note: string): Promise<SourceConflict | undefined>;
  recordAnnotation(id: string, proposalId: string): Promise<SourceConflict | undefined>;
}

export function conflictFingerprint(input: {
  flowId: string | undefined;
  documentPath: string;
  topic: string;
  positions: SourceConflictPosition[];
}): string;
```

- [ ] **Step 1: Write the failing test**

```ts
test("re-detecting the same conflict bumps seenCount instead of inserting", async () => {
  const store = new InMemorySourceConflictStore();
  const first = await store.upsert(input());
  const second = await store.upsert(input());
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.conflict.id, first.conflict.id);
  assert.equal(second.conflict.seenCount, 2);
});

test("a dismissed conflict stays dismissed when re-detected", async () => {
  const store = new InMemorySourceConflictStore();
  const { conflict } = await store.upsert(input());
  await store.dismiss(conflict.id, "policy is authoritative here");
  const again = await store.upsert(input());
  assert.equal(again.conflict.status, "dismissed");
  assert.equal(again.conflict.seenCount, 2);
});

test("fingerprint is order-independent across positions but topic-sensitive", () => {
  const a = conflictFingerprint({ flowId: undefined, documentPath: "d.md", topic: "Log Retention", positions: [p1, p2] });
  const b = conflictFingerprint({ flowId: undefined, documentPath: "d.md", topic: "log  retention", positions: [p2, p1] });
  const c = conflictFingerprint({ flowId: undefined, documentPath: "d.md", topic: "encryption", positions: [p1, p2] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("the unscoped flow still dedupes", () => {
  // flowId folded in as a sentinel, never null — Postgres treats NULLs as
  // distinct in a unique index, which would silently defeat dedupe.
  assert.equal(
    conflictFingerprint({ flowId: undefined, documentPath: "d.md", topic: "t", positions: [p1, p2] }),
    conflictFingerprint({ flowId: undefined, documentPath: "d.md", topic: "t", positions: [p1, p2] })
  );
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @magpie/api` — Expected: FAIL.

- [ ] **Step 3: Write the migration**

`0061_source_conflicts.sql` — table per the spec's data model, with `UNIQUE (fingerprint)` and an index on `(status, flow_id)`. Follow the write-a-migration skill: append-only, `NNNN_` prefix must be unique.

- [ ] **Step 4: Implement the store**

`conflictFingerprint` = sha256 over `flowId ?? " default"`, documentPath, the sorted `sourceId:path` pairs, and the topic lowercased with whitespace collapsed.

`upsert` bumps `seen_count` and `last_seen_at` on fingerprint conflict and **never changes `status`** — that is what keeps a dismissal sticky.

- [ ] **Step 5: Run the tests**

Run: `npm test -w @magpie/api` then `npm run test:db`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db apps/api && git commit -m "feat(api): source-conflict store and migration"
```

---

### Task 5: Verify-lens routing

**Files:**
- Modify: `apps/api/src/scheduling/verify-lens.ts`
- Modify: `packages/core/src/index.ts` (`VerifyFinding`, ~1611)
- Test: `apps/api/src/scheduling/verify-lens.test.ts`

**Interfaces:**
- Consumes: `VerifyDocumentJobOutput.conflicts` / `.resolvedConflicts` (Task 1), `SourceConflictStore` (Task 4).
- Produces: `VerifyLensResult` gains `conflicts: DetectedSourceConflict[]` and `resolved: ResolvedSourceConflict[]`, each tagged with its document path.

- [ ] **Step 1: Write the failing test**

```ts
test("a conflicted claim never becomes a corrective intent", async () => {
  const result = await runVerifyLens(ctx, {
    flowId: "f1",
    documents: [{ path: "d.md", content: "..." }],
    sources: [],
    verifyDocument: async () => ({
      verdict: "healthy",
      claims: [],
      conflicts: [conflict({ claim: "Logs are retained for 1 year." })]
    })
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.conflicts.length, 1);
});

test("a stale claim and a conflict in one document produce both outcomes", async () => {
  const result = await runVerifyLens(ctx, {
    /* verifyDocument returns verdict "unprovable" with one claim AND one conflict */
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].claims.length, 1);
  assert.equal(result.conflicts.length, 1);
});

test("a document with only conflicts still counts as checked", async () => {
  // healthy verdict + conflicts must appear in checkedPaths, or the change gate
  // never stamps it and the doc re-verifies forever.
  assert.deepEqual(result.checkedPaths, ["d.md"]);
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @magpie/api` — Expected: FAIL.

- [ ] **Step 3: Implement**

In `runVerifyLens`, after the `checkedPaths.push(document.path)` line, collect `verdict.conflicts` and `verdict.resolvedConflicts` (each with the doc path) into the result. Leave the `healthy || claims.length === 0` early-continue and the `decideReconciliation` call untouched — conflicts must never reach the gate.

- [ ] **Step 4: Run the tests**

Run: `npm test -w @magpie/api` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/core && git commit -m "feat(api): route source conflicts out of the corrective path in the verify lens"
```

---

### Task 6: Patrol wiring — known conflicts, gate exemption, annotation, repair

**Files:**
- Modify: `apps/api/src/features/patrol/service.ts`
- Create: `apps/api/src/features/patrol/conflict-annotation.ts`
- Test: `apps/api/src/features/patrol/service.test.ts`, `apps/api/src/features/patrol/conflict-annotation.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–5.
- Produces: `annotateConflict(ctx, args)` and `repairResolvedConflict(ctx, args)` in `conflict-annotation.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a document with an open conflict is re-checked despite unchanged hashes", async () => {
  // Seed the cursor with the doc's current content + sources hash, and one open
  // conflict. Without the exemption the change gate skips it forever and the
  // conflict can never be observed as resolved (patrol-hash.ts:19 — a
  // source-content-only change does not bust the gate).
  const outcome = await runFixPatrol(ctx, { flowId: "f1", trigger: "manual" }, deps);
  assert.deepEqual(verifiedPaths, ["d.md"]);
});

test("verify input carries the document's open conflicts", async () => {
  assert.deepEqual(capturedInput.knownConflicts, [{ id: "c1", topic: "log retention", summary: "..." }]);
});

test("a new conflict creates one annotation proposal and records it", async () => {
  await runFixPatrol(...);
  const proposals = await ctx.stores.proposals.list(10);
  assert.equal(proposals.length, 1);
  assert.match(proposals[0].markdown, /<!-- magpie:conflict id=/);
  assert.match(proposals[0].title, /^Conflict:/);
});

test("a re-detected conflict does not re-annotate", async () => {
  // Second tick over a doc already carrying the marker: no new proposal.
  assert.equal((await ctx.stores.proposals.list(10)).length, 1);
});

test("a resolved conflict strips the marker and enqueues a correct_document repair", async () => {
  assert.equal((await ctx.stores.sourceConflicts.get("c1"))?.status, "resolved");
  assert.equal(correctDocumentCalls[0].claims[0].reason, "sources previously disagreed; they now agree: Logs are retained for 60 days.");
  assert.ok(!correctDocumentCalls[0].content.includes("magpie:conflict"));
});
```

- [ ] **Step 2: Run them**

Run: `npm test -w @magpie/api` — Expected: FAIL.

- [ ] **Step 3: Implement the gate exemption and known-conflict input**

In `runFixPatrol`, before the change gate:

```ts
// Documents with an open conflict are exempt from the change gate. The gate
// re-arms on document content or source CONFIGURATION only (patrol-hash.ts), so
// an annotated doc whose sources are later fixed would otherwise be skipped
// forever and its conflict could never be observed as resolved. Self-limiting:
// it only ever applies to docs awaiting exactly that source-content change.
const conflictedPaths = new Set(await ctx.stores.sourceConflicts.listOpenPaths(options.flowId));
const toCheck = actionableDocuments.filter((doc) => {
  if (conflictedPaths.has(doc.path)) return true;
  const prior = priorByPath.get(doc.path);
  return !(prior?.contentHash === contentHashByPath.get(doc.path) && prior?.sourcesHash === sourcesHash);
});
```

In `makeDefaultVerifyDocument`, load the doc's open conflicts and add `knownConflicts` to the input (omit the field entirely when empty so the rendered prompt stays byte-identical for unconflicted docs). Add the known-conflict ids to `verifyDocumentReuseKey` — a verify told about different conflicts is different work.

- [ ] **Step 4: Implement annotation and repair**

`annotateConflict`: upsert the conflict; if `created` and the document does not already carry the marker, insert it, create a draft proposal (`title: \`Conflict: ${topic} in ${path}\``, `targetPath`, `markdown`, rationale naming the competing positions, `flowId`, `destinationId`, no `jobId`), record `annotatedProposalId`, and publish it with `ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish")`. Conflicts never enter `decideReconciliation`.

`repairResolvedConflict`: mark resolved, strip the marker from the current document content, and call the tick's `correctDocument` with a single claim `{ claim, reason: \`sources previously disagreed; they now agree: ${agreedStatement}\` }`.

Wire both into `runFixPatrol` after the verify lens, and add conflict counts to the `MaintenanceRun` summary/details.

- [ ] **Step 5: Run the tests**

Run: `npm test -w @magpie/api && npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api && git commit -m "feat(api): annotate conflicted documents and repair them once sources agree"
```

---

### Task 7: API routes

**Files:**
- Create: `apps/api/src/features/source-conflicts/routes.ts`, `apps/api/src/features/source-conflicts/service.ts`
- Test: `apps/api/src/features/source-conflicts/routes.test.ts`
- Modify: `apps/api/src/app.ts` (mount at `/api/source-conflicts`)

**Interfaces:**
- Consumes: `SourceConflictStore` (Task 4).
- Produces: `GET /api/source-conflicts?flowId&status`, `PATCH /api/source-conflicts/:id`.

- [ ] **Step 1: Write the failing test**

```ts
test("GET lists conflicts filtered by status", async () => { /* 200, array */ });
test("PATCH dismisses with a note", async () => {
  const res = await request(app).patch(`/api/source-conflicts/${id}`).send({ status: "dismissed", note: "policy wins" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "dismissed");
});
test("PATCH cannot resolve by hand", async () => {
  // Resolution is evidence-based and comes from the sources.
  const res = await request(app).patch(`/api/source-conflicts/${id}`).send({ status: "resolved" });
  assert.equal(res.status, 400);
});
test("a conflict in another flow reads as 404", async () => { /* not 403 */ });
```

- [ ] **Step 2: Run it** — `npm test -w @magpie/api`, Expected: FAIL.

- [ ] **Step 3: Implement**

`GET` requires `read:knowledge`; `PATCH` requires `manage:knowledge`. Both apply the flow-scoped capability check used by the proposals routes (`routes.flow-scope.test.ts` is the pattern), and a cross-flow id returns 404.

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): source-conflicts routes"
```

---

### Task 8: Console page

**Files:**
- Create: `apps/web/src/app/conflicts/page.tsx` and its client component
- Modify: `apps/web/src/lib/sections.ts` (add the `/conflicts` nav entry)

**Interfaces:**
- Consumes: `GET /api/source-conflicts`, `PATCH /api/source-conflicts/:id`.

- [ ] **Step 1: Add the nav entry and page**

Follow the `/gaps` page as the structural model. Each row: topic + summary, every position side by side (source, path, statement), the document and anchor it surfaced under, status, first/last seen with `seenCount`. One action: Dismiss with a note.

Built from `src/components/ui/` primitives with colocated Emotion `styled` reading `p => p.theme.*`. No `.css` file. Scope-gated server-side and rendered unconditionally (the console holds no client-side scope state).

- [ ] **Step 2: Verify in the browser**

Start the stack per the run-magpie skill, seed a conflict directly in the store, load `/conflicts`, and confirm the list renders and Dismiss round-trips. Note: the web test harness cannot fire `onChange` for text inputs, so verify the note field in-browser rather than in a unit test.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): conflicts review page"
```

---

### Task 9: Documentation and verify

**Files:**
- Create: `docs/source-conflicts.md`
- Modify: `docs/ai-jobs.md`, `docs/api.md`, `docs/README.md`, `.claude/skills/magpie-orientation/SKILL.md`

- [ ] **Step 1: Write the docs**

`docs/source-conflicts.md` covers the concept, the five-step lifecycle, the register, and the two hazards (re-annotation loop, change-gate exemption). Update `docs/ai-jobs.md` for the extended `verify_document` contract and the conflict/unprovable split; `docs/api.md` for the two routes; the orientation skill's feature map and job-catalog cheat sheet (job count drops from 27 to 26, AI jobs from 18 to 17).

- [ ] **Step 2: Full gate**

Run: `npm run build && npm test && npm run test:db && npm run verify`
Expected: all green.

- [ ] **Step 3: Commit and open the PR**

```bash
git add docs .claude && git commit -m "docs: source-conflict detection"
git push -u origin claude/magpie-inconsistency-detection-98d978
```

---

## Self-review

**Spec coverage.** Concept → Task 1. Lifecycle → Tasks 5–6. Job contract → Task 1. Prompt → Task 2. Marker → Task 3. Loop hazard → Tasks 3 (idempotent insert) and 6 (knownConflicts). Change-gate exemption → Task 6. Data model + fingerprint → Task 4. Lens routing → Task 5. Repair → Task 6. `detect_contradiction` removal → Task 1. API → Task 7. Console → Task 8. Testing → distributed. Docs → Task 9. Deferred source-map patrol → out of scope by design.

**Type consistency.** `DetectedSourceConflict` (from the agent) and `SourceConflict` (the stored row) are deliberately different types; the store's `upsert` bridges them. `conflictFingerprint` takes the same field names in Tasks 4 and 6.
