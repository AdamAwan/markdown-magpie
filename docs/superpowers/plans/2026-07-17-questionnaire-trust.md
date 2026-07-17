# Questionnaire Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the questionnaire worksheet trustworthy — never hide a grounded answer, and reuse prior answers via a deterministic fast-path plus a grounded LLM reconciliation step (reuse/adapt/merge/fresh) instead of a brittle veto.

**Architecture:** Two phases. **Phase A** stops suppressing grounded low-confidence answers (`unanswerable` ⟺ no citations) and snapshots per-item confidence for display — shippable on its own. **Phase B** folds candidate-priming into the existing `answer_question` job so it can reconcile against the live KB and returns a verdict; the match phase gains top-N candidates and a free deterministic fast-path.

**Tech Stack:** TypeScript (ESM/NodeNext), Node ≥22.13, npm workspaces. Postgres + pgvector. `node:test` + `node:assert/strict`. Custom SQL migrator (`scripts/migrate.mjs`). Zod job schemas (`@magpie/jobs`). Queue-only AI (API enqueues; watcher runs the model).

## Global Constraints

- **Never cast through `unknown`/`any` to silence types.** Fix types properly.
- **Queue-only AI.** The API must not call a chat model inline. Reconciliation runs in the watcher's `answer_question` runner. Embeddings stay the inline exception.
- **Two store implementations.** Every `QuestionnaireStore` interface change must be mirrored in BOTH `InMemoryQuestionnaireStore` and `PostgresQuestionnaireStore` (`apps/api/src/stores/`).
- **Queue schema stripping.** Any new field on `AnswerQuestionJobInput`/`Output` MUST be added to the zod schema in `packages/jobs/src/schemas.ts` (`answerQuestionInputSchema` / `answerQuestionOutputSchema`) or the broker strips it before it reaches the API.
- **Citations are code-derived, never model-trusted.** The watcher builds citations from retrieved sections (`apps/watcher/src/job-prompts.ts` `toCitation`). Do not accept citation objects from the model.
- **Migrations are append-only, no rollback,** tracked by full filename; wrapped in one transaction by the migrator (no manual `BEGIN`/`COMMIT`). Next free prefixes: `0057`, `0058`. Never reuse a prefix.
- **Imports use the `.js` specifier even from `.ts`** (NodeNext).
- **Validate as you go:** `npm run build`, `npm test -w <pkg>`, `npm run typecheck`, `npm run lint`. Commit little and often.

---

## File Structure

**Phase A**
- `packages/db/migrations/0057_questionnaire_item_confidence.sql` — new. Adds `confidence` column.
- `packages/core/src/index.ts` — modify. Add `confidence?: Confidence` to `QuestionnaireItem`.
- `apps/api/src/stores/questionnaire-store.ts` — modify. `completeItem` result gains `confidence`.
- `apps/api/src/stores/postgres-questionnaire-store.ts` — modify. `ItemRow.confidence`, `mapItem`, `completeItem` SQL.
- `apps/api/src/stores/memory-questionnaire-store.ts` — modify (in-memory impl; same file as interface per explorer, confirm at edit time).
- `apps/api/src/features/questionnaires/service.ts:151` — modify the `unanswerable` gate + pass confidence.
- `apps/api/src/features/questionnaires/export.ts` — modify. Show answer + badge; blank only when unanswerable.
- `apps/api/src/features/questionnaires/export.test.ts` — modify. New rendering assertions.
- `apps/api/src/features/questionnaires/service.test.ts` — modify. Gate assertions.

**Phase B**
- `packages/db/migrations/0058_questionnaire_reconcile.sql` — new. Widen `outcome` CHECK; add `questionnaire_item_basis`; add `reconcile_candidate_ids`.
- `packages/core/src/index.ts` — modify. Widen `QuestionnaireItemOutcome`; add `candidates`/`reuse` to answer job I/O.
- `packages/jobs/src/schemas.ts` — modify. Extend `answerQuestionInputSchema` / `answerQuestionOutputSchema`.
- `apps/api/src/platform/config.ts` — modify. `reconcileCandidates`, `reconcileEnabled`.
- `apps/api/src/stores/questionnaire-store.ts` (+ both impls) — modify. `matchApprovedTopN`, `setReconcileCandidates`, `reconcileCandidateIds`, `replaceBasis`, `completeItem` gains verdict/basis.
- `apps/api/src/platform/answer-question.ts` — modify. `buildAnswerQuestionInput` accepts optional `candidates`.
- `apps/api/src/features/questionnaires/service.ts` — modify. Top-N match, fast-path, drip attaches candidates, completion maps verdict.
- `apps/api/src/features/questionnaires/reconcile.ts` — new. Pure fast-path predicate + candidate builder.
- `apps/watcher/src/runners/generative.ts` — modify. `reconcileWithCandidates` step in `answer()`.
- `apps/watcher/src/job-prompts.ts` — modify. Parse/attach the reuse verdict.
- `packages/prompts/src/catalog.ts` — modify. Add `RECONCILE_ANSWER` prompt.
- Tests colocated with each.

---

# PHASE A — Show, don't suppress

### Task A1: Migration — per-item confidence column

**Files:**
- Create: `packages/db/migrations/0057_questionnaire_item_confidence.sql`

**Interfaces:**
- Produces: `questionnaire_items.confidence text NULL` (values `high|medium|low|unknown`).

- [ ] **Step 1: Write the migration**

