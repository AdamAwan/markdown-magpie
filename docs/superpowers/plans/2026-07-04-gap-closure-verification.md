# Gap-Closure Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a proposal merges and its destination re-indexes, re-ask the questions that triggered the gap and mark the gap resolved only when the merged doc actually answers them (deterministic confidence + citation test); otherwise reopen with the verification detail.

**Architecture:** A new non-provider `verify_gap_closure` maintenance job. The watcher's maintenance runner claims it and POSTs `POST /api/proposals/:id/verify-closure`. The API endpoint re-asks each triggering question via `runJobToCompletion("answer_question", …)` (flow pinned via `requestedFlowId`), runs a deterministic closure evaluation, and either resolves the gaps (verified) or leaves them open and records the failed verification (reopened / needs_attention). The merge cascade is rewired to enqueue this job instead of blindly resolving gaps.

**Tech Stack:** TypeScript (ESM/NodeNext, explicit `.js` import extensions), Node ≥22.13, npm workspaces, Zod schemas, Postgres via custom SQL migrator, `node:test`, Next.js (web).

## Global Constraints

- **Queue-only for generative work.** The API must NOT call a chat provider inline. Re-asks go through `runJobToCompletion("answer_question", …)` which enqueues a job a provider watcher claims. Embeddings-inline is unaffected.
- **Never cast through `unknown`/`any`.** Fix types properly.
- **ESM/NodeNext:** every relative import needs an explicit `.js` extension, even from `.ts`.
- **Validate as you go:** run `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` per task — do not batch.
- **Commit and push after each task.**
- **Migrations are append-only**, `NNNN_` prefixed, no rollback (see write-a-migration skill).
- `QuestionGapSource` currently `"auto" | "manual" | "followup"` (`packages/core/src/index.ts:167`, mirrored `packages/jobs/src/schemas.ts:54`).

---

### Task 1: Add the `verify_gap_closure` job type, schemas, and catalog entry

**Files:**
- Modify: `packages/jobs/src/types.ts:3-28` (JOB_TYPES array)
- Modify: `packages/jobs/src/schemas.ts` (add input/output schemas near the other maintenance schemas ~line 440-479)
- Modify: `packages/jobs/src/catalog.ts` (add a `define(...)` entry in the `definitions` object, after `editorial_patrol`)
- Test: `packages/jobs/src/catalog.test.ts` (or the existing jobs test file — check which exists)

**Interfaces:**
- Produces: job type string `"verify_gap_closure"`; `verifyGapClosureInputSchema` = `{ proposalId: string }`; `verifyGapClosureOutputSchema` = `{ proposalId: string; closureStatus: "verified_closed" | "reopened" | "needs_attention"; perQuestion: Array<{ questionId: string; reaskedQuestionId: string | null; verdict: "closed" | "still_open" }> }`.
- Consumes: existing `define(type, "maintenance", inputSchema, outputSchema, expireInSeconds)` helper (`catalog.ts:45`), `jobDefinition(type)` lookup (`catalog.ts:129`).

- [ ] **Step 1: Write the failing test** — assert the definition is registered as a maintenance job with a non-partitioned queue name.

```typescript
// packages/jobs/src/catalog.test.ts  (append)
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobDefinition } from "./catalog.js";

test("verify_gap_closure is a maintenance job with an unpartitioned queue name", () => {
  const def = jobDefinition("verify_gap_closure");
  assert.deepEqual([...def.capabilities], ["maintenance"]);
  assert.equal(def.requiredCapability({ proposalId: "p1" }), "maintenance");
  assert.equal(def.queueName({ proposalId: "p1" }), "verify_gap_closure");
  assert.deepEqual(def.inputSchema.parse({ proposalId: "p1" }), { proposalId: "p1" });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npm test --workspace @magpie/jobs`
Expected: FAIL — `verify_gap_closure` not a valid JobType / definition undefined.

- [ ] **Step 3: Add the type** — insert `"verify_gap_closure",` into `JOB_TYPES` in `packages/jobs/src/types.ts` (after `"editorial_patrol",`).

- [ ] **Step 4: Add the schemas** in `packages/jobs/src/schemas.ts`:

```typescript
export const verifyGapClosureInputSchema = z.object({ proposalId: z.string() });
export const verifyGapClosureOutputSchema = z.object({
  proposalId: z.string(),
  closureStatus: z.enum(["verified_closed", "reopened", "needs_attention"]),
  perQuestion: z.array(
    z.object({
      questionId: z.string(),
      reaskedQuestionId: z.string().nullable(),
      verdict: z.enum(["closed", "still_open"])
    })
  )
});
```

