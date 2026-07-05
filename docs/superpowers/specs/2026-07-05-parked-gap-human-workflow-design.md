# Parked-Gap Human Workflow — Design

Date: 2026-07-05
Issue: #158 (folds in #154)
Reviewed: adversarial design review 2026-07-05 (all CRITICAL/MAJOR/MINOR findings folded in below).

## Problem

`needs_attention` is an escalation **state** smuggled into the `QuestionGapSource` enum
(`packages/core/src/index.ts:176`). "Parked, awaiting a human" is not modelled as state — it
is re-derived at every read site by string-matching that pseudo-source. Three things fall
out of that:

1. **Scattered predicate.** Multiple sites must remember that `needs_attention` (and its
   sibling `verification`) are not really sources:
   - candidate-exclusion anti-join — `postgres-question-log-store.ts:598-601`
     (`WHERE source = 'needs_attention'`)
   - in-memory candidacy skip — `question-log-store.ts:470`
     (`active.some(gap => gap.source === "needs_attention")`)
   - `recordVerificationGap` in-place update — both stores
     (`postgres-question-log-store.ts:353`, `question-log-store.ts:345`:
     `source IN ('verification','needs_attention')`)
   - `addressedGapsAllSettled` filter — `service.ts:539` (`gap.source !== "needs_attention"`)
   - `reopenSummaryFor` filter — `service.ts:580`
   - live-row finder — `service.ts:604`
   - resubmission-note filter — `service.ts:1031`
   - `verificationLineageResetSince` — `service.ts:604`
     (`=== "verification" || === "needs_attention"`)

   **Compiler-blind sites (important):** `addressedGapsAllSettled` (:539), `reopenSummaryFor`
   (:580), and `verificationLineageResetSince` (:604) take structurally-typed
   `source: string` params, so narrowing the `QuestionGapSource` enum will **not** flag them
   — a stale `!== "needs_attention"` silently becomes a no-op filter. Every other site is
   caught by the compiler. These three must be edited by hand and tested.

2. **A latent correctness bug.** `gapIdsForSummary` / `gapIdsForSummaries`
   (`postgres-question-log-store.ts:29-94`; in-memory `:139-155`) filter only on
   `resolved_at`/`dismissed_at` — **no park filter.** They are called from
   `gap-reconciler.ts:346` and `gap-backfill.ts:44`, and membership dismissal at
   `gap-reconciler.ts:766` dismisses every member gap id. Because a parked gap reuses the
   triggering question's summary, if another question shares that summary the parked
   question's rows are swept into a cluster membership where an **AI cluster dismissal can
   silently discharge a human escalation.**

3. **No first-class human workflow.** The `ProposalsPanel.tsx:129-133` "Needs attention"
   badge renders but links to nothing (verified inert); the web console never lists
   persisted question gaps or their diagnostic `note` (only via raw `GET /api/questions/:id`).
   And there is no wired *action*: `DELETE /questions/:id/gap` removes only `source='manual'`
   rows (`postgres-question-log-store.ts:395`); `dismissGaps` is reachable only via AI cluster
   dismissal; a parked question is excluded from candidates so it can never become a
   `triggeringQuestionId` again and `resolveGaps` can never match it. The only technical
   unpark is manually POSTing `/proposals/:id/verify-closure`, documented as a watcher
   callback. `docs/question-logging.md:134` promises "waits for a human" — but the human has
   nothing to do.

## Goal

Model "parked, awaiting a human" as **first-class gap state**, collapse the scattered source
special-cases into one predicate, close the `gapIdsForSummary` hole, and give a human two
wired actions (**retry** / **dismiss**) plus a place to see parked questions and their
verification note.

## Folded-in dependency: #154 (verification re-asks defeat parking)

