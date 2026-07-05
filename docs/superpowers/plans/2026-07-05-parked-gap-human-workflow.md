# Parked-Gap Human Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (or
> subagent-driven-development) to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax. Design: `docs/superpowers/specs/2026-07-05-parked-gap-human-workflow-design.md`.
> Issue: #158.

**Goal:** Model "parked, awaiting a human" as first-class gap state (`parked_at` on
`question_gaps`), collapse the scattered `needs_attention`-source special-cases into one
predicate, fix the `gapIdsForSummary` hole, and wire human **retry** / **dismiss** actions
plus a parked-questions listing surface.

**Tech Stack:** TypeScript (ESM/NodeNext, explicit `.js` import extensions), Node ≥22.13,
npm workspaces, Zod schemas, Postgres via the custom SQL migrator, `node:test`, Next.js
(web, Emotion + typed theme primitives).

## Global constraints

- **Never cast through `unknown`/`any`** — fix types properly.
- **ESM/NodeNext:** every relative import needs an explicit `.js` extension.
- **Validate as you go:** `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`
  per task — do not batch. DB tests via `npm run test:db` (`RUN_PG_INTEGRATION`).
- **Commit and push after each task.**
- **Migrations are append-only**, `NNNN_` prefixed (next is `0042`), no rollback.
- The park behaviour (when a gap parks) does **not** change — only its representation and
  the human actions on it.

---

### Task 0: Fold in #154 — mark verification re-ask logs synthetic (parking must actually hold)

> Without this, parked gaps re-enter candidacy under a new question id via the re-ask logs
> and auto-redraft — defeating everything Tasks 1–7 build. Do this first.

**Files:**
- Modify: `packages/core/src/index.ts` — `QuestionLog` / `QuestionLogInput` (:196+) gain
  `purpose?: "live" | "verification"` (default `"live"`).
- Modify: migration (fold into `0042` or a sibling): `question_gaps`'s parent `questions`
  gains `purpose text NOT NULL DEFAULT 'live' CHECK (purpose IN ('live','verification'))`.
- Modify: `apps/api/src/features/proposals/service.ts:442` — `recordAnswerQuestionLog`
  stamps `purpose: "verification"` for re-asks.
- Modify: `apps/api/src/features/jobs/service.ts` (`updateQuestionLogFromCompletedJob`,
  ~:239-265) — do **not** ingest gap signals for a `purpose='verification'` log.
- Modify: `apps/api/src/stores/*question-log-store.ts` — `listGapCandidates` excludes
  `purpose='verification'` logs; the questions list query
  (`apps/api/src/features/questions/service.ts:29`) excludes them (or filters to `live`).

