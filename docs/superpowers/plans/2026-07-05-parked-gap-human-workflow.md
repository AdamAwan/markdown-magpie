# Parked-Gap Human Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (or
> subagent-driven-development) to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax. Design: `docs/superpowers/specs/2026-07-05-parked-gap-human-workflow-design.md`.
> Issue: #158 (folds in #154). All CRITICAL/MAJOR/MINOR review findings are incorporated.

**Goal:** Model "parked, awaiting a human" as first-class gap state (`parked_at` on
`question_gaps`), collapse the scattered `needs_attention`-source special-cases into one
question-level predicate, fix the `gapIdsForSummary` hole, and wire human **retry** /
**dismiss** actions plus a parked-questions listing surface. Fold in #154 (synthetic re-ask
logs) first, because parking does not hold without it.

**Tech Stack:** TypeScript (ESM/NodeNext, explicit `.js` import extensions), Node ≥22.13, npm
workspaces, Zod schemas, Postgres via the custom SQL migrator, `node:test`, Next.js (web,
Emotion + typed theme primitives).

## Global constraints

- **Never cast through `unknown`/`any`** — fix types properly.
- **ESM/NodeNext:** every relative import needs an explicit `.js` extension.
- **Validate as you go:** `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`
  per task. DB tests via `npm run test:db` (`RUN_PG_INTEGRATION`).
- **Commit and push after each task.**
- **Migrations are append-only**, `NNNN_` prefixed, no rollback. This work adds **`0042`**
  (questions.purpose) and **`0043`** (parked state) — `0042` is the next free number.
- The park behaviour (when a gap parks) does **not** change — only its representation and the
  human actions on it.

### ⚠ Compiler-blind sites (read before Task 4)

`addressedGapsAllSettled` (`service.ts:539`), `reopenSummaryFor` (`service.ts:580`), and
`verificationLineageResetSince` (`service.ts:604`) take structurally-typed `source: string`
params. Narrowing the `QuestionGapSource` enum will **NOT** produce a type error at these
sites — a stale `!== "needs_attention"` silently degrades to a no-op filter. They must be
edited by hand and covered by tests. Every other source site IS compiler-caught.

---

### Task 0: Fold in #154 — synthetic verification re-ask logs (parking must actually hold)

> Without this, parked gaps re-enter candidacy under a new question id via the re-ask logs and
> auto-redraft — defeating Tasks 1–7. Do this first. (Separable as its own PR if preferred,
> but must precede the rest.)

**Files:**
- Modify: `packages/core/src/index.ts` — `QuestionLog` / `QuestionLogInput` (~:196) gain
  `purpose?: "live" | "verification"` (default `"live"`).
- Create: `packages/db/migrations/0042_question_purpose.sql`:
  ```sql
  ALTER TABLE questions ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'live'
    CHECK (purpose IN ('live','verification'));
  UPDATE questions SET purpose = 'verification'
    WHERE id IN (SELECT reasked_question_id FROM gap_closure_verification
                 WHERE reasked_question_id IS NOT NULL);   -- backfill history (M4.1)
  ```
- Modify: `apps/api/src/features/proposals/service.ts:442` (`recordAnswerQuestionLog` call) +
  `apps/api/src/platform/answer-question.ts:19-25` — stamp `purpose: "verification"` for re-asks.
- Modify: `apps/api/src/features/jobs/service.ts:395-421` (`updateQuestionLogFromCompletedJob`)
  — for a `purpose='verification'` log, **record the answer/confidence/citations but skip gap-
  signal ingestion** (M4.2 — keep the audit trail, suppress only the gap-row write).
- Modify: both stores — `listGapCandidates` excludes `purpose='verification'` logs; the
  questions list (`apps/api/src/features/questions/service.ts:28-30`) filters to `purpose='live'`;
  **and `gapIdsForSummary`/`gapIdsForSummaries` exclude `purpose='verification'` logs' gaps**
  (M4.3).