```sql
-- 0057: Snapshot the answer's confidence onto the questionnaire item so the
-- worksheet is stable and low-confidence answers can be SHOWN with a badge
-- instead of being suppressed. Nullable: existing rows and true abstains have
-- no confidence. See docs/superpowers/specs/2026-07-17-questionnaire-trust-design.md.
ALTER TABLE questionnaire_items
  ADD COLUMN IF NOT EXISTS confidence text
  CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low', 'unknown'));
```

- [ ] **Step 2: Verify migrator accepts the file**

Run: `node --test scripts/lib/migration-order.test.mjs`
Expected: PASS (no duplicate/malformed prefix).

- [ ] **Step 3: Apply to a throwaway DB**

Run: `npm run test:db 2>&1 | tail -20` (boots pgvector container, migrates from scratch)
Expected: migrations apply cleanly through `0057`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/migrations/0057_questionnaire_item_confidence.sql
git commit -m "feat(db): add questionnaire_items.confidence (0057)"
```

---

### Task A2: Snapshot confidence + redefine `unanswerable` as ungrounded

**Files:**
- Modify: `packages/core/src/index.ts` (`QuestionnaireItem`, ~lines 316–334)
- Modify: `apps/api/src/stores/questionnaire-store.ts` (`completeItem` signature, ~L34-37; both impls)
- Modify: `apps/api/src/stores/postgres-questionnaire-store.ts` (`ItemRow`, `mapItem`, `completeItem`)
- Modify: `apps/api/src/features/questionnaires/service.ts` (`handleQuestionnaireAnswerCompletion`, L151-158)
- Test: `apps/api/src/features/questionnaires/service.test.ts`

**Interfaces:**
- Consumes: `AnswerQuestionJobOutput.confidence: Confidence` (core), `output.citations` (core).
- Produces: `QuestionnaireItem.confidence?: Confidence`; `completeItem(questionLogId, { answer, answeredAt, citations, unanswerable, confidence })`.

- [ ] **Step 1: Write the failing test** (append to `service.test.ts`)

```ts
test("low-confidence answer WITH citations is answered (shown), not suppressed", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "Trust", flowId: "security", questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
  const logId = (jobs[0]!.input as { questionLogId: string }).questionLogId;

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, jobs[0], {
    answer: "A grounded but hedged answer.",
    confidence: "low",
    citations: [{ documentId: "d", sectionId: "s1", path: "p.md", heading: "H", anchor: "h", excerpt: "e", relevance: 0.5 }]
  });

  const item = await ctx.stores.questionnaires.itemByQuestionLogId(logId);
  assert.equal(item?.status, "answered");
  assert.equal(item?.confidence, "low");
  assert.equal(item?.answer, "A grounded but hedged answer.");
});