- [ ] **Step 1 (test-first):** fixture routed through `completeJob` (not the shortcut the
  #154 report calls out in `service.test.ts:45-62`) so a re-ask completion *would* write gap
  rows; assert a `purpose='verification'` re-ask log acquires **no** candidacy entry and does
  **not** appear in `GET /api/questions`. Run, expect FAIL.
- [ ] **Step 2:** implement the discriminator + the three exclusions.
- [ ] **Step 3:** `npm run test:db` + unit green. Note in the PR that #154 is fixed here.

---

### Task 1: First-class `parked_at` in the domain type

**Files:**
- Modify: `packages/core/src/index.ts` — `QuestionGapSource` (:176), `QuestionGap` (:178-194).
- Modify: `packages/jobs/src/schemas.ts` — the gap `source` enum (mirror of core; grep
  `"followup"` to find it).

**Changes:**
- `QuestionGapSource = "auto" | "manual" | "followup" | "verification"` (drop
  `needs_attention`).
- `QuestionGap` gains `parkedAt?: string;` and `parkedReason?: string;` with doc comments
  mirroring the `resolvedAt`/`dismissedAt` block.
- Update the comment at `:171-175` to describe `verification` as the sole server-raised
  source and parking as a `parkedAt` state.

- [ ] **Step 1:** update the type + schema and the doc comments.
- [ ] **Step 2:** `npm run build --workspace @magpie/core --workspace @magpie/jobs` +
  `npm run typecheck`. Expect downstream type errors where `needs_attention` is still
  referenced — those are Tasks 2–5. Commit the type change alone is fine (build of core
  passes; the monorepo typecheck will fail until Task 5 — note this and proceed task-by-task,
  or land Tasks 1–5 as one logical unit committed per file group).

---

### Task 2: Migration `0042_gap_parked_state.sql`

**Files:**
- Create: `packages/db/migrations/0042_gap_parked_state.sql` (per write-a-migration skill).

**SQL (in order — backfill before narrowing the CHECK):**

```sql
-- Parked = the verification retry cap was hit; the question awaits a human.
-- Was encoded as source='needs_attention'; now first-class state alongside
-- resolved_at / dismissed_at so the "is parked" predicate lives in one place.
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_at timestamptz;
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_reason text;

-- Backfill existing escalations, then fold the pseudo-source back into 'verification'.
UPDATE question_gaps
  SET parked_at = created_at, parked_reason = 'verification retry cap'
  WHERE source = 'needs_attention';
UPDATE question_gaps SET source = 'verification' WHERE source = 'needs_attention';

-- Narrow the source CHECK now that no needs_attention rows remain.
ALTER TABLE question_gaps DROP CONSTRAINT IF EXISTS question_gaps_source_check;
ALTER TABLE question_gaps ADD CONSTRAINT question_gaps_source_check
  CHECK (source IN ('auto', 'manual', 'followup', 'verification'));

-- Anti-join index for candidacy exclusion (question-level park).
CREATE INDEX IF NOT EXISTS question_gaps_parked_idx ON question_gaps (question_id)
  WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL;
```

- [ ] **Step 1:** write the migration; verify the `NNNN_` prefix-uniqueness guard passes.
- [ ] **Step 2:** `npm run db:migrate` against a scratch DB; confirm it applies clean and a
  seeded `needs_attention` row backfills to `verification` + `parked_at`.

---

### Task 3: Collapse the predicate in the stores

**Files:**
- Modify: `apps/api/src/stores/postgres-question-log-store.ts`
- Modify: `apps/api/src/stores/question-log-store.ts` (in-memory)
- Modify: `apps/api/src/stores/gap-store` mappers (wherever gap rows are read into
  `QuestionGap` — add `parkedAt`/`parkedReason` to the SELECT + row mapping).

**Changes (postgres):**
- **Row mapping:** every `SELECT` that hydrates gaps must return `parked_at`,
  `parked_reason` and map them to `parkedAt`/`parkedReason` (grep `resolved_at` in the
  store to find the gap-select projections and mirror them).
- **`recordVerificationGap` (:323-361):** signature becomes
  `{ summary: string; note: string; parked: boolean }` (drop the `source` union). The
  in-place `UPDATE` matches `source = 'verification' AND resolved_at IS NULL AND
  dismissed_at IS NULL`, and sets `source='verification', note=$, parked_at = CASE WHEN
  $parked THEN now() ELSE parked_at END, parked_reason = CASE WHEN $parked THEN
  'verification retry cap' ELSE parked_reason END`. The insert path inserts
  `source='verification'` with `parked_at` set iff `parked`.
- **Candidacy exclusion (:564-600):** replace the `WHERE source = 'needs_attention'`
  anti-join with `WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS
  NULL`.
- **`gapIdsForSummary` (:29-44) and `gapIdsForSummaries` (:46+):** add `AND qg.parked_at IS
  NULL` alongside the existing `resolved_at IS NULL AND dismissed_at IS NULL` — **the bug
  fix.**

**Changes (in-memory `question-log-store.ts`):**
- Gap objects carry `parkedAt`/`parkedReason`.
- `recordVerificationGap` (:336-349): mirror — one live `verification` row, set `parkedAt`
  when `parked`.
- `listGapCandidates` (:455-470): replace `active.some(g => g.source === "needs_attention")`
  with `active.some(g => g.parkedAt && !g.resolvedAt && !g.dismissedAt)`.
- The in-memory `gapIdsForSummary`/`gapIdsForSummaries` twin gains the `!g.parkedAt` filter.

- [ ] **Step 1 (test-first):** in `postgres-question-log-store.test.ts` and
  `question-log-store.test.ts`, add a test: two questions share a summary, one has a live
  parked verification gap — `gapIdsForSummary(summary)` returns only the non-parked row.
  Run, expect FAIL.
- [ ] **Step 2:** implement the store changes; the parity tests pass.
- [ ] **Step 3:** rewrite the existing `needs_attention` assertions in both store test files
  (`postgres-question-log-store.test.ts:332-392`, `question-log-store.test.ts:325-370`) to
  assert `parkedAt` + `source==='verification'` instead of `source==='needs_attention'`.
- [ ] **Step 4:** `npm run test:db` + unit tests green.

---

### Task 4: Collapse the predicate in the proposals service

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts`

**Changes:**
- **Park write (:344-369):** `recordVerificationGap(questionId, { summary, note, parked:
  capped })` — drop the `source: capped ? "needs_attention" : "verification"` ternary; the
  `capped`/`needsAttention` computation itself is unchanged.
- **`reopenSummaryFor` (:526-539):** the `gap.source !== "needs_attention"` filter becomes a
  parked check: `!gap.parkedAt` (skip parked rows when picking the reopen summary).
- **Resubmission-note filter (:580)** and **live-row finder (:604):** the
  `source === "verification" || source === "needs_attention"` predicates collapse to
  `source === "verification"`.
- **`verificationLineageResetSince` (:599-609):** match `gap.source === "verification"`
  only. Its resolved/dismissed reset logic is unchanged and now also fires for the
  human-retry dismissal (Task 5).
- **Reopen guard (:1031):** collapse the `verification || needs_attention` check to
  `source === "verification"`.
- The `missing-log` escalation (:287-305) still forces `needsAttention = true`; it now
  produces a parked `verification` gap via the updated `recordVerificationGap` — trace the
  path to ensure the parked row is written (it goes through the same capped branch or a
  direct `parked: true` record; keep the "escalate straight to parked" behaviour).

- [ ] **Step 1:** update `service.ts`; keep `closureStatus` values (`needs_attention`
  stays a proposal outcome).
- [ ] **Step 2:** rewrite `service.test.ts` assertions (`:299-333`, `:513-548`, `:677-793`,
  `:909`) from `gap.source === "needs_attention"` to `gap.parkedAt` (behaviour identical).
- [ ] **Step 3:** `npm test` for the api workspace green.

---

### Task 5: Human retry / dismiss transitions + parked listing (store + service)

**Files:**
- Modify: both question-log stores — add `retryParkedGap(questionId)`,
  `dismissParkedGap(questionId)`, `listParkedQuestions(limit)`.
- Modify: `apps/api/src/features/questions/service.ts` (or the questions feature service).

**Semantics (see design → State transitions):**
- `retryParkedGap`: set `dismissed_at = now(), dismissed_reason = 'human_retry'` on the live
  parked `verification` row (the row where `parked_at IS NOT NULL AND resolved_at IS NULL AND
  dismissed_at IS NULL`). Un-parks the question; leaves the underlying `auto`/`followup` gap
  open to re-draft; establishes the lineage-reset boundary. Bump the gap catalog.
- `dismissParkedGap`: set `dismissed_at = now(), dismissed_reason = 'human_dismiss'` on **all**
  live (unresolved, undismissed) gap rows for the question. Topic abandoned. Bump the catalog.
- `listParkedQuestions(limit)`: return questions with a live parked row — `{ questionId,
  question, flowId, summary, note, parkedAt }` — using the single parked predicate.

- [ ] **Step 1 (test-first):** store tests — after `retryParkedGap`, the question re-appears
  in `listGapCandidates` and `countPriorStillOpen` resets on the next verification; after
  `dismissParkedGap`, it does not re-appear and never re-clusters. Run, expect FAIL.
- [ ] **Step 2:** implement the three store methods (postgres + in-memory parity).
- [ ] **Step 3:** integration test (`RUN_PG_INTEGRATION`) exercising park → retry (fresh
  budget) and park → dismiss end-to-end against the real store + `gap_closure_verification`.
- [ ] **Step 4:** `npm run test:db` green.

---

### Task 6: API endpoints

**Files:**
- Modify: `apps/api/src/features/questions/routes.ts` (:46-57 are the existing gap routes).
- Modify: `docs/api.md`.

**Endpoints (scope `feedback:questions`, matching the existing gap routes):**
- `POST /:id/gap/retry` → `retryParkedGap`, returns the updated question log.
- `POST /:id/gap/dismiss` → `dismissParkedGap`, returns the updated question log.
- `GET /parked` (mounted under the questions router) → `listParkedQuestions`.

- [ ] **Step 1 (test-first):** route tests (`apps/api/src/features/gaps/routes.test.ts`
  neighbour, or a new `questions/routes.test.ts`): retry un-parks, dismiss settles, `GET
  /parked` lists the parked question with its note. Run, expect FAIL.
- [ ] **Step 2:** implement the routes; document them in `docs/api.md`.
- [ ] **Step 3:** api tests + `app.test.ts` green.

---

### Task 7: Web — parked-questions surface + actionable badge

**Files:**
- Modify/Create: a `ParkedQuestionsPanel` under `apps/web/src/components/` built from
  `Surface`/`Button`/`Badge`/`Stack`/`Row` primitives (no `.css`).
- Modify: `apps/web/src/components/ProposalsPanel.tsx:129-133` — the `needs_attention`
  closure badge links to the parked surface.
- Modify: the web API client + the page that hosts the Ask/Proposals admin area to mount the
  new panel.

**Behaviour:**
- Fetch `GET /api/questions/parked`; render each: question text, flow, the verification
  `note`, `parkedAt`, and **Retry** / **Dismiss** buttons calling the two endpoints. On
  success, refetch the list.
- The "Needs attention" badge on a proposal deep-links to the parked surface.

- [ ] **Step 1:** build the panel + client calls; wire the badge link.
- [ ] **Step 2:** `npm run build --workspace web`, `npm run lint`. If a component test
  harness exists for panels, add one; otherwise verify via the run-magpie smoke path.
- [ ] **Step 3:** drive it live (run-magpie): seed a parked question, confirm it lists,
  Retry re-admits it to candidacy, Dismiss removes it.

---

### Task 8: Docs + orientation

**Files:**
- `docs/question-logging.md` (:26-30, :132-142, :168, :201) — parked *state*, retry/dismiss
  workflow, the new endpoints; stop calling `needs_attention` a gap source.
- `docs/architecture.md` (:242-243), `docs/ai-jobs.md` (:216-217) — `needs_attention` is a
  parked state.
- `docs/api.md` — the endpoints (also touched in Task 6).
- `.claude/skills/magpie-orientation` / `add-a-job-type` — if they enumerate the source enum.

- [ ] **Step 1:** update docs alongside the code.
- [ ] **Step 2:** `npm run format:check`; final full `npm run build && npm run typecheck &&
  npm run lint && npm test` green; push.

---

## Sequencing note

Tasks 1–5 are one logical type/behaviour change and the monorepo `typecheck` won't be green
between them — either land them as a single reviewed unit (committing per file group) or
accept a transient red typecheck across Tasks 1–4 and gate the "green" checkpoint at the end
of Task 5. Tasks 6–8 are independently green.

## Risk / verification checklist

- [ ] A parked question is excluded from candidates (unchanged behaviour) — one predicate.
- [ ] `gapIdsForSummary`/`gapIdsForSummaries` never return a parked row (the #158 bug).
- [ ] Retry gives a **fresh** retry budget (lineage reset via the dismissed parked row).
- [ ] Dismiss abandons the topic (no re-cluster, no re-draft).
- [ ] Existing `needs_attention`-source tests are rewritten to `parkedAt`, behaviour held.
- [ ] Migration backfills existing `needs_attention` rows and the narrowed CHECK holds.
- [ ] Proposal `closure_status = needs_attention` still renders — now with an actionable link.