- [ ] **Step 1 (test-first):** fixture routed through `completeJob` (NOT the shortcut at
  `service.test.ts:45-62`) so a re-ask completion *would* write gap rows. Assert a
  `purpose='verification'` re-ask log: (a) has no candidacy entry, (b) is absent from
  `GET /api/questions`, (c) still has its answer/citations recorded. Run, expect FAIL.
- [ ] **Step 2:** implement the discriminator, the migration, and the four exclusions.
- [ ] **Step 3:** `npm run db:migrate` on a scratch DB; confirm an existing re-ask log
  backfills to `purpose='verification'`. `npm run test:db` + unit green. Note #154 fixed here.

---

### Task 1: First-class `parked_at` in the domain type

**Files:**
- Modify: `packages/core/src/index.ts` — `QuestionGapSource` (:176), `QuestionGap` (:178-194).

**Changes:**
- `QuestionGapSource = "auto" | "manual" | "followup" | "verification"` (drop `needs_attention`).
- `QuestionGap` gains `parkedAt?: string;` and `parkedReason?: string;` with doc comments
  mirroring the `resolvedAt`/`dismissedAt` block.
- Update the comment at :171-175 to describe `verification` as the sole server-raised source
  and parking as a `parkedAt` state.
- **Do NOT touch `packages/jobs/src/schemas.ts:54`** — it is already
  `z.enum(["auto","manual","followup"])` and never contained the server-side sources (M-nit 3).

- [ ] **Step 1:** update the type + comments.
- [ ] **Step 2:** `npm run build --workspace @magpie/core` passes; monorepo `typecheck` will
  fail at the compiler-caught source sites (Tasks 3–4) — expected. See the sequencing note.

---

### Task 2: Migration `0043_gap_parked_state.sql`

**Files:**
- Create: `packages/db/migrations/0043_gap_parked_state.sql` (per write-a-migration skill).

```sql
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_at timestamptz;
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_reason text;

-- Backfill existing escalations, then fold the pseudo-source back into 'verification'.
-- parked_at = created_at is the first-failure time (in-place updates), not exact park time —
-- cosmetic, not load-bearing.
UPDATE question_gaps SET parked_at = created_at, parked_reason = 'verification retry cap'
  WHERE source = 'needs_attention';
UPDATE question_gaps SET source = 'verification' WHERE source = 'needs_attention';

-- Narrow the source CHECK now that no needs_attention rows remain (drop-add matches 0035/0038).
ALTER TABLE question_gaps DROP CONSTRAINT IF EXISTS question_gaps_source_check;
ALTER TABLE question_gaps ADD CONSTRAINT question_gaps_source_check
  CHECK (source IN ('auto','manual','followup','verification'));

-- Anti-join index for question-level park exclusion.
CREATE INDEX IF NOT EXISTS question_gaps_parked_idx ON question_gaps (question_id)
  WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL;
```

- [ ] **Step 1:** write it; verify the `NNNN_` prefix-uniqueness guard passes; `created_at`
  exists (`0009_multi_gap.sql`) so the backfill is valid.
- [ ] **Step 2:** `npm run db:migrate` on a scratch DB; a seeded `needs_attention` row
  backfills to `verification` + `parked_at`, no CHECK violation. (Deploy note: migrate then
  restart the API — an old process writing `needs_attention` post-migration would fail the new
  CHECK.)

---

### Task 3: Collapse the predicate in the stores (question-level)

**Files:**
- Modify: `apps/api/src/stores/postgres-question-log-store.ts`
- Modify: `apps/api/src/stores/question-log-store.ts` (in-memory)

**Changes (postgres):**
- **Row mapping:** every gap-hydrating `SELECT` returns `parked_at`, `parked_reason` mapped to
  `parkedAt`/`parkedReason` (grep `resolved_at` for the projections and mirror).
- **`recordVerificationGap` (:323-361):** signature → `{ summary: string; note: string;
  parked: boolean }` (drop the `source` union). The in-place `UPDATE` matches
  `source = 'verification' AND resolved_at IS NULL AND dismissed_at IS NULL`, sets
  `source='verification', note=$`, and `parked_at`/`parked_reason` only when `parked` (else
  leaves them as-is). Insert path inserts `source='verification'`, `parked_at` set iff `parked`.