- [ ] **Step 5: Register in the catalog** — in `packages/jobs/src/catalog.ts` `definitions` object, after the `editorial_patrol` line:

```typescript
verify_gap_closure: define("verify_gap_closure", "maintenance", schemas.verifyGapClosureInputSchema, schemas.verifyGapClosureOutputSchema, 60 * 60),
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test --workspace @magpie/jobs && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/jobs && git commit -m "feat(jobs): add verify_gap_closure maintenance job type"
git push
```

---

### Task 2: Migration — `gap_closure_verification` table, `proposals.closure_status`, gap `note` column, extended gap source

**Files:**
- Create: `packages/db/migrations/NNNN_gap_closure_verification.sql` (use the next free `NNNN_` — check the directory; the write-a-migration skill covers the prefix-uniqueness guard)
- Test: run the migrator against a throwaway DB (`npm run db:migrate` / `npm run test:db`)

**Interfaces:**
- Produces tables/columns consumed by Task 4/5/6:
  - `gap_closure_verification(id uuid pk, proposal_id text, gap_cluster_id text null, question_id text, reasked_question_id text null, verdict text, confidence text, cited_merged_doc boolean, detail text, created_at timestamptz default now())`
  - `proposals.closure_status text null` (values `verified_closed|reopened|needs_attention`)
  - `gaps.note text null` (the gaps table backs `insertGapRows`, `postgres-question-log-store.ts:542`)

- [ ] **Step 1: Confirm the current gaps table + proposals table column set.** Read `packages/db/migrations/` for the tables named `gaps` and `proposals` to get exact column definitions and the current highest `NNNN_` prefix.

- [ ] **Step 2: Write the migration** (adjust identifiers to match the existing schema exactly):

```sql
-- NNNN_gap_closure_verification.sql
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS closure_status text;

ALTER TABLE gaps ADD COLUMN IF NOT EXISTS note text;

CREATE TABLE IF NOT EXISTS gap_closure_verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id text NOT NULL,
  gap_cluster_id text,
  question_id text NOT NULL,
  reasked_question_id text,
  verdict text NOT NULL,
  confidence text NOT NULL,
  cited_merged_doc boolean NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gap_closure_verification_question_idx
  ON gap_closure_verification (question_id, verdict);
CREATE INDEX IF NOT EXISTS gap_closure_verification_proposal_idx
  ON gap_closure_verification (proposal_id);
```

- [ ] **Step 3: Apply against a throwaway DB**

Run: `npm run db:migrate` (with local `.env` per run-magpie), or `npm run test:db` which spins one up.
Expected: migration applies cleanly; prefix-uniqueness guard passes.

- [ ] **Step 4: Commit**

```bash
git add packages/db && git commit -m "feat(db): gap_closure_verification table, proposals.closure_status, gaps.note"
git push
```

---

### Task 3: Extend `QuestionGap` (source values + note) end-to-end

**Files:**
- Modify: `packages/core/src/index.ts:164-172` (`QuestionGapSource`, `QuestionGap`)
- Modify: `packages/jobs/src/schemas.ts:54` (gap source enum in `questionGapSchema`)
- Modify: `apps/api/src/stores/postgres-question-log-store.ts` (`insertGapRows` ~542, the gap row select ~355, and the `Array<{ summary; source }>` shapes to include `note`)
- Test: `apps/api/src/stores/postgres-question-log-store.test.ts` (integration, gated) + a core unit test if one exists

**Interfaces:**
- Produces: `QuestionGapSource = "auto" | "manual" | "followup" | "verification" | "needs_attention"`; `QuestionGap` gains `note?: string`.
- Consumes: existing `insertGapRows(client, questionId, gaps)` where `gaps: Array<{ summary: string; source: QuestionGapSource; note?: string }>`.

- [ ] **Step 1: Update the core type** in `packages/core/src/index.ts`:

```typescript
export type QuestionGapSource = "auto" | "manual" | "followup" | "verification" | "needs_attention";

export interface QuestionGap {
  summary: string;
  source: QuestionGapSource;
  // ...existing fields...
  note?: string; // verification detail: what merged, the re-asked answer, why still weak
}
```

- [ ] **Step 2: Update the Zod enum** in `packages/jobs/src/schemas.ts:54`:

