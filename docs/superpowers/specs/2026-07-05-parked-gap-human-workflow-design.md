# Parked-Gap Human Workflow — Design

Date: 2026-07-05
Issue: #158

## Problem

`needs_attention` is an escalation **state** smuggled into the `QuestionGapSource`
enum (`packages/core/src/index.ts:176`). "Parked, awaiting a human" is not modelled as
state — it is re-derived at every read site by string-matching that pseudo-source. Three
things fall out of that:

1. **Scattered predicate.** At least six sites must remember that `needs_attention`
   (and its sibling `verification`) are not really sources:
   - candidate-exclusion subquery — `postgres-question-log-store.ts:593-600`
     (`WHERE source = 'needs_attention'`)
   - in-memory candidacy skip — `question-log-store.ts:470`
     (`active.some(gap => gap.source === "needs_attention")`)
   - `recordVerificationGap` in-place update — both stores
     (`postgres-question-log-store.ts:353`, `question-log-store.ts:345`:
     `source IN ('verification','needs_attention')`)
   - `reopenSummaryFor` filter — `service.ts:539` (`gap.source !== "needs_attention"`)
   - resubmission-note filter — `service.ts:580`
   - live-row finder — `service.ts:604`, and the reopen guard `service.ts:1031`
   - `verificationLineageResetSince` — `service.ts:604` (`=== "verification" || === "needs_attention"`)

2. **A latent correctness bug.** `gapIdsForSummary` / `gapIdsForSummaries`
   (`postgres-question-log-store.ts:29-63`) filter only on `resolved_at`/`dismissed_at` —
   **no park filter.** They are called from `gap-reconciler.ts` and `gap-backfill.ts`.
   Because a parked gap reuses the triggering question's summary, if another question
   shares that summary the parked row is swept into a cluster membership where an **AI
   cluster dismissal can silently discharge a human escalation.**

3. **No first-class human workflow.** The `ProposalsPanel.tsx:129` "Needs attention" badge
   renders but links to nothing; the web console never lists persisted question gaps or
   their diagnostic `note` (only via raw `GET /api/questions/:id`). And there is no wired
   *action*: `DELETE /questions/:id/gap` removes only `source='manual'` rows
   (`postgres-question-log-store.ts:309`); `dismissGaps` is reachable only via AI cluster
   dismissal; a parked question is excluded from candidates so it can never become a
   `triggeringQuestionId` again and `resolveGaps` can never match it. The only technical
   unpark is manually POSTing `/proposals/:id/verify-closure`, documented as a watcher
   callback. `docs/question-logging.md:134` promises "waits for a human" — but the human
   has nothing to do.

## Goal

Model "parked, awaiting a human" as **first-class gap state**, collapse the scattered
source special-cases into one predicate, close the `gapIdsForSummary` hole, and give a
human two wired actions (**retry** / **dismiss**) plus a place to see parked questions and
their verification note.

## Folded-in dependency: #154 (verification re-asks defeat parking)

**#154 must be fixed as part of this work, not after it.** A parked state is only
meaningful if the gap stays parked, and #154 is a second door that re-opens it: each
verification re-ask records an ordinary question log
(`recordAnswerQuestionLog(ctx, original.question)`, `service.ts:442`) with **no synthetic
marker**, its `answer_question` completion writes the answer's own `auto`/`followup` gap
rows onto that re-ask log, and those logs re-enter gap candidacy under a *new* question id —
so the reconciler auto-redrafts the very gap that was just parked (park keys on the
*original* question id only). It also pollutes `GET /api/questions`.

Fold-in fix: add a **`purpose`** discriminator to the question log
(`"live" | "verification"`, default `"live"`), stamp re-ask logs `"verification"`, and
exclude `purpose='verification'` logs from (a) gap candidacy, (b) the questions list, and
(c) gap-signal ingestion on completion. This is the same subsystem and the same store, and
it makes parking (and the retry/dismiss transitions below) actually hold. See Task 0 in the
plan.