- **Candidacy anti-join (:598-601):** replace `WHERE source = 'needs_attention'` with
  `WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL`.
- **`gapIdsForSummary` (:29-44) and `gapIdsForSummaries` (:46-94):** exclude **all gap rows of
  a parked question** — the same question-level anti-join candidacy uses (M3), NOT a row-level
  `parked_at IS NULL`. Also exclude `purpose='verification'` logs (Task 0 / M4.3). **The #158
  bug fix.**
- **`dismissGaps`:** add `AND parked_at IS NULL` so a reconciler-reachable dismissal can never
  discharge a parked escalation (M2 defense-in-depth).

**Changes (in-memory `question-log-store.ts`):**
- Gap objects carry `parkedAt`/`parkedReason`.
- `recordVerificationGap` (:336-349): mirror — one live `verification` row, `parkedAt` set when
  `parked`.
- `listGapCandidates` (:455-470): replace `active.some(g => g.source === "needs_attention")`
  with `active.some(g => g.parkedAt && !g.resolvedAt && !g.dismissedAt)`.
- `gapIdsForSummary`/`gapIdsForSummaries` twin (:139-155): question-level parked exclusion.
- **`dismissGaps` (:407-442): skip parked rows (M2 — mandatory here, not just defense).**
  Because in-memory gap ids are `${log.id}::${summary}` (:151), the auto row and parked row are
  indistinguishable, so a summary-based dismissal would otherwise dismiss the parked row too.

- [ ] **Step 1 (test-first):** in both store test files, add: two questions share a summary,
  one has a live parked verification gap AND a sibling `auto` row — `gapIdsForSummary(summary)`
  returns **neither** of the parked question's rows. Add an in-memory test: dismissing by the
  shared summary does not dismiss the parked row. Run, expect FAIL.
- [ ] **Step 2:** implement; parity tests pass.
- [ ] **Step 3:** rewrite existing `needs_attention` assertions
  (`postgres-question-log-store.test.ts:332-392`, `question-log-store.test.ts:325-370`) to
  assert `parkedAt` + `source==='verification'`.
- [ ] **Step 4:** `npm run test:db` + unit green.

---