**#154 must be fixed as part of this work.** A parked state is only meaningful if the gap
stays parked, and #154 is a second door that re-opens it: each verification re-ask records an
ordinary question log (`recordAnswerQuestionLog`, `platform/answer-question.ts:19-25`, called
at `service.ts:442`) with **no synthetic marker**; its `answer_question` completion runs
`updateQuestionLogFromCompletedJob` (`jobs/service.ts:395-421`) unconditionally and writes the
answer's own `auto`/`followup` gap rows onto that re-ask log; and `GET /api/questions`
(`questions/service.ts:28-30`) filters nothing. Those re-ask logs re-enter gap candidacy under
a *new* question id — so the reconciler auto-redrafts the very gap that was just parked (park
keys on the *original* question id only) — and pollute the questions list.

Fold-in fix: add a **`purpose`** discriminator to the question log (`"live" | "verification"`,
default `"live"`), stamp re-ask logs `"verification"`, and:
- exclude `purpose='verification'` logs from gap candidacy, the questions list, and
  `gapIdsForSummary`/`gapIdsForSummaries` clustering;
- **skip gap-signal ingestion** on completion for a `purpose='verification'` log while still
  **recording its answer/citations** (the `reasked_question_id` audit trail must survive;
  verification verdicts read the job output, not the log, so this is safe);
- **backfill** existing re-ask logs: `UPDATE questions SET purpose='verification' WHERE id IN
  (SELECT reasked_question_id FROM gap_closure_verification WHERE reasked_question_id IS NOT
  NULL)` — otherwise historical re-ask logs default `'live'` and pollute forever.

This is the same subsystem and store; it makes parking (and the retry/dismiss transitions)
actually hold. It is sequenced **first** (Task 0). It is separable enough to land as its own
PR if preferred for reviewability, but parking genuinely depends on it, so it must precede the
rest.

**Already resolved, do not fold in:** #152 (retry counter only grows) is **already closed**
(2026-07-04) via `verificationLineageResetSince`. #158's own "`countPriorStillOpen` only grows
(#152), so once capped, always capped" is stale. #150 (single-watcher self-starvation /
non-idempotent retries) has its **correctness** sub-claims implemented — Phase 1b `incomplete`
handling + `VerificationIncompleteError` (`service.ts:79-115,248-266`), concurrent re-asks
(`Promise.all`, :248), `questionsWithClosedVerdict` resumability (:241) + entry guard
(:216-222). One residue remains: **no abort threading** — a watcher-POST timeout retries
`verify_gap_closure` while the first API-side run keeps executing (the entry guard can't stop
the overlap because `closureStatus` is unset until the first run finishes), so duplicate
re-asks / LLM spend and duplicate audit rows are still possible (retry-cap safety holds via
`count(DISTINCT proposal_id)`). Recommend closing #152; close #150 **with the abort residue
noted**, or spin a small follow-up — do not claim it is 100% done. This design's C2 fix
(below) also hardens #152's reset generally.

## Model

Introduce a nullable **`parked_at`** timestamp (+ **`parked_reason`**) on `question_gaps`,
mirroring the existing `resolved_at` / `dismissed_at` lifecycle columns. Collapse the
`needs_attention` **source** back into `verification`: the two were always the *same source*
(a gap raised server-side by gap-closure verification) at two escalation levels — before the
retry cap (`verification`, still auto-redrafts) and after it (`needs_attention`, parked).
"After the cap" becomes `parked_at IS NOT NULL`, not a distinct source.

```
QuestionGapSource:  "auto" | "manual" | "followup" | "verification"   (drop needs_attention)
QuestionGap gains:  parkedAt?: string   parkedReason?: string
QuestionLog gains:  purpose?: "live" | "verification"   (default "live", from #154)
```

**Parked predicate (the one predicate).** A gap row is parked iff
`parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL`. Park is
**question-level** for candidacy (as today): a question is excluded from gap candidates iff it
has any live parked row — **and the same question-level exclusion applies to
`gapIdsForSummary` clustering** (see the bug fix), not merely a row-level parked filter.

### State transitions

```
                 verify fails (< cap)          verify fails (== cap)
   auto/followup ───────────────────► verification ───────────────────► verification+parked_at
   gap (open)      recordVerificationGap        (open, re-drafts)          (parked, excluded)
                                                                                │
                                       human RETRY  (see below) ◄───────────────┤
                                       human DISMISS (dismiss all live gaps) ◄───┘
```

