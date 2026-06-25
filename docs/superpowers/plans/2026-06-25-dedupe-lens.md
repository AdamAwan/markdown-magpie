# Dedupe lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the `dedupe` fix-patrol lens — find a doc's k nearest neighbours, detect a genuine duplicate/contradiction, and reconcile the pair through the shared gate as a two-file PR.

**Architecture:** Layer 1 builds reusable file-set Proposal infrastructure (optional `changeset`, multi-target gate, changeset-aware publish). Layer 2 adds the `dedupe_documents` job + lens + completion handler. Layer 3 adds multi-file fold (`fold_changeset_proposal`).

**Tech Stack:** TypeScript ESM monorepo; node:test; Zod job contracts; Postgres + pgvector; @magpie/{core,jobs,prompts,git} workspaces.

## Global Constraints

- UK English in all prose/comments/PR text.
- Workspace tests: `npm test -w @magpie/<pkg>`. The `@magpie/api` suite is ~5 min (testcontainers; 2 skip locally) — batch runs.
- Pre-PR gates: `npm test`, `npm run typecheck`, `npm run deadcode` (knip strict — fix unused exports by de-exporting, never relax config).
- New AI job: add to `JOB_TYPES` (types.ts), `define()` + `aiJobTypes` set (catalog.ts), `EXPIRATION_SECONDS` + routing test (catalog.test.ts), input/output Zod schemas (schemas.ts), core types (core/index.ts), `job-prompts.ts` `buildPrompt` case, a prompt in prompts/catalog.ts with count+order assertions (prompts/catalog.test.ts), and the `/api/prompts` count in apps/api/src/app.test.ts.
- `proposalFlowId` has TWO copies (flow.ts + gap-reconciler.ts) — not touched here, but keep in mind.
- Migrations keyed by filename, lexical order; next is **0030**.
- `ChangesetChange = { path: string; content?: string; delete?: boolean }` (core).

---

### Task 1: `Proposal.changeset` + accessors + store support

**Files:**
- Modify: `packages/core/src/index.ts` (Proposal interface)
- Create: `apps/api/src/scheduling/changeset.ts`
- Create: `apps/api/src/scheduling/changeset.test.ts`
- Modify: `apps/api/src/stores/proposal-store.ts` (ProposalInput, create, ProposalStore iface, InMemory create + new `updateChangeset`)
- Modify: `apps/api/src/stores/postgres-proposal-store.ts` (INSERT, ProposalRow, mapRow, updateChangeset)
- Create: `packages/db/migrations/0030_proposal_changeset.sql`
- Modify: `apps/api/src/stores/proposal-store.test.ts` (changeset round-trip)

**Interfaces produced:**
- `Proposal.changeset?: ChangesetChange[]`
- `proposalChangeset(p: Proposal): ChangesetChange[]`, `proposalTargets(p: Proposal): string[]`
- `ProposalStore.updateChangeset(id, changeset: ChangesetChange[], primaryMarkdown: string): Promise<Proposal | undefined>`