### Task 4: Collapse the predicate in the proposals service (+ C2 reset fix)

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts`

**Site inventory (corrected — the earlier draft's labels were scrambled):**
- **Park write — `service.ts:366`:** `recordVerificationGap(questionId, { summary, note,
  parked: capped })` — drop the `source: capped ? "needs_attention" : "verification"` ternary;
  the `capped`/`needsAttention` computation is unchanged. *(compiler-caught)*
- **`addressedGapsAllSettled` — `service.ts:539`** (NOT `reopenSummaryFor`): `gap.source !==
  "needs_attention"` → `!gap.parkedAt`. ⚠ **compiler-blind** (`source: string`).
- **`reopenSummaryFor` filter — `service.ts:580`:** `!gap.parkedAt`. ⚠ **compiler-blind.**
- **live-row finder — `service.ts:604`:** `source === "verification" || source ===
  "needs_attention"` → `source === "verification"`. *(compiler-caught)*
- **`verificationLineageResetSince` — `service.ts:599-609`:** apply the **C2 fix** — match the
  most recent *settled* lineage row:
  ```ts
  const lineageGap = [...(original.gaps ?? [])]
    .reverse()
    .find((gap) => gap.source === "verification" && (gap.resolvedAt || gap.dismissedAt));
  ```
  ⚠ **compiler-blind** for the source narrowing; the settled-row change is the load-bearing part.
- **resubmission-note filter — `service.ts:1031`:** `source === "verification" || … ===
  "needs_attention"` → `source === "verification"`. *(compiler-caught)*
- **`closureStatus` values unchanged** (`needs_attention` stays a proposal outcome).

**M1 — missing-log path (`service.ts:287-306`): DO NOT add a `recordVerificationGap` call.**
The earlier draft was wrong: this path has no question log, so it writes only the
`gap_closure_verification` audit row and sets `needsAttention` — leave that as-is. The parked
*question* list will not include it; the parked *surface* enumerates such proposals separately
(Task 6). Add a code comment noting the deliberate absence of a parked gap row here.

- [ ] **Step 1:** apply all edits above; hand-verify the three compiler-blind sites.
- [ ] **Step 2 (C2 test):** add a test for the **second** post-retry failure reading a fresh
  budget (the existing test at `service.test.ts:751-797` only covers the first). Rewrite the
  other `gap.source === "needs_attention"` assertions (`:299-333`, `:513-548`, `:677-793`,
  `:909`) to `gap.parkedAt`.
- [ ] **Step 3:** api workspace tests green.

---

### Task 5: Human retry / dismiss transitions + parked listing (store + service)

**Files:**
- Modify: both question-log stores — add `retryParkedGap(questionId)`,
  `dismissParkedGap(questionId)`, `listParkedQuestions(limit)`.
- Modify: `apps/api/src/features/questions/service.ts`.

**Semantics (see design → State transitions; C1 is load-bearing):**
- **`retryParkedGap`:** in one transaction — set `dismissed_at = now(), dismissed_reason =
  'human_retry'` on the live parked `verification` row (`parked_at IS NOT NULL AND resolved_at
  IS NULL AND dismissed_at IS NULL`); **then, if the question has no remaining live gap row
  carrying that parked summary, insert a fresh live `verification` row** (same summary, same
  `note`, `parked_at = NULL`) — guarantees candidacy, preserves the note for the re-draft, and
  keeps the dismissed row as the lineage-reset boundary (works only with the Task 4 C2 fix).
  Bump the gap catalog. On an already-unparked question the parked-predicate `UPDATE` matches 0
  rows → no-op, return the current log.
- **`dismissParkedGap`:** set `dismissed_at = now(), dismissed_reason = 'human_dismiss'` on
  **all** live gap rows for the question. Bump the catalog.
- **`listParkedQuestions(limit)`:** questions with a live parked row → `{ questionId, question,
  flowId, summary, note, parkedAt }`, one predicate. (The missing-log proposal entries are
  merged in at the route/service layer in Task 6, from `closure_status='needs_attention'`
  proposals with no parked question.)

- [ ] **Step 1 (test-first):** store tests — (a) after `retryParkedGap` when the underlying
  gap was already dismissed/resolved, a live `verification` row exists and the question is a
  candidate again with a reset budget on the next failure (C1); (b) after `dismissParkedGap`
  it never re-appears/re-clusters. Run, expect FAIL.
- [ ] **Step 2:** implement all three methods (postgres + in-memory parity).
- [ ] **Step 3:** integration test (`RUN_PG_INTEGRATION`) — park → retry (fresh budget) and
  park → dismiss end-to-end against the real store + `gap_closure_verification`.
- [ ] **Step 4:** `npm run test:db` green.

---

### Task 6: API endpoints

**Files:**
- Modify: `apps/api/src/features/questions/routes.ts` (existing gap routes at :46-57;
  `GET /:id` at :19).
- Modify: `docs/api.md`.

**Endpoints:**
- `POST /:id/gap/retry` (scope `feedback:questions`) → `retryParkedGap`, returns updated log.
- `POST /:id/gap/dismiss` (scope `feedback:questions`) → `dismissParkedGap`, returns updated log.
- `GET /parked` (scope `read:knowledge`, matching the list) → `listParkedQuestions` merged with
  the missing-log `needs_attention` proposals (labeled "triggering question deleted",
  read-only). **Register BEFORE `GET /:id`** or it resolves as `question_not_found` (M-nit 1).
- Idempotency: retry/dismiss on an already-unparked question is a no-op returning the current
  state; concurrent double-clicks are race-safe via the parked-predicate `UPDATE` (M-nit 2).

- [ ] **Step 1 (test-first):** route tests (`questions/routes.test.ts` or the gaps neighbour):
  retry un-parks + re-files, dismiss settles, `GET /parked` lists both parked questions and
  missing-log proposals, and the `/parked` route resolves before `/:id`. Run, expect FAIL.
- [ ] **Step 2:** implement; document in `docs/api.md`.
- [ ] **Step 3:** api tests + `app.test.ts` green.

---

### Task 7: Web — parked-questions surface + actionable badge

**Files:**
- Create: `ParkedQuestionsPanel` under `apps/web/src/components/` from `Surface`/`Button`/
  `Badge`/`Stack`/`Row` primitives (no `.css`).
- Modify: `apps/web/src/components/ProposalsPanel.tsx:129-133` — the `needs_attention` closure
  badge links to the parked surface.
- Modify: the web API client + the host page to mount the panel.

**Behaviour:** fetch `GET /api/questions/parked`; render each: question, flow, verification
`note`, `parkedAt`, and **Retry** / **Dismiss** buttons; refetch on success. Missing-log
entries render read-only with the "triggering question deleted" label.

- [ ] **Step 1:** build the panel + client calls; wire the badge link.
- [ ] **Step 2:** `npm run build --workspace web`, `npm run lint`; add a panel test if a
  harness exists.
- [ ] **Step 3:** drive it live (run-magpie): seed a parked question, confirm it lists, Retry
  re-admits it to candidacy (and re-drafts), Dismiss removes it.

---

### Task 8: Docs + orientation

**Files:**
- `docs/question-logging.md` (:26-30, :132-142, :165-170, :201) — parked *state*, retry/dismiss
  workflow, the new endpoints, the `purpose` discriminator; stop calling `needs_attention` a
  gap source.
- `docs/architecture.md` (:242-243), `docs/ai-jobs.md` (:216-217) — parked state, not source.
- `docs/api.md` — the endpoints (also Task 6).
- `.claude/skills/magpie-orientation` / `add-a-job-type` — if they enumerate the source enum.

- [ ] **Step 1:** update docs alongside the code.
- [ ] **Step 2:** `npm run format:check`; final full `npm run build && npm run typecheck &&
  npm run lint && npm test` green; push.

---

## Sequencing note

Task 0 lands first (its own PR is acceptable). Tasks 1–5 are one type/behaviour change and the
monorepo `typecheck` won't be green between them — land them as a single reviewed unit
(committing per file group) or gate the green checkpoint at the end of Task 5. Tasks 6–8 are
independently green. **Remember the three compiler-blind sites in Task 4** — a green typecheck
does not prove they were edited.

## Risk / verification checklist

- [ ] A parked question is excluded from candidates — one question-level predicate.
- [ ] `gapIdsForSummary`/`gapIdsForSummaries` return **no** gap of a parked question (incl. the
      sibling `auto` row) — the #158 bug, question-level (M3).
- [ ] `dismissGaps` cannot discharge a parked row in **either** store (M2).
- [ ] Retry re-files a live `verification` row when the underlying gap is gone — no silent
      no-op, note preserved (C1).
- [ ] The **second** post-retry failure still gets a fresh budget (C2), not just the first.
- [ ] Missing-log escalation: no parked gap row, but surfaces on the parked list as a read-only
      proposal entry (M1).
- [ ] #154: `purpose='verification'` re-ask logs excluded from candidacy/list/clustering, gap
      ingestion skipped, answer still recorded, history backfilled (Task 0).
- [ ] The three compiler-blind source sites (:539, :580, :604) were hand-edited and tested (M5).
- [ ] Migrations `0042` then `0043`, backfill-before-narrow, deploy migrate-then-restart.
- [ ] `jobs/src/schemas.ts:54` left untouched (M-nit 3).
- [ ] Proposal `closure_status = needs_attention` still renders — now with an actionable link.
- [ ] `#152` closed; `#150` closed with the abort-threading residue noted (or a follow-up).