- **Park** (`recordVerificationGap`, capped branch): keep `source='verification'`, set
  `parked_at = now()`, `parked_reason = 'verification retry cap'`. (Was: `source =
  'needs_attention'`.) The in-place update keeps exactly one live `verification` row per
  question, as today.

- **Human retry / unpark** — dismiss the parked `verification` row (`dismissed_at = now()`,
  `dismissed_reason = 'human_retry'`) **AND, if the question has no remaining live gap row
  carrying the parked summary, insert a fresh live `verification` row** (same summary, same
  `note`, `parked_at = NULL`). This is a **CRITICAL correction (C1)** over the naive "just
  dismiss the row": the underlying `auto`/`followup` gap is **not guaranteed to exist** at
  retry time —
    1. `reopenSummaryFor`'s final fallback can have filed the verification gap under raw
       question text (`service.ts:583`), making the parked row the question's *only* live gap;
    2. an AI cluster dismissal can have dismissed the sibling `auto` row
       (`gap-reconciler.ts:346-368,766`);
    3. a sibling proposal's `resolveGaps` (matching any source by `(question, summary)`,
       `postgres-question-log-store.ts:471-481`) can have resolved it.
  Without the re-file, retry would dismiss the parked row, return 200, and **nothing would
  ever re-draft** — the escalation evaporates with a success response — and the verification
  `note` would be lost (the re-draft's `resubmissionNotes` filter requires `!dismissedAt`,
  `service.ts:1031`). Re-filing a fresh live `verification` row guarantees candidacy, carries
  the note into the next draft, and keeps the dismissed row as the lineage-reset boundary.
  **This re-file is only correct together with the C2 fix below** — otherwise the fresh live
  row becomes the most-recent lineage row and destroys the reset boundary, insta-re-parking
  on the next failure.

- **Human dismiss**: dismiss **all** live gap rows for the question,
  `dismissed_reason = 'human_dismiss'` — the topic is abandoned, nothing re-drafts.

### C2 — the retry-budget reset must key on the most recent *settled* lineage row

`verificationLineageResetSince` (`service.ts:599-609`) today returns the reset boundary only
when the **most recent** lineage row is settled (resolved/dismissed). That is correct only by
coincidence of `CLOSURE_RETRY_CAP = 2`: after a retry re-files a fresh live row, the next
failure sees a *live* most-recent row → `since = undefined` → `countPriorStillOpen`
(`gap-closure-verification-store.ts:112-124`) counts **all-time** distinct proposals →
**instant re-park**. It is masked today because the existing test only exercises the first
post-reset failure (`service.test.ts:751-797`), and at cap 2 the first post-reset failure is
correctly bounded either way.

**Fix:** find the most recent **settled** lineage row instead of requiring the most-recent row
to be settled:

```ts
const lineageGap = [...(original.gaps ?? [])]
  .reverse()
  .find((gap) => gap.source === "verification" && (gap.resolvedAt || gap.dismissedAt));
```

Because `recordVerificationGap` keeps exactly one live row per lineage, the most recent settled
row is always the previous lineage's end — so a retried (or human-dismissed, or
sibling-resolved) question gets a genuine fresh budget regardless of cap. Add a test for the
**second** post-retry failure. This is also the durable form of #152's reset.

### The bug fix falls out of the model — but must be question-level

`gapIdsForSummary` / `gapIdsForSummaries` (and their in-memory twin) must exclude **all gap
rows of a parked question** (the same question-level anti-join candidacy uses), not merely
rows whose own `parked_at` is set. A **row-level** `parked_at IS NULL` filter leaves the
parked question's **sibling `auto` row** (same summary, `parked_at IS NULL`) sweepable into
clusters and AI-dismissible — which both contradicts "park is question-level" and is the
direct enabler of C1 scenario 2. No caller needs parked rows returned (verified: reconciler
assignment, backfill, and membership reads operate on already-assigned ids). Additionally,
`dismissGaps` itself must **skip parked rows in both stores** — because in-memory gap ids are
`${log.id}::${summary}` (`question-log-store.ts:151`), the auto row and parked row are
indistinguishable there, so filtering `gapIdsForSummary` alone is insufficient: the auto row's
id still reaches `dismissGaps`, which then dismisses the parked row too (`:407-442`). Human
dismiss goes through the dedicated `dismissParkedGap`, so the reconciler-reachable `dismissGaps`
never needs to touch a parked row.