test("answer with ZERO citations is unanswerable regardless of confidence", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "Trust2", flowId: "security", questions: ["q0"]
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const { jobs } = await ctx.jobs.list({ type: "answer_question" });
  const logId = (jobs[0]!.input as { questionLogId: string }).questionLogId;

  await questionnaires.handleQuestionnaireAnswerCompletion(ctx, jobs[0], {
    answer: "Ungrounded guess.", confidence: "high", citations: []
  });

  const item = await ctx.stores.questionnaires.itemByQuestionLogId(logId);
  assert.equal(item?.status, "unanswerable");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/api -- --test-name-pattern="not suppressed|unanswerable regardless"`
Expected: FAIL — first test gets `status: "unanswerable"` (old gate); `confidence` undefined.

- [ ] **Step 3: Add `confidence` to the core type**

In `packages/core/src/index.ts`, inside `interface QuestionnaireItem`, add after `answer?: string;`:

```ts
  confidence?: Confidence;
```

- [ ] **Step 4: Widen `completeItem` in the store interface**

In `apps/api/src/stores/questionnaire-store.ts`, change the `completeItem` result type to include confidence:

```ts
  completeItem(
    questionLogId: string,
    result: {
      answer: string;
      answeredAt: string;
      citations: QuestionnaireItemCitation[];
      unanswerable: boolean;
      confidence: Confidence;
    }
  ): Promise<QuestionnaireItem | undefined>;
```

Add `Confidence` to the existing `@magpie/core` import at the top of the file.

- [ ] **Step 5: Persist confidence in Postgres impl**

In `apps/api/src/stores/postgres-questionnaire-store.ts`:
- Add `confidence: string | null;` to `ItemRow`.
- In `mapItem`, add to the spread: `...(row.confidence !== null ? { confidence: row.confidence as Confidence } : {}),` (import `Confidence`).
- Add `confidence` to every `SELECT i.…`/`SELECT *`-style column list that feeds `ItemRow` (the row shape must include it — `SELECT *` already does; explicit column lists in `matchApproved`, `nextPending`, etc. need `i.confidence` added).
- In `completeItem`, update the UPDATE:

```ts
const updated = await this.pool.query<ItemRow>(
  `
    UPDATE questionnaire_items
    SET status = $2, answer = $3, answered_at = $4, confidence = $5
    WHERE question_log_id = $1
    RETURNING *
  `,
  [questionLogId, result.unanswerable ? "unanswerable" : "answered", result.answer, result.answeredAt, result.confidence]
);
```

- [ ] **Step 6: Persist confidence in the in-memory impl**

In the in-memory store's `completeItem`, set `item.confidence = result.confidence;` alongside the existing status/answer/answeredAt writes.

- [ ] **Step 7: Redefine the gate and pass confidence** (`service.ts`)

Replace the body of `handleQuestionnaireAnswerCompletion` around L151-158:

```ts
  // Ungrounded (no citations) is the only "no answer" case. Low/medium/unknown
  // confidence WITH citations is a shown draft, not a suppression — the badge
  // and human approval carry the trust (see 2026-07-17-questionnaire-trust-design).
  const unanswerable = output.citations.length === 0;
  const citations = await snapshotCitations(ctx, output);
  await ctx.stores.questionnaires.completeItem(questionLogId, {
    answer: output.answer,
    answeredAt: new Date().toISOString(),
    citations,
    unanswerable,
    confidence: output.confidence
  });
  await topUpDrip(ctx, item.questionnaireId);
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npm test -w @magpie/api -- --test-name-pattern="not suppressed|unanswerable regardless"` then `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add packages/core apps/api/src/stores apps/api/src/features/questionnaires/service.ts apps/api/src/features/questionnaires/service.test.ts
git commit -m "feat(questionnaires): snapshot confidence; unanswerable means ungrounded not unsure"
```

---

### Task A3: Export shows grounded answers with a confidence badge

**Files:**
- Modify: `apps/api/src/features/questionnaires/export.ts`
- Test: `apps/api/src/features/questionnaires/export.test.ts`

**Interfaces:**
- Consumes: `QuestionnaireItem.{status, answer, confidence, outcome, reusedFromItemId}`.
- Produces: Markdown/CSV where a grounded answer is always shown; `_No answer available._` only for `unanswerable`.

- [ ] **Step 1: Write the failing test** (append to `export.test.ts`, mirroring its existing fixture builders)

```ts
test("markdown shows a low-confidence answer with a review badge", () => {
  const q = questionnaire([
    item({ position: 0, question: "Q", status: "answered", answer: "Grounded answer.", confidence: "low" })
  ]);
  const md = exportQuestionnaire(q, "md");
  assert.match(md, /Low confidence/);
  assert.match(md, /Grounded answer\./);
  assert.doesNotMatch(md, /No answer available/);
});

test("markdown blanks only a truly unanswerable item", () => {
  const q = questionnaire([
    item({ position: 0, question: "Q", status: "unanswerable", answer: undefined, confidence: undefined })
  ]);
  const md = exportQuestionnaire(q, "md");
  assert.match(md, /_No answer available\._/);
});

test("csv carries a confidence column", () => {
  const q = questionnaire([
    item({ position: 0, question: "Q", status: "answered", answer: "A", confidence: "medium" })
  ]);
  const csv = exportQuestionnaire(q, "csv");
  assert.match(csv.split("\r\n")[0]!, /confidence/);
  assert.match(csv, /medium/);
});
```

(If `export.test.ts` lacks `questionnaire()`/`item()` helpers, add minimal ones building a `Questionnaire`/`QuestionnaireItem` with required fields `staleAtApproval: false, citations: []`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/api -- --test-name-pattern="review badge|truly unanswerable|confidence column"`
Expected: FAIL — badge/column absent; low-confidence currently rendered but no badge.

- [ ] **Step 3: Implement rendering** (`export.ts`)

Replace `toMarkdown` and `toCsv`:

```ts
function toMarkdown(questionnaire: Questionnaire): string {
  const lines: string[] = [`# ${questionnaire.name}`, ""];
  for (const item of questionnaire.items) {
    lines.push(`## ${item.position + 1}. ${item.question}`, "");
    if (item.status !== "unanswerable" && item.answer) {
      if (item.confidence === "low" || item.confidence === "unknown") {
        lines.push(`> ⚠ Low confidence — review`, "");
      }
      const provenance = provenanceLine(item);
      if (provenance) {
        lines.push(`> ${provenance}`, "");
      }
      lines.push(item.answer, "");
    } else {
      lines.push("_No answer available._", "");
    }
  }
  return lines.join("\n");
}

function provenanceLine(item: QuestionnaireItem): string | undefined {
  switch (item.outcome) {
    case "reused":
      return "Source: reused from a prior approved answer";
    case "adapted":
      return "Source: adapted from a prior approved answer";
    case "merged":
      return "Source: merged from prior approved answers";
    default:
      return undefined;
  }
}