```typescript
  source: z.enum(["auto", "manual", "followup", "verification", "needs_attention"]),
  note: z.string().optional()
```

- [ ] **Step 3: Thread `note` through the store.** In `postgres-question-log-store.ts`, extend `insertGapRows` to write `note` and the gap-row SELECT/mapper (~line 355) to read it. Keep existing callers compiling (note is optional).

- [ ] **Step 4: Add a failing→passing integration test** in `postgres-question-log-store.test.ts` that inserts a gap with `source: "verification", note: "…"` and reads it back.

```typescript
// within the gated RUN_PG_INTEGRATION suite
const withNote = { summary: "still weak", question: "q?", confidence: "low", citedSectionIds: [], source: "verification", note: "merged X; re-ask still low; missing Y" };
// record → reload → assert the gap round-trips with source "verification" and the note
```

- [ ] **Step 5: Build + typecheck + tests**

Run: `npm run build && npm run typecheck && RUN_PG_INTEGRATION=1 npm run test:db`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/jobs apps/api && git commit -m "feat(core): QuestionGap gains verification/needs_attention sources + note"
git push
```

---

### Task 4: Closure evaluator + citation→merged-doc resolver (pure functions)

**Files:**
- Create: `apps/api/src/features/proposals/closure-eval.ts`
- Test: `apps/api/src/features/proposals/closure-eval.test.ts`

**Interfaces:**
- Produces:
  - `proposalTargetPaths(proposal: Proposal): Set<string>` — the merged doc paths: `targetPath` plus every `changeset[].path` that has content (a write, not a delete).
  - `citesMergedDoc(citations: Citation[], targetPaths: Set<string>): boolean` — true if any citation `path` ∈ targetPaths.
  - `evaluateClosure(answer: { confidence: Confidence; citations: Citation[] } | undefined, targetPaths: Set<string>): "closed" | "still_open"` — `closed` iff `confidence ∈ {high, medium}` AND `citesMergedDoc(...)`. Undefined/timeout answer → `still_open`.
- Consumes: `Proposal`, `Citation`, `Confidence` from `@magpie/core` (`packages/core/src/index.ts`). `Confidence` values include `high | medium | low | unknown`.

- [ ] **Step 1: Write the failing tests (table-driven)**

```typescript
// closure-eval.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateClosure, proposalTargetPaths, citesMergedDoc } from "./closure-eval.js";

const cite = (path: string) => ({ documentId: "d", sectionId: "s", path, heading: "h", anchor: "a", excerpt: "e", relevance: 0.9 });
const paths = new Set(["docs/guide.md"]);