**Already resolved, do not fold in:** #150 (single-watcher self-starvation / non-idempotent
retries) and #152 (retry counter only grows) are **already implemented** in the current
code — Phase 1b `incomplete` handling + concurrent re-asks + `questionsWithClosedVerdict`
(#150) and `verificationLineageResetSince` (#152). #158's own "`countPriorStillOpen` only
grows (#152), so once capped, always capped" is stale. Recommend verifying and closing both
rather than reworking them here.

## Non-goals

- **No change to when a gap parks.** The retry-cap loop guard (`CLOSURE_RETRY_CAP`, the
  distinct-proposal count bounded by the lineage reset) is correct and stays as-is. Only
  *how* the parked state is represented and acted on changes.
- **No new AI judgment.** Retry and dismiss are deterministic human actions; retry simply
  re-admits the underlying gap to the existing draft/reconcile pipeline.
- **No inline chat in the API.** Unchanged — a human retry re-admits the gap to candidacy;
  any re-draft still runs through the queued `draft_markdown_proposal` path.
- **No change to proposal `closureStatus`.** `needs_attention` stays a valid *proposal
  outcome* label (it accurately describes "this proposal's verification ended parked") — it
  is display-only and not part of the scattered gap predicate. We make its badge
  actionable, not renamed. (See Open decisions.)

## Model

Introduce a nullable **`parked_at`** timestamp (+ **`parked_reason`**) on `question_gaps`,
mirroring the existing `resolved_at` / `dismissed_at` lifecycle columns. Collapse the
`needs_attention` **source** back into `verification`: the two were always the *same
source* (a gap raised server-side by gap-closure verification) at two escalation levels —
before the retry cap (`verification`, still auto-redrafts) and after it (`needs_attention`,
parked). "After the cap" becomes `parked_at IS NOT NULL`, not a distinct source.

```
QuestionGapSource:  "auto" | "manual" | "followup" | "verification"   (drop needs_attention)
QuestionGap gains:  parkedAt?: string   parkedReason?: string
```

**Parked predicate (the one predicate).** A gap row is parked iff
`parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL`. Park is
**question-level** for candidacy (as today): a question is excluded from gap candidates iff
it has any live parked row.

### State transitions

```
                 verify fails (< cap)          verify fails (== cap)
   auto/followup ───────────────────► verification ───────────────────► verification+parked_at
   gap (open)      recordVerificationGap        (open, re-drafts)          (parked, excluded)
                                                                                │
                                       human RETRY  (dismiss the parked row) ◄──┤
                                       human DISMISS (dismiss all live gaps) ◄──┘
```

- **Park** (`recordVerificationGap`, capped branch): keep `source='verification'`, set
  `parked_at = now()`, `parked_reason = 'verification retry cap'`. (Was: `source =
  'needs_attention'`.) The in-place update keeps exactly one live `verification` row per
  question, as today.
- **Human retry / unpark**: mark the parked `verification` row `dismissed_at = now()`,
  `dismissed_reason = 'human_retry'`. This reuses the existing settlement path:
  - it un-parks the question (the parked predicate requires `dismissed_at IS NULL`), so the
    still-open underlying `auto`/`followup` gap re-enters candidacy and re-drafts;
  - it is exactly the lineage-reset boundary `verificationLineageResetSince` already looks
    for (most-recent verification row is dismissed → `countPriorStillOpen` restarts), so
    the retried question gets a **fresh retry budget** rather than instant re-park.
  No new reset column is needed — the retry-budget machinery already anticipates "a human
  dismissed it" (see `verificationLineageResetSince` and `docs/question-logging.md:137-142`).
- **Human dismiss**: dismiss **all** live gap rows for the question (or the parked
  summary), `dismissed_reason = 'human_dismiss'` — the topic is abandoned, nothing
  re-drafts. This is the existing `dismissGaps` path, which every consumer (including
  `gapIdsForSummary`) already honours.

### The bug fix falls out of the model

`gapIdsForSummary` / `gapIdsForSummaries` (and their in-memory twin) gain
`AND parked_at IS NULL` — the same predicate candidacy uses. A parked gap is then invisible
to cluster-membership resolution, so an AI cluster dismissal can no longer reach it. This is
the concrete correctness fix embedded in the altitude cleanup.

## API

- **`GET /api/questions/parked`** — lists questions with a live parked gap: question id,
  text, flow, the parked gap's `summary` and `note` (the last verification detail), and
  `parkedAt`. This is the surface the console renders and the "Needs attention" badge links
  to. (Implementation reads the same store; a dedicated store method
  `listParkedQuestions(limit)` keeps the predicate in one place.)
- **`POST /api/questions/:id/gap/retry`** (scope `feedback:questions`) — the retry
  transition above. Returns the updated question log.
- **`POST /api/questions/:id/gap/dismiss`** (scope `feedback:questions`) — the dismiss
  transition above. Returns the updated question log.

`DELETE /questions/:id/gap` keeps its current manual-only semantics (clearing the manual
flag); the two new endpoints are the parked-gap verbs so the manual-clear path stays
untouched.

## Web

- A **Parked questions** surface in the console (a section/tab under the Ask/Proposals
  admin area) listing `GET /api/questions/parked`: each row shows the question, the
  verification `note` (why the merged doc still fell short), and **Retry** / **Dismiss**
  buttons wired to the two endpoints. Built from the existing UI primitives
  (`Surface`, `Button`, `Badge`, `Stack/Row`) — no new stylesheet.
- The `ProposalsPanel` **"Needs attention"** closure badge links to that surface (filtered
  to the proposal's triggering questions where feasible) so the badge is actionable rather
  than a dead tooltip.

## Data model / migration

New migration **`0042_gap_parked_state.sql`** (append-only, per write-a-migration skill):

1. `ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_at timestamptz;`
   `ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_reason text;`
2. **Backfill** existing parked rows before narrowing the CHECK:
   `UPDATE question_gaps SET parked_at = created_at, parked_reason = 'verification retry cap'
    WHERE source = 'needs_attention';`
   then `UPDATE question_gaps SET source = 'verification' WHERE source = 'needs_attention';`
   (Rows already resolved/dismissed keep their timestamps; the parked predicate’s
   `resolved_at/dismissed_at IS NULL` guard means a resolved-then-`needs_attention` row does
   not resurrect as parked.)
3. Narrow the source CHECK:
   `ALTER TABLE question_gaps DROP CONSTRAINT IF EXISTS question_gaps_source_check;`
   `ALTER TABLE question_gaps ADD CONSTRAINT question_gaps_source_check
     CHECK (source IN ('auto','manual','followup','verification'));`
4. Partial index for the candidacy anti-join:
   `CREATE INDEX IF NOT EXISTS question_gaps_parked_idx ON question_gaps (question_id)
     WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL;`

Proposal `closure_status` CHECK is **unchanged** (`needs_attention` stays a valid proposal
outcome).

## Testing

- **Unit — parked predicate:** a parked question is excluded from `listGapCandidates`;
  after retry it is re-included with a reset retry budget; after dismiss it stays out and
  never re-clusters. (Postgres + in-memory store parity, per writing-magpie-tests.)
- **Unit — the bug:** `gapIdsForSummary` / `gapIdsForSummaries` do **not** return a parked
  row even when another question shares the summary — locks the AI-dismissal-can't-reach-a-
  parked-escalation property.
- **Unit — recordVerificationGap:** capped branch sets `parked_at` and keeps
  `source='verification'`; the in-place update still keeps one live row.
- **Integration (Postgres, `RUN_PG_INTEGRATION`):** full park → retry (fresh budget) and
  park → dismiss (abandoned) flows through the real store, asserting the
  `gap_closure_verification` lineage reset.
- **Migration test:** an existing `source='needs_attention'` row backfills to
  `source='verification'` + `parked_at`, and is excluded from candidates identically.
- **Existing tests** that assert `source === 'needs_attention'` (service.test.ts,
  question-log-store.test.ts, postgres-question-log-store.test.ts) are rewritten to assert
  `parkedAt` instead — the behaviour is preserved, the encoding changes.

## Docs to update

- `docs/question-logging.md` — the parked state, the retry/dismiss human workflow, the new
  endpoints; the retry-cap section stops referring to a `needs_attention` source.
- `docs/architecture.md`, `docs/ai-jobs.md` — `needs_attention` is a parked *state*, not a
  gap source.
- `docs/api.md` — the two new endpoints + `GET /api/questions/parked`.
- The `add-a-job-type` / `magpie-orientation` references, where they mention the source enum.

## Open decisions (defaulted, easy to change)

- **Keep `closure_status = needs_attention`** as a proposal-outcome label (default), rather
  than renaming it `parked`. It is display-only and accurate; renaming is migration churn
  with no predicate payoff.
- **Retry = dismiss-the-verification-row** (default) rather than a dedicated "clear
  parked_at + new reset column". Chosen because it reuses the existing lineage-reset
  boundary the retry-cap code already reads, so no second reset mechanism is introduced.
- **Question-level park** retained (a parked question excludes all its gaps from
  candidacy), matching current behaviour, rather than row-level park.