function toCsv(questionnaire: Questionnaire): string {
  const rows = [["position", "question", "answer", "status", "confidence", "outcome"]];
  for (const item of questionnaire.items) {
    rows.push([
      String(item.position + 1),
      item.question,
      item.status === "unanswerable" ? "" : (item.answer ?? ""),
      item.status,
      item.confidence ?? "",
      item.outcome ?? ""
    ]);
  }
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}
```

Add `QuestionnaireItem` to the `@magpie/core` type import.

- [ ] **Step 4: Run tests**

Run: `npm test -w @magpie/api -- --test-name-pattern="review badge|truly unanswerable|confidence column"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/questionnaires/export.ts apps/api/src/features/questionnaires/export.test.ts
git commit -m "feat(questionnaires): export shows grounded answers with confidence + provenance"
```

---

### Task A4: Console badge (worksheet UI)

**Files:**
- Modify: `apps/web/src/components/QuestionnairesPanel.tsx`
- Test: `apps/web/src/components/QuestionnairesPanel.test.tsx`

**Interfaces:**
- Consumes: item `confidence`, `outcome` from the questionnaire API payload.

- [ ] **Step 1: Write the failing test** (mirror existing `QuestionnairesPanel.test.tsx` render assertions)

```tsx
test("renders a low-confidence badge and the answer text", () => {
  render(<QuestionnairesPanel /* existing props/fixture with one low-confidence answered item */ />);
  expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
  expect(screen.getByText(/grounded answer/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bash -c "npm test -w @magpie/web -- --test-name-pattern='low-confidence badge'"` (web tests need Git Bash on Windows)
Expected: FAIL — badge not rendered.

- [ ] **Step 3: Implement** — in the item row, when `item.confidence === "low" || item.confidence === "unknown"`, render a small badge (reuse the panel's existing badge/pill component and status classes); always render `item.answer` when present rather than gating on status.

- [ ] **Step 4: Run tests**

Run: `bash -c "npm test -w @magpie/web -- --test-name-pattern='low-confidence badge'"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/QuestionnairesPanel.tsx apps/web/src/components/QuestionnairesPanel.test.tsx
git commit -m "feat(web): questionnaire worksheet shows confidence badge"
```

**Phase A is now shippable independently.** Run `npm run build && npm run typecheck && npm run lint` before opening/merging.

---

# PHASE B — Reconciliation reuse

### Task B1: Migration — widen outcome, add basis + candidate stash

**Files:**
- Create: `packages/db/migrations/0058_questionnaire_reconcile.sql`

**Interfaces:**
- Produces: `outcome` accepts `adapted|merged`; `questionnaire_item_basis(item_id, basis_item_id)`; `questionnaire_items.reconcile_candidate_ids jsonb`.

- [ ] **Step 1: Write the migration**

```sql
-- 0058: Reconciliation reuse. Widen the item outcome to include model verdicts
-- 'adapted' and 'merged'; record multi-source provenance in a basis table; and
-- stash the top-N candidate ids chosen at match time so the answer drip can
-- prime the answer_question job. See 2026-07-17-questionnaire-trust-design.md.
ALTER TABLE questionnaire_items DROP CONSTRAINT IF EXISTS questionnaire_items_outcome_check;
ALTER TABLE questionnaire_items ADD CONSTRAINT questionnaire_items_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('reused', 'fresh', 'changed', 'adapted', 'merged'));

ALTER TABLE questionnaire_items
  ADD COLUMN IF NOT EXISTS reconcile_candidate_ids jsonb;

-- Durable provenance for adapted/merged (and single-source reused). Deliberately
-- NOT a FK to questionnaire_items so it survives a basis item's deletion.
CREATE TABLE IF NOT EXISTS questionnaire_item_basis (
  item_id text NOT NULL REFERENCES questionnaire_items(id) ON DELETE CASCADE,
  basis_item_id text NOT NULL,
  PRIMARY KEY (item_id, basis_item_id)
);
```

> Note: the original `outcome` CHECK may be inline/unnamed from `0055`. If `\d questionnaire_items` shows no `questionnaire_items_outcome_check`, the `DROP CONSTRAINT IF EXISTS` is a harmless no-op and the ADD installs the named one. Confirm the constraint name during Step 2.

- [ ] **Step 2: Apply + verify**

Run: `npm run test:db 2>&1 | tail -20`
Expected: applies through `0058`; `\d questionnaire_items` shows the widened check and new column.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0058_questionnaire_reconcile.sql
git commit -m "feat(db): widen questionnaire outcome + basis/candidate columns (0058)"
```

---

### Task B2: Core types — outcome, verdict, candidates

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `QuestionnaireItemOutcome` includes `adapted|merged`; `AnswerQuestionJobInput.candidates?`; `AnswerQuestionJobOutput.reuse?`.

- [ ] **Step 1: Widen the outcome union** (`index.ts` ~L294)

```ts
export type QuestionnaireItemOutcome = "reused" | "fresh" | "changed" | "adapted" | "merged";
```

- [ ] **Step 2: Add the reconcile verdict + candidate shapes** (near the questionnaire/answer types)

```ts
export type ReconcileVerdict = "reused" | "adapted" | "merged" | "fresh";

export interface AnswerCandidate {
  itemId: string;
  question: string;
  answer: string;
}

export interface ReconcileResult {
  verdict: ReconcileVerdict;
  basisItemIds: string[];
}
```

- [ ] **Step 3: Extend the job I/O** — add to `AnswerQuestionJobInput` (~L750-781):

```ts
  candidates?: AnswerCandidate[];
```

and to `AnswerQuestionJobOutput` (~L783-806):

```ts
  reuse?: ReconcileResult;
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (new optional fields break nothing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): reconcile verdict + candidate types on answer job I/O"
```

---

### Task B3: Job zod schemas — or the broker strips it

**Files:**
- Modify: `packages/jobs/src/schemas.ts`
- Test: `packages/jobs/src/schemas.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: `answerQuestionInputSchema`, `answerQuestionOutputSchema`.
- Produces: schemas that round-trip `candidates` and `reuse`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerQuestionInputSchema, answerQuestionOutputSchema } from "./schemas.js";

test("answer input schema preserves candidates", () => {
  const parsed = answerQuestionInputSchema.parse({
    question: "q", flows: [{ id: "f", name: "F" }], provider: "openai-compatible",
    expectedOutput: "answer_result",
    candidates: [{ itemId: "i1", question: "q0", answer: "a0" }]
  });
  assert.equal((parsed as { candidates?: unknown[] }).candidates?.length, 1);
});

test("answer output schema preserves the reuse verdict", () => {
  const parsed = answerQuestionOutputSchema.parse({
    answer: "a", confidence: "high", citations: [],
    reuse: { verdict: "merged", basisItemIds: ["i1", "i2"] }
  });
  assert.equal((parsed as { reuse?: { verdict: string } }).reuse?.verdict, "merged");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/jobs -- --test-name-pattern="candidates|reuse verdict"`
Expected: FAIL — fields stripped (undefined).

- [ ] **Step 3: Extend the schemas**

In `schemas.ts`, add sub-schemas and wire them in:

```ts
const answerCandidateSchema = z.object({
  itemId: z.string(),
  question: z.string(),
  answer: z.string()
});

const reconcileResultSchema = z.object({
  verdict: z.enum(["reused", "adapted", "merged", "fresh"]),
  basisItemIds: z.array(z.string())
});
```

Add `candidates: z.array(answerCandidateSchema).optional()` to the object in `answerQuestionInputSchema` (lines ~103-120), and `reuse: reconcileResultSchema.optional()` to `answerQuestionOutputSchema` (lines ~121-133).

- [ ] **Step 4: Run tests**

Run: `npm test -w @magpie/jobs -- --test-name-pattern="candidates|reuse verdict"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jobs/src/schemas.ts packages/jobs/src/schemas.test.ts
git commit -m "feat(jobs): answer schema round-trips candidates + reuse verdict"
```

---

### Task B4: Store — top-N match, basis writes, verdict completion

**Files:**
- Modify: `apps/api/src/stores/questionnaire-store.ts` (interface + in-memory impl)
- Modify: `apps/api/src/stores/postgres-questionnaire-store.ts`
- Test: `apps/api/src/stores/postgres-questionnaire-store.test.ts`

**Interfaces:**
- Produces:
  - `matchApprovedTopN(flowId, embedding, model, limit): Promise<Array<{ item: QuestionnaireItem; similarity: number }>>`
  - `setReconcileCandidates(itemId, basisItemIds: string[]): Promise<void>`
  - `reconcileCandidateIds(itemId): Promise<string[]>`
  - `completeItem(questionLogId, { answer, answeredAt, citations, unanswerable, confidence, outcome?, basisItemIds? })`

- [ ] **Step 1: Write the failing test** (Postgres-gated)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";

test("matchApprovedTopN returns candidates ordered by similarity", { skip: !runIntegration }, async () => {
  // build a store against the test schema; insert 3 approved items with known
  // embeddings; assert length<=limit and descending similarity.
  // (mirror the existing postgres-questionnaire-store.test.ts setup helpers)
});
```

- [ ] **Step 2: Run to verify skip/fail**

Run: `RUN_PG_INTEGRATION=1 npm run test:db 2>&1 | tail -30` (or the repo's integration runner)
Expected: FAIL — `matchApprovedTopN` undefined.

- [ ] **Step 3: Add to the interface** (`questionnaire-store.ts`)

```ts
  matchApprovedTopN(
    flowId: string,
    embedding: number[],
    model: string,
    limit: number
  ): Promise<Array<{ item: QuestionnaireItem; similarity: number }>>;
  setReconcileCandidates(itemId: string, basisItemIds: string[]): Promise<void>;
  reconcileCandidateIds(itemId: string): Promise<string[]>;
```

and widen `completeItem`'s result object:

```ts
  completeItem(
    questionLogId: string,
    result: {
      answer: string;
      answeredAt: string;
      citations: QuestionnaireItemCitation[];
      unanswerable: boolean;
      confidence: Confidence;
      outcome?: QuestionnaireItemOutcome;
      basisItemIds?: string[];
    }
  ): Promise<QuestionnaireItem | undefined>;
```

- [ ] **Step 4: Implement in Postgres** (`postgres-questionnaire-store.ts`)

`matchApprovedTopN` — copy `matchApproved`, change `LIMIT 1` → `LIMIT $4` (param `limit`), batch-load citations with the existing `loadCitations(itemIds)`, and map each row:

```ts
async matchApprovedTopN(flowId, embedding, model, limit) {
  const res = await this.pool.query<ItemRow & { similarity: number }>(
    `SELECT i.id, i.questionnaire_id, i.position, i.question, i.status, i.outcome, i.answer,
            i.answered_at, i.question_log_id, i.reused_from_item_id, i.change_reason, i.error,
            i.approved_at, i.stale_at_approval, i.confidence,
            1 - (i.question_embedding <=> $3::vector) AS similarity
     FROM questionnaire_items i JOIN questionnaires q ON q.id = i.questionnaire_id
     WHERE q.flow_id = $1 AND i.status = 'approved' AND i.embedding_model = $2
       AND i.question_embedding IS NOT NULL
     ORDER BY i.question_embedding <=> $3::vector
     LIMIT $4`,
    [flowId, model, toVectorLiteral(embedding), limit]
  );
  const citations = await this.loadCitations(res.rows.map((r) => r.id));
  return res.rows.map((row) => ({ item: mapItem(row, citations.get(row.id) ?? []), similarity: row.similarity }));
}

async setReconcileCandidates(itemId, basisItemIds) {
  await this.pool.query(
    "UPDATE questionnaire_items SET reconcile_candidate_ids = $2 WHERE id = $1",
    [itemId, JSON.stringify(basisItemIds)]
  );
}

async reconcileCandidateIds(itemId) {
  const res = await this.pool.query<{ reconcile_candidate_ids: string[] | null }>(
    "SELECT reconcile_candidate_ids FROM questionnaire_items WHERE id = $1",
    [itemId]
  );
  return res.rows[0]?.reconcile_candidate_ids ?? [];
}

private async replaceBasis(itemId: string, basisItemIds: string[]): Promise<void> {
  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM questionnaire_item_basis WHERE item_id = $1", [itemId]);
    if (basisItemIds.length > 0) {
      await client.query(
        `INSERT INTO questionnaire_item_basis (item_id, basis_item_id)
         VALUES ${valuesClause(basisItemIds.length, 2)}
         ON CONFLICT DO NOTHING`,
        basisItemIds.flatMap((b) => [itemId, b])
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

Update `completeItem` to also write `outcome` and basis when provided:

```ts
const updated = await this.pool.query<ItemRow>(
  `UPDATE questionnaire_items
     SET status = $2, answer = $3, answered_at = $4, confidence = $5,
         outcome = COALESCE($6, outcome), reused_from_item_id = $7
   WHERE question_log_id = $1 RETURNING *`,
  [questionLogId, result.unanswerable ? "unanswerable" : "answered", result.answer,
   result.answeredAt, result.confidence, result.outcome ?? null,
   result.basisItemIds && result.basisItemIds.length === 1 ? result.basisItemIds[0] : null]
);
const row = updated.rows[0];
if (!row) return undefined;
await this.replaceCitations(row.id, result.citations);
if (result.basisItemIds && result.basisItemIds.length > 0) {
  await this.replaceBasis(row.id, result.basisItemIds);
}
return mapItem(row, result.citations);
```

- [ ] **Step 5: Implement in the in-memory store** — add `matchApprovedTopN` (sort all approved by cosine desc, slice to `limit`), `setReconcileCandidates`/`reconcileCandidateIds` (store on `StoredItem`), and honor `outcome`/`basisItemIds` in `completeItem`.

- [ ] **Step 6: Run tests + typecheck**

Run: `RUN_PG_INTEGRATION=1 npm run test:db 2>&1 | tail -30` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/stores
git commit -m "feat(questionnaires): store top-N match, basis provenance, verdict completion"
```

---

### Task B5: Config — reconcile knobs

**Files:**
- Modify: `apps/api/src/platform/config.ts`

**Interfaces:**
- Produces: `ctx.settings.questionnaires.{reconcileCandidates: number, reconcileEnabled: boolean}`.

- [ ] **Step 1: Extend `QuestionnaireConfig`** (~L228-237)

```ts
  reconcileCandidates: number; // top-N approved answers fed to the reconcile step, default 3
  reconcileEnabled: boolean;   // off falls back to the deterministic-veto path, default true
```

- [ ] **Step 2: Add defaults + resolver** (near L239-250)

```ts
const QUESTIONNAIRE_DEFAULT_RECONCILE_CANDIDATES = 3;

// inside resolveQuestionnaireConfig(...), before the return:
const rawCandidates = Number.parseInt(env.QUESTIONNAIRE_RECONCILE_CANDIDATES ?? "", 10);
// add to the returned object:
  reconcileCandidates: Number.isInteger(rawCandidates) && rawCandidates > 0
    ? rawCandidates : QUESTIONNAIRE_DEFAULT_RECONCILE_CANDIDATES,
  reconcileEnabled: env.QUESTIONNAIRE_RECONCILE_ENABLED !== "0"
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add apps/api/src/platform/config.ts
git commit -m "feat(config): QUESTIONNAIRE_RECONCILE_CANDIDATES + _ENABLED"
```

---

### Task B6: Match phase — top-N, fast-path, drip priming, verdict mapping

**Files:**
- Create: `apps/api/src/features/questionnaires/reconcile.ts`
- Modify: `apps/api/src/features/questionnaires/service.ts`
- Modify: `apps/api/src/platform/answer-question.ts`
- Test: `apps/api/src/features/questionnaires/reconcile.test.ts`, `service.test.ts`

**Interfaces:**
- Consumes: `matchApprovedTopN`, `checkReuse`, `setReconcileCandidates`, `reconcileCandidateIds`, `buildAnswerQuestionInput`.
- Produces:
  - `isFastPathReusable(candidates, decision): boolean` (pure)
  - drip attaches `candidates` to `answer_question` input
  - completion maps `output.reuse` → outcome/answer/basis

- [ ] **Step 1: Write the failing pure test** (`reconcile.test.ts`)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFastPathReusable } from "./reconcile.js";

test("fast-path only when exactly one candidate and reuse check passes", () => {
  assert.equal(isFastPathReusable(1, { reuse: true }), true);
  assert.equal(isFastPathReusable(2, { reuse: true }), false);
  assert.equal(isFastPathReusable(1, { reuse: false, reason: { kind: "new_content", sectionId: "", path: "", heading: "" } }), false);
  assert.equal(isFastPathReusable(0, { reuse: true }), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/api -- --test-name-pattern="fast-path only when"`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure helper** (`reconcile.ts`)

```ts
import type { ReuseDecision } from "./reuse-check.js";

// Free verbatim reuse is allowed ONLY for the unambiguous case: exactly one
// matched candidate whose cited sources are unchanged AND nothing newer is
// relevant. Any other shape (0 candidates, 2+, or a changed single) goes to the
// grounded reconcile step. See 2026-07-17-questionnaire-trust-design.md §1.2.
export function isFastPathReusable(candidateCount: number, decision: ReuseDecision): boolean {
  return candidateCount === 1 && decision.reuse;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/api -- --test-name-pattern="fast-path only when"`
Expected: PASS.

- [ ] **Step 5: Rewire the match phase** — in `service.ts` `createQuestionnaire`, replace the per-item `matchApproved` block. Behind `ctx.settings.questionnaires.reconcileEnabled`:

```ts
const k = ctx.settings.questionnaires.reconcileCandidates;
const candidates = await ctx.stores.questionnaires.matchApprovedTopN(input.flowId, vectors[index], model, k);
const above = candidates.filter((c) => c.similarity >= threshold);
if (above.length === 0) {
  continue; // fresh via drip
}
if (above.length === 1) {
  const decision = await checkReuse(deps, above[0]!.item, item.question);
  if (isFastPathReusable(1, decision)) {
    await ctx.stores.questionnaires.markReused(item.id, {
      itemId: above[0]!.item.id,
      answer: above[0]!.item.answer ?? "",
      answeredAt: above[0]!.item.answeredAt ?? ""
    });
    continue;
  }
}
// 2+ candidates, or a single changed one → reconcile: stash candidate ids for the drip.
await ctx.stores.questionnaires.setReconcileCandidates(item.id, above.map((c) => c.item.id));
```

When `reconcileEnabled` is false, keep the existing single-match veto behavior unchanged (guard the new block with an `if`).

- [ ] **Step 6: Drip attaches candidates** — in `topUpDrip`, before `buildAnswerQuestionInput`:

```ts
const candidateIds = await ctx.stores.questionnaires.reconcileCandidateIds(item.id);
const candidates = (await Promise.all(candidateIds.map((id) => ctx.stores.questionnaires.itemById(id))))
  .filter((c): c is NonNullable<typeof c> => Boolean(c) && Boolean(c.answer))
  .map((c) => ({ itemId: c.id, question: c.question, answer: c.answer ?? "" }));
const input = buildAnswerQuestionInput(ctx, {
  questionLogId: log.id,
  question: item.question,
  requestedFlowId: questionnaire.flowId,
  ...(candidates.length > 0 ? { candidates } : {})
});
```

Add `candidates?: AnswerCandidate[]` to `buildAnswerQuestionInput`'s options in `answer-question.ts` and spread it into the returned input (`...(options.candidates ? { candidates: options.candidates } : {})`).

- [ ] **Step 7: Map the verdict on completion** — in `handleQuestionnaireAnswerCompletion`, after computing `unanswerable`, translate `output.reuse`:

```ts
let outcome: QuestionnaireItemOutcome | undefined;
let basisItemIds: string[] | undefined;
let answer = output.answer;
let citations = await snapshotCitations(ctx, output);
if (output.reuse) {
  outcome = output.reuse.verdict; // reused | adapted | merged | fresh
  basisItemIds = output.reuse.basisItemIds;
  if (output.reuse.verdict === "reused" && basisItemIds[0]) {
    // Trust guarantee: copy the approved answer + its citations VERBATIM by id,
    // never the model's echo.
    const basis = await ctx.stores.questionnaires.itemById(basisItemIds[0]);
    if (basis?.answer) {
      answer = basis.answer;
      citations = basis.citations;
    }
  }
}
await ctx.stores.questionnaires.completeItem(questionLogId, {
  answer, answeredAt: new Date().toISOString(), citations,
  unanswerable: citations.length === 0,
  confidence: output.confidence,
  ...(outcome ? { outcome } : {}),
  ...(basisItemIds ? { basisItemIds } : {})
});
```

- [ ] **Step 8: Test the completion mapping** (`service.test.ts`) — drive `handleQuestionnaireAnswerCompletion` with an output carrying `reuse: { verdict: "merged", basisItemIds: ["x","y"] }` and assert `item.outcome === "merged"`; and with `verdict: "reused"` assert the stored answer equals the basis item's answer verbatim.

- [ ] **Step 9: Run tests + typecheck**

Run: `npm test -w @magpie/api` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/features/questionnaires apps/api/src/platform/answer-question.ts
git commit -m "feat(questionnaires): top-N match, fast-path, candidate-primed drip, verdict mapping"
```

---

### Task B7: Watcher — reconcile step in `answer()`

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (add `RECONCILE_ANSWER`)
- Modify: `apps/watcher/src/runners/generative.ts` (`answer()`)
- Modify: `apps/watcher/src/job-prompts.ts` (parse the verdict)
- Test: `apps/watcher/src/runners/generative.test.ts` (or the runner's colocated test)

**Interfaces:**
- Consumes: `input.candidates`, the chat provider (`responseFormat: "json"`), retrieval.
- Produces: `AnswerQuestionJobOutput.reuse` set when candidates were provided; verbatim-reuse short-circuits before full synthesis.

- [ ] **Step 1: Add the reconcile prompt** (`catalog.ts`, mirroring `VERIFY_ANSWER`'s JSON-verdict contract)

```ts
export const RECONCILE_ANSWER = {
  instructions: [
    "You are reconciling a new question against prior APPROVED answers to similar questions.",
    "You are given the candidate answers and the current knowledge-base sections retrieved for the question.",
    "Prefer to satisfy the question from the candidates if they are still fully supported by the current sections.",
    "Reply as JSON with { \"verdict\": one of \"reused\"|\"adapted\"|\"merged\"|\"fresh\", \"basisItemIds\": string[], \"answer\": string }.",
    "- reused: exactly one candidate is still fully correct and complete → set basisItemIds:[thatId], answer:\"\".",
    "- adapted: one candidate is close but needs edits → basisItemIds:[thatId], answer:<edited>.",
    "- merged: several combine → basisItemIds:[ids...], answer:<merged>.",
    "- fresh: none are usable → basisItemIds:[], answer:\"\" (the normal answer flow will run)."
  ].join("\n")
} as const;
```

- [ ] **Step 2: Write the failing runner test** — inject a canned `ChatProvider` returning a `reused` verdict and assert `answer()`'s output has `reuse.verdict === "reused"` and does NOT run full synthesis. (Mirror how `generative.test.ts` stubs `model.complete`.)

```ts
test("answer() reconciles to reused when a candidate still holds", async () => {
  const model = { complete: async () => ({ content: JSON.stringify({ verdict: "reused", basisItemIds: ["i1"], answer: "" }) }) };
  const out = await answer({ job: jobWith({ candidates: [{ itemId: "i1", question: "q0", answer: "a0" }] }), model, api, signal });
  assert.equal((out as { reuse?: { verdict: string } }).reuse?.verdict, "reused");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="reconciles to reused"`
Expected: FAIL — no reconcile branch.

- [ ] **Step 4: Implement the reconcile step** — at the top of `answer()` after parsing input, when `input.candidates?.length`:

```ts
if (parsed.candidates && parsed.candidates.length > 0) {
  const flowId = await resolveFlow(/* existing args */);
  const seed = await api.retrieve(parsed.question, flowId, undefined, signal);
  const verdict = await reconcileWithCandidates({
    model, question: parsed.question, candidates: parsed.candidates, sections: seed.sections, signal
  });
  if (verdict && verdict.verdict !== "fresh") {
    return buildReconciledOutput({ verdict, sections: seed.sections, flowId });
  }
  // fresh (or unparseable → fail open): fall through to the normal answer flow,
  // but stamp reuse:{verdict:"fresh",basisItemIds:[]} on the final output.
}
```

Add `reconcileWithCandidates(...)` (one `model.complete` call with `RECONCILE_ANSWER.instructions`, `responseFormat: "json"`, parsed by a new `parseReconcileVerdict` in `job-prompts.ts` that returns `undefined` on unparseable input — fail open) and `buildReconciledOutput(...)` (assembles an `AnswerQuestionJobOutput`: `answer` from the verdict for adapted/merged or `""` for reused; `citations` via the existing `selectCitations`/`toCitation` from `sections`; `confidence: "high"`; `reuse: { verdict, basisItemIds }`). Ensure the normal-flow return path also sets `reuse: { verdict: "fresh", basisItemIds: [] }` when candidates were supplied.

- [ ] **Step 5: Parse helper** (`job-prompts.ts`)

```ts
export function parseReconcileVerdict(raw: string): ReconcileResult & { answer: string } | undefined {
  const json = extractJson(raw);
  if (!json) return undefined;
  const v = json as { verdict?: unknown; basisItemIds?: unknown; answer?: unknown };
  if (v.verdict !== "reused" && v.verdict !== "adapted" && v.verdict !== "merged" && v.verdict !== "fresh") return undefined;
  const basisItemIds = Array.isArray(v.basisItemIds) ? v.basisItemIds.filter((x): x is string => typeof x === "string") : [];
  return { verdict: v.verdict, basisItemIds, answer: typeof v.answer === "string" ? v.answer : "" };
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="reconciles to reused"` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/prompts/src/catalog.ts apps/watcher/src/runners/generative.ts apps/watcher/src/job-prompts.ts apps/watcher/src/runners/generative.test.ts
git commit -m "feat(watcher): reconcile answer_question against candidate prior answers"
```

---

### Task B8: End-to-end regression (the QA#4 shape)

**Files:**
- Test: `apps/api/src/features/questionnaires/service.test.ts`

- [ ] **Step 1: Write the test** — a second questionnaire whose question matches one approved item, with a stubbed embedder that returns near-identical vectors and a `knowledge` store fingerprint that reports the cited section changed. Assert the item does NOT get `markReused` at create time (fast-path declined) and instead is stamped with reconcile candidates (`reconcileCandidateIds(item.id)` non-empty), then, after driving `handleQuestionnaireAnswerCompletion` with `reuse:{verdict:"reused",basisItemIds:[approvedId]}`, the stored answer equals the approved answer verbatim and `outcome === "reused"`.

- [ ] **Step 2: Run**

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcile"` 
Expected: PASS.

- [ ] **Step 3: Full build gate**

Run: `npm run build && npm run typecheck && npm run lint && npm run deadcode`
Expected: all PASS (fix any unused-export knip findings by de-exporting, never by relaxing config).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/features/questionnaires/service.test.ts
git commit -m "test(questionnaires): reconcile regression for changed-source reuse"
```

---

## Docs

- [ ] Update `docs/questionnaires.md`: the outcome vocabulary (`reused|adapted|merged|fresh`), that `unanswerable` now means ungrounded, the confidence badge, and the two new env vars. Update `docs/api.md`/`docs/mcp.md` if the questionnaire payload shape (new `confidence`, `outcome`) is documented there. Commit.

---

## Self-Review

**Spec coverage** — every spec section maps to a task: top-N match → B4/B6; deterministic fast-path → B6 (`isFastPathReusable`); reconcile via `answer_question` (no new job type) → B2/B3/B6/B7; verdicts reused/adapted/merged/fresh → B2/B7/B6; verbatim-by-id guarantee → B6 Step 7; show-don't-suppress (`unanswerable ⟺ no citations`) → A2; durable confidence + provenance → A1/A2/B1/B4; rendering → A3/A4; config knobs → B5; queue-only (reconcile in watcher) → B7; migrations/rollout → A1/B1. Non-goals (contradiction detection, fuzzy tiers, live-Ask wiring) intentionally have no task.

**Placeholders** — none; each code step carries real code. The two UI/integration tasks (A4, B4 Step 1) describe the assertion and point at the exact existing fixture pattern to mirror rather than inventing fixtures blind, which is the honest instruction, not a placeholder.

**Type consistency** — `ReconcileResult`/`ReconcileVerdict`/`AnswerCandidate` (B2) are used identically in schemas (B3), store (B4), service (B6), and watcher (B7). `completeItem`'s widened result object is defined once (B4) and matches its callers (A2, B6). `outcome` values match the DB CHECK (B1).