test("closed when confident and cites the merged doc", () => {
  assert.equal(evaluateClosure({ confidence: "high", citations: [cite("docs/guide.md")] }, paths), "closed");
  assert.equal(evaluateClosure({ confidence: "medium", citations: [cite("docs/guide.md")] }, paths), "closed");
});
test("still_open when confident but cites a different doc", () => {
  assert.equal(evaluateClosure({ confidence: "high", citations: [cite("docs/other.md")] }, paths), "still_open");
});
test("still_open when it cites the doc but is not confident", () => {
  assert.equal(evaluateClosure({ confidence: "low", citations: [cite("docs/guide.md")] }, paths), "still_open");
  assert.equal(evaluateClosure({ confidence: "unknown", citations: [cite("docs/guide.md")] }, paths), "still_open");
});
test("still_open when there is no answer (timeout)", () => {
  assert.equal(evaluateClosure(undefined, paths), "still_open");
});
test("proposalTargetPaths includes targetPath and changeset writes only", () => {
  const p = { targetPath: "docs/guide.md", changeset: [{ path: "docs/b.md", content: "x" }, { path: "docs/del.md" }] } as never;
  const s = proposalTargetPaths(p);
  assert.ok(s.has("docs/guide.md") && s.has("docs/b.md") && !s.has("docs/del.md"));
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test --workspace @magpie/api -- closure-eval` (or the repo's file-scoped test command)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `closure-eval.ts`**

```typescript
import type { Citation, Confidence, Proposal } from "@magpie/core";

const CONFIDENT: ReadonlySet<Confidence> = new Set(["high", "medium"] as const);

export function proposalTargetPaths(proposal: Proposal): Set<string> {
  const paths = new Set<string>();
  if (proposal.targetPath) paths.add(proposal.targetPath);
  for (const change of proposal.changeset ?? []) {
    if (typeof change.content === "string") paths.add(change.path);
  }
  return paths;
}

export function citesMergedDoc(citations: Citation[], targetPaths: Set<string>): boolean {
  return citations.some((c) => targetPaths.has(c.path));
}

export function evaluateClosure(
  answer: { confidence: Confidence; citations: Citation[] } | undefined,
  targetPaths: Set<string>
): "closed" | "still_open" {
  if (!answer) return "still_open";
  return CONFIDENT.has(answer.confidence) && citesMergedDoc(answer.citations, targetPaths)
    ? "closed"
    : "still_open";
}
```

(If `Confidence` is not exported from `@magpie/core`, use the confidence literal union already defined there — check `packages/core/src/index.ts` and import the right name; do NOT redefine it.)

- [ ] **Step 4: Run, expect pass**

Run: `npm test --workspace @magpie/api -- closure-eval`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/proposals/closure-eval.ts apps/api/src/features/proposals/closure-eval.test.ts
git commit -m "feat(api): deterministic gap-closure evaluator + citation resolver"
git push
```

---

### Task 5: Verification service + `POST /api/proposals/:id/verify-closure` endpoint

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts` (add `verifyGapClosure`; rewire `runMergeCascade`)
- Modify: `apps/api/src/features/proposals/routes.ts` (add the route)
- Create: `apps/api/src/stores/gap-closure-verification-store.ts` (insert + count-prior-fails)
- Test: `apps/api/src/features/proposals/verify-closure.test.ts` (integration, gated)

**Interfaces:**
- Consumes: `runJobToCompletion(ctx, "answer_question", input, { deadlineMs })` (`apps/api/src/features/jobs/service.ts:104`); `evaluateClosure`/`proposalTargetPaths` (Task 4); `resolveGaps(questionIds, summaries, proposalId)` (`postgres-question-log-store.ts:386`); `getQuestion`/question-log read for confidence+citations; the answer_question input shape (`packages/jobs/src/schemas.ts:102`, requires `provider`, `question`, `flows`, optional `requestedFlowId`, `expectedOutput: "answer_result"`, `questionLogId`).
- Produces: `verifyGapClosure(ctx, proposal): Promise<VerifyGapClosureOutput>` (matches `verifyGapClosureOutputSchema`); a store with `recordVerification(row)` and `countPriorStillOpen(questionId): Promise<number>`.

- [ ] **Step 1: Write the failing integration test** (gated by `RUN_PG_INTEGRATION`). Use deterministic provider fixtures so the re-asked `answer_question` completes with a controllable confidence + citation path. Assert:
  - a proposal whose re-asked answer is confident + cites `targetPath` → `closure_status = "verified_closed"`, `resolveGaps` called (gaps resolved), a `gap_closure_verification` row with `verdict = "closed"`.
  - a proposal whose re-ask is low-confidence → `closure_status = "reopened"`, gaps NOT resolved, a `QuestionGap` with `source: "verification"` and a `note`, a verification row with `verdict = "still_open"`.
  - after 2 prior still-open rows for the question → `closure_status = "needs_attention"`, gap recorded with `source: "needs_attention"`.

Follow writing-magpie-tests for the throwaway-container harness + fixtures.

- [ ] **Step 2: Implement the store** `gap-closure-verification-store.ts`:

```typescript
import type pg from "pg";

export interface GapClosureVerificationRow {
  proposalId: string;
  gapClusterId: string | null;
  questionId: string;
  reaskedQuestionId: string | null;
  verdict: "closed" | "still_open";
  confidence: string;
  citedMergedDoc: boolean;
  detail: string | null;
}

export async function recordVerification(pool: pg.Pool, row: GapClosureVerificationRow): Promise<void> {
  await pool.query(
    `INSERT INTO gap_closure_verification
       (proposal_id, gap_cluster_id, question_id, reasked_question_id, verdict, confidence, cited_merged_doc, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.proposalId, row.gapClusterId, row.questionId, row.reaskedQuestionId, row.verdict, row.confidence, row.citedMergedDoc, row.detail]
  );
}

export async function countPriorStillOpen(pool: pg.Pool, questionId: string): Promise<number> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM gap_closure_verification WHERE question_id = $1 AND verdict = 'still_open'`,
    [questionId]
  );
  return res.rows[0]?.n ?? 0;
}
```

(Match the repo's store wiring — stores are attached to `ctx.stores`; register this alongside the others rather than passing a raw pool if that is the established pattern. Read a neighboring store to mirror how the pool is accessed.)

- [ ] **Step 3: Implement `verifyGapClosure` in `service.ts`.** For each triggering question of the proposal: build the answer_question input with `requestedFlowId = proposal.flowId`, `flows` = the single pinned flow, `provider = ctx.config.get().aiProvider`, `expectedOutput: "answer_result"`; call `runJobToCompletion` with a deadline; read the completed answer (confidence + citations); `evaluateClosure(...)`. Aggregate all-or-nothing. On all-closed → `resolveGaps`. On any-still-open → record a `QuestionGap` (`source: "verification"` normally, `source: "needs_attention"` when `countPriorStillOpen >= 2`) with a `note`; set `closure_status` accordingly. Persist `closure_status` on the proposal (add a store method). Record a `gap_closure_verification` row per question.

Persist per-proposal `closure_status` via a new `proposalStore` method (e.g. `setClosureStatus(id, status)`) — mirror an existing status-setter.

- [ ] **Step 4: Rewire `runMergeCascade`** (`service.ts:59`). Instead of `resolveGapsForMergedProposal` blindly, re-index first, then enqueue `verify_gap_closure { proposalId }` **only when the proposal has ≥1 `triggeringQuestionId`** (skip clusterless/seed proposals — for those keep today's behavior/no-op). The enqueue uses `ctx.jobs.create("verify_gap_closure", { proposalId })`. Leave the resolution to the verification path.

```typescript
export async function runMergeCascade(ctx: AppContext, proposal: Proposal): Promise<{ reindexed: boolean; verificationEnqueued: boolean }> {
  const reindexed = await reindexDestinationForProposal(ctx, proposal);
  const hasTriggers = (proposal.triggeringQuestionIds ?? []).length > 0;
  if (hasTriggers) await ctx.jobs.create("verify_gap_closure", { proposalId: proposal.id });
  return { reindexed, verificationEnqueued: hasTriggers };
}
```

- [ ] **Step 5: Add the route** in `routes.ts` (mirror the maintenance/reconcile endpoints; guard with the same scope those use):

```typescript
app.post("/:id/verify-closure", requireScopes("manage:jobs"), async (c) => {
  const proposal = await proposalsService.getProposal(ctx, c.req.param("id"));
  if (!proposal) throw new HttpError(404, "proposal_not_found");
  const result = await proposalsService.verifyGapClosure(ctx, proposal);
  return c.json(result);
});
```

- [ ] **Step 6: Build, typecheck, run the gated integration test**

Run: `npm run build && npm run typecheck && RUN_PG_INTEGRATION=1 npm run test:db`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api && git commit -m "feat(api): verify-closure endpoint gates gap resolution on re-ask evidence"
git push
```

---

### Task 6: Watcher — claim `verify_gap_closure` and POST the endpoint

**Files:**
- Modify: `apps/watcher/src/runners/maintenance.ts` (supported types + dispatch)
- Modify: `apps/watcher/src/http-client.ts` (add `verifyClosure(proposalId, signal)` using the maintenance timeout)
- Test: `apps/watcher/src/runners/maintenance.test.ts` (if present) — assert dispatch calls the client

**Interfaces:**
- Consumes: `verify_gap_closure` input `{ proposalId }`; `MaintenanceRunner` at `maintenance.ts:22`, supported list at `:11-16`, `DEFAULT_MAINTENANCE_TIMEOUT_MS` at `http-client.ts:100`.
- Produces: on `run`, POSTs `/api/proposals/:proposalId/verify-closure` and returns the endpoint's JSON.

- [ ] **Step 1: Write/extend a failing runner test** asserting `MaintenanceRunner.supports("verify_gap_closure") === true` and that `run` on such a job calls `api.verifyClosure(proposalId, signal)`.

- [ ] **Step 2: Add the supported type** to the maintenance runner's supported-types list (`maintenance.ts:11-16`) and a dispatch branch in `run()` that reads `proposalId` from the job input and calls `this.api.verifyClosure(proposalId, signal)`.

- [ ] **Step 3: Add the client method** in `http-client.ts`:

```typescript
async verifyClosure(proposalId: string, signal: AbortSignal): Promise<unknown> {
  return this.request(`/api/proposals/${proposalId}/verify-closure`, { method: "POST", signal }, this.maintenanceTimeoutMs);
}
```

(Match the exact `request(...)` signature used by `reconcileGaps` at `http-client.ts:162`.)

- [ ] **Step 4: Build + typecheck + tests**

Run: `npm run build && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher && git commit -m "feat(watcher): maintenance runner drives verify_gap_closure"
git push
```

---

### Task 7: Web — closure badge on the Proposals page

**Files:**
- Modify: `apps/web/src/app/proposals/page.tsx` (+ whatever client/data hook feeds it) to render `closure_status`
- Modify: the API proposal serializer so `closureStatus` is returned on proposals (check `apps/api/src/features/proposals/routes.ts` GET + the proposal DTO mapping)
- Test: type/build check; a light component/render check if the page has tests

**Interfaces:**
- Consumes: `proposal.closureStatus: "verified_closed" | "reopened" | "needs_attention" | null` from the proposals list API.
- Produces: a badge — *Verified closed* (positive), *Reopened* (warning), *Needs attention* (danger) — with per-question detail available via the `gap_closure_verification` rows (a `GET /api/proposals/:id/closure` read endpoint may be added if the page needs the breakdown; otherwise the badge alone ships in v1 and the breakdown is a follow-up).

- [ ] **Step 1: Ensure the API returns `closureStatus`.** Add it to the proposal row → DTO mapping (`postgres-proposal-store.ts:159-179` row already has the column after Task 2; map it in the `mapRow`/serializer and the core `Proposal` type if `Proposal` is what the web consumes). Verify with a quick `curl`/existing API test that the field appears.

- [ ] **Step 2: Render the badge** on the proposals page next to the existing status. Match existing badge styling in that file (reuse the status-badge component/classes already there — do not introduce a new styling system).

- [ ] **Step 3: Verify in the running stack** (run-magpie skill): a merged proposal shows the badge. Use the preview tools to confirm render + no console errors.

- [ ] **Step 4: Build + lint + typecheck**

Run: `npm run build && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web apps/api && git commit -m "feat(web): closure-status badge on proposals page"
git push
```

---

### Task 8: Docs

**Files:**
- Modify: `docs/question-logging.md` (the closure loop, verification-gated resolution, the two new gap sources)
- Modify: `docs/architecture.md` (tier table + the new job)
- Modify: `docs/ai-jobs.md` (verify_gap_closure orchestrator + its answer_question re-ask fan-out)
- Modify: `docs/api.md` (`POST /api/proposals/:id/verify-closure`)
- Modify: `.claude/skills/magpie-orientation/SKILL.md` (job list: add `verify_gap_closure`)

- [ ] **Step 1: Update each doc** to describe the merge→re-index→verify→resolve/reopen loop, the deterministic closure test, and that merge no longer blindly resolves gaps.

- [ ] **Step 2: Build the docs-affected workspaces / run full validation**

Run: `npm run build && npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs .claude/skills && git commit -m "docs: gap-closure verification loop"
git push
```

---

## Self-Review

**Spec coverage:**
- Job contract → Task 1. ✅
- Trigger on merge+re-index → Task 5 Step 4 (rewired `runMergeCascade`). ✅
- Re-ask via answer_question, flow pinned → Task 5 Step 3 (`requestedFlowId`). ✅
- Deterministic closure test (confident + cites merged doc) → Task 4. ✅
- Verified → resolve gaps; still-open → reopen with note; inconclusive → still_open; loop guard @2 → needs_attention → Task 5 Steps 1/3. ✅
- Data model (`gap_closure_verification`, `proposals.closure_status`, gap `note` + sources) → Tasks 2 & 3. ✅
- Web badge → Task 7. ✅
- Testing (unit closure-eval + gated integration) → Tasks 4 & 5. ✅
- Docs → Task 8. ✅
- Skip clusterless proposals (no triggering questions) → Task 5 Step 4. ✅

**Placeholder scan:** No TBD/TODO; the one deferred item (per-question breakdown read endpoint) is explicitly optional/v1-follow-up in Task 7, not a gap in required behavior.

**Type consistency:** `evaluateClosure`/`proposalTargetPaths`/`citesMergedDoc` names match between Task 4 definition and Task 5 consumption. `verify_gap_closure` output shape matches between Task 1 schema and Task 5 return. `QuestionGapSource` additions used in Tasks 3 & 5 agree. Confidence set `{high, medium}` consistent with spec.

**Open follow-ups (out of scope, tracked):** regression detection (spec non-goal); insights/trends dashboard (GitHub issue #146); per-question closure breakdown UI (Task 7 note).