- [ ] **Step 1: Failing accessor tests** — `changeset.test.ts`: single-file proposal (no changeset) → `proposalChangeset` = `[{path: targetPath, content: markdown}]`, `proposalTargets` = `[targetPath]`. Changeset proposal → returns the changeset and its paths.
- [ ] **Step 2: Add `changeset?: ChangesetChange[]` to Proposal** (after `markdown`, with the comment from spec §2). Import already present (`ChangesetChange` defined later in same file — it's exported, same module, fine).
- [ ] **Step 3: Implement `changeset.ts`** with both accessors (spec §2).
- [ ] **Step 4: Run** `npm test -w @magpie/api` (or just node the file) — accessors pass.
- [ ] **Step 5: Store — InMemory:** `ProposalInput` gains `changeset?: ChangesetChange[]`; `create` sets `changeset: input.changeset`; add `updateChangeset(id, changeset, primaryMarkdown)` returning `{...existing, changeset, markdown: primaryMarkdown}`. Add to `ProposalStore` interface.
- [ ] **Step 6: Store — Postgres:** migration `0030_proposal_changeset.sql` = `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS changeset jsonb;`. INSERT adds `changeset` column + `$14` param `input.changeset ? JSON.stringify(input.changeset) : null`. `ProposalRow` gains `changeset: unknown`. `mapRow` sets `changeset: row.changeset ? (row.changeset as ChangesetChange[]) : undefined`. Add `updateChangeset` (UPDATE changeset + markdown, RETURNING *).
- [ ] **Step 7: Failing store test** — create a proposal with a 2-entry changeset; read back; assert changeset persisted. Then `updateChangeset` swaps it and refreshes markdown.
- [ ] **Step 8: Run** `npm test -w @magpie/api` — store tests pass (Postgres test is testcontainer-gated).
- [ ] **Step 9: Commit** `feat(proposals): optional file-set changeset on Proposal + accessors`

---

### Task 2: Gate reports multi-target file-sets

**Files:**
- Modify: `apps/api/src/scheduling/reconcile-gate.ts` (`openPullRequestSummaries`)
- Modify: `apps/api/src/scheduling/reconcile-gate.test.ts`

**Interfaces consumed:** `proposalTargets` (Task 1).

- [ ] **Step 1: Failing test** — a draft proposal with `changeset` of `[A, B]` → `openPullRequestSummaries` yields one summary with `targets: [A, B]`. A single-file proposal still yields `[targetPath]`.
- [ ] **Step 2: Implement** — import `proposalTargets`; in the push, `targets: proposalTargets(proposal)` instead of `[proposal.targetPath]`. The `!proposal.targetPath` guard stays (primary path still required).
- [ ] **Step 3: Run** the gate tests — pass.
- [ ] **Step 4: Commit** `feat(gate): report all changeset paths as the file-set`

---

### Task 3: `publish_proposal` publishes a changeset

**Files:**
- Modify: `apps/watcher/src/runners/publication.ts` (`proposalSchema`, `publishProposal`)
- Modify: `apps/watcher/src/runners/publication.test.ts`

**Notes:** `ProposalExecutionContext.proposal` is `unknown` and the API returns the full `Proposal`, so `changeset` already arrives — no API or WatcherApi type change. `deps.publishChangeset` already exists.

- [ ] **Step 1: Failing test** — proposal-execution-context with a `changeset` → `publishProposal` calls `deps.publishChangeset` with `changes = changeset` (not `deps.publishProposal`); a context without changeset still calls `deps.publishProposal`. Use the existing spy-deps test harness.
- [ ] **Step 2: Implement** — `proposalSchema` gains `changeset: z.array(changesetChangeSchema).optional()`. In `publishProposal()`: after deriving `branchName`/title, `if (proposal.changeset && proposal.changeset.length > 0)` → `await this.deps.publishChangeset({ repository: preparedRepository, branchName, title: \`docs: ${proposal.title}\`, changes: proposal.changeset })`; else the existing `deps.publishProposal` call. PR-raise block unchanged.
- [ ] **Step 3: Run** `npm test -w @magpie/watcher` — pass.
- [ ] **Step 4: Commit** `feat(watcher): publish a changeset proposal via publishChangeset`

---

### Task 4: `dedupe_documents` job contract + prompt

**Files:**
- Modify: `packages/core/src/index.ts` (DedupeDocumentsJobInput/Output)
- Modify: `packages/jobs/src/schemas.ts` (dedupeDocumentsInput/OutputSchema)
- Modify: `packages/jobs/src/types.ts` (JOB_TYPES += "dedupe_documents")
- Modify: `packages/jobs/src/catalog.ts` (define + aiJobTypes)
- Modify: `packages/jobs/src/catalog.test.ts` (EXPIRATION + routing test)
- Modify: `packages/prompts/src/catalog.ts` (DEDUPE_DOCUMENTS + promptCatalog)
- Modify: `packages/prompts/src/catalog.test.ts` (count 14→15, order)
- Modify: `apps/watcher/src/job-prompts.ts` (import + buildPrompt case)
- Modify: `apps/api/src/app.test.ts` (/api/prompts 14→15)

**Interfaces produced:**
```ts
interface DedupeDocumentsJobInput { path; content; neighbours: Array<{path; content}>; destinationId?; flowId? }
interface DedupeDocumentsJobOutput { duplicate: boolean; rationale: string; primaryPath?: string; changeset?: ChangesetChange[] }
```

- [ ] **Step 1: Core types** — add both interfaces (spec §4) after the verify/correct ones.
- [ ] **Step 2: Schemas** — `dedupeDocumentsInputSchema` (`provider`, path, content, neighbours array of {path,content}, destinationId?, flowId?), `dedupeDocumentsOutputSchema` (`duplicate` boolean, rationale string, primaryPath optional, changeset optional array of `{path, content?, delete?}`). Reuse a local `changesetChangeSchema` (mirror the watcher's shape).
- [ ] **Step 3: Register** — `JOB_TYPES += "dedupe_documents"`; `define("dedupe_documents","provider",...,10*60)`; add to `aiJobTypes`.
- [ ] **Step 4: catalog.test** — `dedupe_documents: 10*60` in EXPIRATION_SECONDS; routing test "dedupe_documents routes by provider like other AI work".
- [ ] **Step 5: Failing prompt test** — bump prompts count 14→15, insert `"dedupe-documents"` into the order array (after `"correct-document"`).
- [ ] **Step 6: Prompt** — `DEDUPE_DOCUMENTS` PromptDefinition (id `dedupe-documents`, usedBy `["watcher · fix-patrol"]`, outputShape `{ duplicate, rationale, primaryPath, changeset[] }`, conservative instructions per spec §4); add to `promptCatalog` after `CORRECT_DOCUMENT`.
- [ ] **Step 7: buildPrompt** — import `DEDUPE_DOCUMENTS`; add `case "dedupe_documents"`.
- [ ] **Step 8: app.test** — `/api/prompts` count 14→15.
- [ ] **Step 9: Run** `npm test -w @magpie/jobs`, `-w @magpie/prompts`, `-w @magpie/core` — pass.
- [ ] **Step 10: Commit** `feat(jobs): dedupe_documents job contract + prompt`

---

### Task 5: `dedupeNeighbours` k-NN retrieval

**Files:**
- Create: `apps/api/src/scheduling/dedupe-neighbours.ts`
- Create: `apps/api/src/scheduling/dedupe-neighbours.test.ts`

**Interface produced:** `dedupeNeighbours(ctx, doc: {path; content}, repositoryIds): Promise<Array<{path; content}>>`

- [ ] **Step 1: Failing tests** (use a fake `ctx.stores.knowledgeIndex` with `search()` + `listDocuments()`): (a) neighbours above 0.75 returned, self excluded; (b) below-threshold dropped; (c) capped at 5; (d) nothing above bar → `[]`; (e) section→doc fold takes max score per doc.
- [ ] **Step 2: Implement** — constants `DEDUPE_SIMILARITY_THRESHOLD=0.75`, `DEDUPE_MAX_NEIGHBOURS=5`. `search(doc.content, MAX*4, repositoryIds)` → group ranked sections by `section.path` (or documentId), keep max relevance, drop `doc.path`, filter `>= THRESHOLD`, sort desc, slice MAX, map each path → full document content via `listDocuments()`. Return `[{path, content}]`.
- [ ] **Step 3: Run** the file — pass.
- [ ] **Step 4: Commit** `feat(dedupe): k-NN neighbour retrieval over KB search`

---

### Task 6: `runDedupeLens` + fix-patrol wiring

**Files:**
- Create: `apps/api/src/scheduling/dedupe-lens.ts`
- Create: `apps/api/src/scheduling/dedupe-lens.test.ts`
- Modify: `apps/api/src/features/patrol/service.ts` (`defaultDedupeDocument`, deps, run loop, log)
- Modify: `apps/api/src/features/patrol/service.test.ts`

**Interfaces produced:** `DedupeDocumentFn`, `runDedupeLens(ctx, {flowId, documents, repositoryIds, dedupeDocument}): Promise<number>`.

- [ ] **Step 1: Failing lens test** — docs where `dedupeNeighbours` returns neighbours → `dedupeDocument` called once per such doc with `{path, content, neighbours, flowId, ...}`; docs with no neighbours → not called; returns count enqueued. (Inject neighbour lookup via a fake index in ctx.)
- [ ] **Step 2: Implement `dedupe-lens.ts`** — for each doc: `dedupeNeighbours(ctx, doc, repositoryIds)`; if non-empty, `await dedupeDocument(ctx, {path, content, neighbours, destinationId?, flowId})`, increment count. Per-doc try/catch warn (one bad doc never aborts the tick).
- [ ] **Step 3: Patrol service** — `defaultDedupeDocument` enqueues `dedupe_documents` (mirror `defaultCorrectDocument`, include `provider`); `runFixPatrol` deps gain `dedupeDocument?`; after the verify finding loop call `runDedupeLens` over `selectedDocuments` with `repositoryIds: scope.repositoryIds`; extend the run log with `… N dedupe scan(s) enqueued`.
- [ ] **Step 4: Patrol test** — existing verify tests pass `dedupeDocument: async () => {}`; add a test asserting dedupe runs over the batch via a spy without disturbing verify findings.
- [ ] **Step 5: Run** `npm test -w @magpie/api` — pass.
- [ ] **Step 6: Commit** `feat(patrol): run the dedupe lens over the batch`

---

### Task 7: `createDedupeProposalFromCompletedJob` + completeJob wiring

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts`
- Modify: `apps/api/src/features/proposals/service.test.ts`
- Modify: `apps/api/src/features/jobs/service.ts` (completeJob sequence)
- Modify: `apps/api/src/features/jobs/service.test.ts`

**Interface produced:** `createDedupeProposalFromCompletedJob(ctx, job, output): Promise<Proposal | undefined>`.

- [ ] **Step 1: Failing service tests** — completed `dedupe_documents` with `duplicate:true` + 2-file changeset + `primaryPath` → a draft Proposal with that `changeset`, `targetPath=primaryPath`, `markdown`=primary's content, `title` starts `"Dedupe: "`, `flowId` carried; `duplicate:false` → undefined; `primaryPath` missing from changeset → undefined; same `jobId` twice → same proposal (idempotent).
- [ ] **Step 2: Implement** — import `dedupeDocumentsOutputSchema` + `DedupeDocumentsJobInput`. Guard type; parse; `if (!parsed.data.duplicate || !parsed.data.changeset || !parsed.data.primaryPath) return undefined`; find primary write `parsed.data.changeset.find(c => c.path === primaryPath)`; if none/`content` undefined return undefined; derive neighbour path (the other changeset entry) for the title; `ctx.stores.proposals.create({ title: \`Dedupe: reconcile ${primaryPath} with ${neighbourPath}\`, targetPath: primaryPath, markdown: primaryWrite.content, changeset: parsed.data.changeset, rationale: parsed.data.rationale, evidence: [], flowId: input.flowId, destinationId: input.destinationId, jobId: job.id })`.
- [ ] **Step 3: completeJob** — after the corrective block (jobs/service.ts ~line 175), add the dedupe block mirroring it: `const dedupeProposal = await proposalsService.createDedupeProposalFromCompletedJob(...)`; if present, best-effort `try { await foldService.reconcileDedupeProposal(ctx, dedupeProposal) } catch (warn)`.
- [ ] **Step 4: jobs test** — completing a `dedupe_documents` job drafts the proposal (assert via store).
- [ ] **Step 5: Run** `npm test -w @magpie/api` — pass.
- [ ] **Step 6: Commit** `feat(dedupe): draft a file-set proposal on dedupe_documents completion`

(Note: `reconcileDedupeProposal` lands in Task 8; until then the completeJob call references it — implement Task 8's signature first or stub it. To keep tasks independently green, **do Task 8 before wiring the reconcile call in Step 3**, or land Step 3's reconcile line in Task 8. Chosen: land the `reconcileDedupeProposal` import/call in Task 8.)

---

### Task 8: `reconcileDedupeProposal`

**Files:**
- Modify: `apps/api/src/scheduling/fold.ts`
- Modify: `apps/api/src/scheduling/fold.test.ts`
- Modify: `apps/api/src/features/jobs/service.ts` (wire the reconcile call from Task 7 Step 3)

**Interface produced:** `reconcileDedupeProposal(ctx, proposal): Promise<void>`.

- [ ] **Step 1: Failing fold tests** — dedupe proposal (changeset `[A,B]`, flowId set) with no same-flow overlap → `enqueuePublicationAction(id,"publish")`; with a touchable open PR sharing a path → enqueues `fold_changeset_proposal` (Task 9 contract); overlap only with an approved PR → defer → publish.
- [ ] **Step 2: Implement** — mirror `reconcileCorrectiveProposal` but `intent.targets = proposalTargets(proposal)`, `lens: "dedupe"`; on `fold`, fetch survivor and enqueue `fold_changeset_proposal` (Task 9 input shape); else `enqueuePublicationAction`. Import `proposalChangeset`/`proposalTargets`.
- [ ] **Step 3: Wire completeJob** — add the `reconcileDedupeProposal` import + the best-effort call deferred from Task 7 Step 3.
- [ ] **Step 4: Run** `npm test -w @magpie/api` — pass.
- [ ] **Step 5: Commit** `feat(dedupe): reconcile a corrective dedupe proposal through the gate`

---

### Task 9: `fold_changeset_proposal` job contract + prompt

**Files:** same registration set as Task 4, plus core types.

**Interfaces produced:**
```ts
interface FoldChangesetProposalJobInput { survivorProposalId; rivalProposalId; survivorChangeset: ChangesetChange[]; rivalChangeset: ChangesetChange[]; sharedPaths: string[]; expectedOutput: "folded_changeset" }
interface FoldChangesetProposalJobOutput { changeset: ChangesetChange[]; rationale: string }
```

- [ ] **Step 1: Core types** — add both.
- [ ] **Step 2: Schemas** — `foldChangesetProposalInput/OutputSchema`.
- [ ] **Step 3: Register** — `JOB_TYPES += "fold_changeset_proposal"`; `define(...,15*60)` (mirror `fold_markdown_proposal`); add to `aiJobTypes`.
- [ ] **Step 4: catalog.test** — EXPIRATION `15*60` + routing test.
- [ ] **Step 5: Failing prompt test** — count 15→16, insert `"fold-changeset-proposal"` into order (after `"fold-markdown-proposal"`).
- [ ] **Step 6: Prompt** `FOLD_CHANGESET_PROPOSAL` (spec §6 instructions) added to `promptCatalog` after `FOLD_MARKDOWN_PROPOSAL`.
- [ ] **Step 7: buildPrompt** case.
- [ ] **Step 8: app.test** `/api/prompts` 15→16.
- [ ] **Step 9: Run** `npm test -w @magpie/jobs -w @magpie/prompts -w @magpie/core` (separately) — pass.
- [ ] **Step 10: Commit** `feat(jobs): fold_changeset_proposal job contract + prompt`

---

### Task 10: `applyChangesetFoldFromCompletedJob` + fallback + completeJob

**Files:**
- Modify: `apps/api/src/scheduling/fold.ts` (apply handler; widen `enqueueFoldFallback`)
- Modify: `apps/api/src/scheduling/fold.test.ts`
- Modify: `apps/api/src/features/jobs/service.ts` (completeJob + fail path)

**Interface produced:** `applyChangesetFoldFromCompletedJob(ctx, job, output): Promise<void>`.

- [ ] **Step 1: Failing tests** — completed `fold_changeset_proposal` → survivor promoted via `updateChangeset` (changeset = output.changeset, markdown = primary path's content), rival superseded, `enqueuePublicationAction(survivor,"publish")`; no-op when rival already superseded; survivor missing → no-op; widened `enqueueFoldFallback` republishes a still-draft rival on a failed `fold_changeset_proposal`.
- [ ] **Step 2: Implement apply** — parallel to `applyFoldFromCompletedJob`: guard `job.type === "fold_changeset_proposal"`; parse `foldChangesetProposalOutputSchema`; fetch survivor+rival; no-op if missing or rival superseded; compute primaryMarkdown = `output.changeset.find(c => c.path === survivor.targetPath)?.content ?? survivor.markdown`; `updateChangeset(survivor.id, output.changeset, primaryMarkdown)`; `updateStatus(rival.id,"superseded")`; `enqueuePublicationAction(survivor.id,"publish")`; comment on survivor PR if `publication?.pullRequestUrl`.
- [ ] **Step 3: Widen `enqueueFoldFallback`** — guard `job.type === "fold_markdown_proposal" || job.type === "fold_changeset_proposal"` (body is already type-agnostic — reads `rivalProposalId`, republishes).
- [ ] **Step 4: completeJob** — add `await foldService.applyChangesetFoldFromCompletedJob(ctx, existingJob, parsed.data)` next to `applyFoldFromCompletedJob`; the two fold-fallback call sites (invalid-output ~line 149, failed ~line 287) already call `enqueueFoldFallback` only for `fold_markdown_proposal` — widen those guards to include `fold_changeset_proposal`.
- [ ] **Step 5: Run** `npm test -w @magpie/api` — pass.
- [ ] **Step 6: Commit** `feat(dedupe): multi-file fold — apply + fallback`

---

### Task 11: Full gate sweep + finish

- [ ] **Step 1:** `npm test` (all workspaces).
- [ ] **Step 2:** `npm run typecheck`.
- [ ] **Step 3:** `npm run deadcode` (knip strict). De-export anything knip flags (e.g. helpers used only in-file); never relax config. Note: `DEDUPE_DOCUMENTS`/`FOLD_CHANGESET_PROPOSAL` are consumed by job-prompts.ts, so they stay exported; the lens/handler exports are consumed cross-file.
- [ ] **Step 4:** superpowers:finishing-a-development-branch → push + open PR off main.

## Self-review notes

- Type consistency: `DedupeDocumentsJobOutput.changeset` and `FoldChangesetProposalJobInput.*Changeset` all use `ChangesetChange[]`. `updateChangeset(id, changeset, primaryMarkdown)` signature identical in iface + both stores + both call sites.
- Spec coverage: §2→T1/T2, §3→T5, §4→T4, §5→T6/T7/T8, §6→T9/T10, §7 publish→T3 / gate→T2 / labelling→T7 title. §8 edge cases covered by guards in T5/T7/T8/T10. §9 testing distributed across tasks.
- Knip risk: any new exported symbol must be imported somewhere. `proposalChangeset` is used by T8/T10; `proposalTargets` by T2/T8. If knip flags `proposalChangeset` as used-only-in-file at some interim commit, that's fine by the final state.