## API

- **`GET /api/questions/parked`** (scope `read:knowledge`, matching the list) — lists
  questions with a live parked gap: question id, text, flow, the parked gap's `summary` and
  `note` (the last verification detail), and `parkedAt`. Must be registered **before**
  `GET /:id` (`questions/routes.ts:19`) or it resolves as `question_not_found`. A dedicated
  store method `listParkedQuestions(limit)` keeps the predicate in one place.
  **Also lists `closure_status='needs_attention'` proposals that have no parked question row**
  (the missing-log escalation, M1 below), labeled distinctly (e.g. "triggering question
  deleted"), so that escalation class is not invisible.
- **`POST /api/questions/:id/gap/retry`** (scope `feedback:questions`) — the retry transition
  above. On an already-unparked question: no-op returning the current log (the
  `UPDATE … WHERE parked-predicate` shape is naturally race-safe — a second concurrent writer
  matches 0 rows). Returns the updated question log.
- **`POST /api/questions/:id/gap/dismiss`** (scope `feedback:questions`) — the dismiss
  transition above; same idempotency contract.

`DELETE /questions/:id/gap` keeps its manual-only semantics
(`postgres-question-log-store.ts:395`); the new endpoints are the parked-gap verbs.

### M1 — the missing-log escalation has no gap row

When a triggering question's log is gone, verification records only a
`gap_closure_verification` audit row and sets `needsAttention` (`service.ts:287-306`); it does
**not** call `recordVerificationGap` (there is no log to attach a gap to — `docs/question-
logging.md:165-170`). So that proposal reaches `closure_status='needs_attention'` with **no
parked gap row**. The parked surface therefore must also enumerate such proposals (as above);
a `retry`/`dismiss` on them is N/A (no log). This must be stated in both the API behaviour and
the plan (the earlier draft's "missing-log now produces a parked verification gap" was wrong).

## Web

- A **Parked questions** surface in the console (a section/tab under the Ask/Proposals admin
  area) listing `GET /api/questions/parked`: each row shows the question, the verification
  `note`, `parkedAt`, and **Retry** / **Dismiss** buttons wired to the two endpoints; on
  success it refetches. Missing-log escalations render read-only with the "triggering question
  deleted" label. Built from the existing UI primitives (`Surface`, `Button`, `Badge`,
  `Stack/Row`) — no new stylesheet.
- The `ProposalsPanel` **"Needs attention"** closure badge (currently inert,
  `ProposalsPanel.tsx:129-133`) links to that surface so it is actionable.

## Data model / migrations

Two append-only migrations (per write-a-migration skill; `0042` is the next free number,
verified):

**`0042_question_purpose.sql`** (Task 0 / #154 — must precede the parked-state migration):

```sql
ALTER TABLE questions ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'live'
  CHECK (purpose IN ('live','verification'));
UPDATE questions SET purpose = 'verification'
  WHERE id IN (SELECT reasked_question_id FROM gap_closure_verification
               WHERE reasked_question_id IS NOT NULL);
```

**`0043_gap_parked_state.sql`:**

```sql
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_at timestamptz;
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_reason text;

-- Backfill existing escalations, then fold the pseudo-source back into 'verification'.
-- NB parked_at = created_at is the FIRST-failure time (rows are updated in place), not the
-- exact park time — cosmetic; documented, not load-bearing.
UPDATE question_gaps SET parked_at = created_at, parked_reason = 'verification retry cap'
  WHERE source = 'needs_attention';
UPDATE question_gaps SET source = 'verification' WHERE source = 'needs_attention';

ALTER TABLE question_gaps DROP CONSTRAINT IF EXISTS question_gaps_source_check;
ALTER TABLE question_gaps ADD CONSTRAINT question_gaps_source_check
  CHECK (source IN ('auto','manual','followup','verification'));

CREATE INDEX IF NOT EXISTS question_gaps_parked_idx ON question_gaps (question_id)
  WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL;
```

Backfill-before-narrow is required (no row can then violate the narrowed CHECK). Deploy
migrate-then-restart: an old API process still running after the migration would fail the new
CHECK if it wrote `needs_attention` — acceptable under the standard deploy order, noted for
operators. Proposal `closure_status` CHECK is **unchanged** (`needs_attention` stays a valid
proposal outcome — display-only, verified no predicate reads it).

## Testing

- **Unit — parked predicate:** a parked question is excluded from `listGapCandidates`; after
  retry it is re-included with a reset retry budget; after dismiss it stays out and never
  re-clusters. (Postgres + in-memory parity.)
- **Unit — the bug (#158):** `gapIdsForSummary`/`gapIdsForSummaries` do **not** return any gap
  of a parked question even when another question shares the summary — including the sibling
  `auto` row (question-level exclusion).
- **Unit — in-memory `dismissGaps` parity (M2):** dismissing by a shared summary does not
  dismiss a parked row.
- **Unit — retry re-file (C1):** retry when the underlying gap was already
  dismissed/resolved re-files a live `verification` row (candidacy restored, note preserved).
- **Unit — reset budget (C2):** the **second** post-retry failure still reads a fresh budget
  (not just the first).
- **Unit — recordVerificationGap:** capped branch sets `parked_at`, keeps
  `source='verification'`, one live row.
- **Unit — #154:** a fixture routed through `completeJob` (not the
  `service.test.ts:45-62` shortcut) so a re-ask completion *would* write gap rows; assert a
  `purpose='verification'` re-ask log acquires **no** candidacy entry, is absent from
  `GET /api/questions`, and its answer/citations **are** still recorded.
- **Unit — missing-log (M1):** a missing-log escalation does not appear as a ret/dismiss-able
  parked *question* but does surface on the parked list as a read-only proposal entry.
- **Integration (Postgres, `RUN_PG_INTEGRATION`):** full park → retry (fresh budget) and
  park → dismiss (abandoned) through the real store + `gap_closure_verification`.
- **Migration test:** an existing `source='needs_attention'` row backfills to
  `source='verification'` + `parked_at`; an existing re-ask log backfills to
  `purpose='verification'`.
- **Existing `needs_attention`-source assertions** (service.test.ts, question-log-store.test.ts,
  postgres-question-log-store.test.ts) are rewritten to assert `parkedAt` — behaviour held,
  encoding changed.

## Docs to update

- `docs/question-logging.md` — the parked state, the retry/dismiss workflow, the new
  endpoints, the `purpose` discriminator; the retry-cap section stops referring to a
  `needs_attention` source.
- `docs/architecture.md` (:242-243), `docs/ai-jobs.md` (:216-217) — `needs_attention` is a
  parked *state*.
- `docs/api.md` — the two POSTs + `GET /api/questions/parked`.
- The `magpie-orientation` / `add-a-job-type` references where they enumerate the source enum.

## Open decisions (defaulted, easy to change)

- **Keep `closure_status = needs_attention`** as a proposal-outcome label (default). Verified
  no predicate reads it; renaming is migration churn with no payoff.
- **Retry = dismiss-then-conditionally-re-file** (default, C1) rather than mutating the parked
  row's `parked_at` in place. Chosen so the dismissed row is a clean lineage-reset boundary and
  the re-filed row carries the note into the re-draft.
- **Question-level park** retained (a parked question excludes all its gaps from candidacy and
  clustering), matching current behaviour.
- **#154 folded in vs. separate PR:** folded in (Task 0, sequenced first) because parking
  depends on it; may be split into its own PR for reviewability without changing the sequence.
