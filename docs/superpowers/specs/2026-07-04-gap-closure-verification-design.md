# Gap-Closure Verification — Design

Date: 2026-07-04

## Goal

Close the open end of the knowledge-maintenance loop: after a proposal merges and
its destination re-indexes, **re-ask the questions that triggered the gap** and
confirm the merged Markdown actually answers them. Today the loop stops at merge —
a proposal carries its `triggeringQuestionIds` all the way through, but nothing
ever re-evaluates them. An AI-drafted document that reads well but doesn't really
answer the question silently "closes" its gap by assumption.

This feature turns that assumption into evidence. It adds a deterministic,
event-driven verification step that:

- marks a gap **verified closed** only when re-asking its triggering questions now
  produces a confident answer that cites the merged document; and
- **reopens** the gap — carrying the verification detail so the next draft sees
  *why* it is being resubmitted — when the fix did not land.

It also gives the product its first real outcome metric for the maintenance
pipeline: a **gap-closure rate** (the reporting layer on top of this is tracked
separately in GitHub issue #146, the insights/trends dashboard).

## Definitions

- **Triggering questions** — the question logs whose weak/ungrounded answers
  produced a gap. Already stored on the gap cluster and copied onto the proposal
  as `triggeringQuestionIds` (`packages/core`, `postgres-proposal-store.ts`).
- **Closure test** — a deterministic check on a re-asked answer: confidence is
  `high` or `medium` **and** at least one citation resolves into one of the merged
  proposal's target document(s). No AI is used in the test itself.
- **Re-ask** — enqueuing a normal `answer_question` job for a triggering question,
  routed explicitly to the proposal's flow. It exercises the real retrieval +
  grounding path, exactly as a user re-asking would, and produces a fresh question
  log as evidence.

## Non-goals

- **No regression detection in v1.** Re-running a sample of previously-confident
  questions to catch answers a merge *degraded* is a deliberate follow-up, not part
  of this spec.
- **No new AI judgment.** Closure is a deterministic field + citation-set check, not
  an LLM verdict. The only AI involved is the re-ask answers themselves (the normal
  answer pipeline).
- **No inline chat in the API.** This respects the queue-only model: the re-asks are
  `answer_question` jobs; the orchestrator is a queued job; the API only does the
  deterministic evaluation and state updates (which need DB access).
- **No auto-merge or bulk actions.** Reopened gaps flow back through the normal
  draft/reconcile pipeline; humans still gate every merge.
- **No verification for clusterless proposals.** Seed/direct-authoring proposals have
  no triggering questions; they are skipped.

## Approach (chosen: A — reuse `answer_question`, orchestrated via a maintenance endpoint)

This mirrors the existing maintenance-orchestrator pattern exactly (`reconcileGaps`,
the patrols): the **watcher's maintenance runner is only a trigger** — it claims the
queued job and POSTs to an API endpoint. **The API holds the orchestration**: for each
triggering question it re-asks via `runJobToCompletion("answer_question", …)` (which
enqueues the answer job and bounded-waits for a provider watcher to complete it), then
runs the **deterministic** closure evaluation and updates gap/proposal state. The API
never calls a provider inline — the re-asks are still `answer_question` jobs claimed by
a provider watcher, so the queue-only rule holds.

Concretely: on merge + re-index the API enqueues one `verify_gap_closure` job per merged
proposal. The maintenance watcher claims it and POSTs `POST /api/proposals/:id/verify-closure`.
That endpoint does the re-asks, the closure test, and the state writes, and returns counts —
the same shape as `POST /api/gaps/reconcile`.

Rejected alternatives:

- **B — pure API-side aggregator (no watcher runner):** fewer moving parts, but no
  owning job to appear in Schedules/`/dataflow`, retry, or bound. Breaks the
  "every unit of work is a visible, retriable job" grain of the codebase.
- **C — a single AI job that re-asks and self-judges closure:** fewer jobs, but it
  bypasses the real retrieval/grounding path (the whole point is to test the actual
  answer pipeline) and turns closure into a fuzzy AI judgment instead of a
  deterministic citation check. Undermines the signal.

## Job contract

New job type **`verify_gap_closure`** (`packages/jobs/src/types.ts`,
`catalog.ts`, `schemas.ts`):

- **Capability:** `maintenance` (non-provider). Queue name equals the type (no
  per-provider fan-out — the provider work happens in the `answer_question` jobs it
  spawns).
- **Input:** `{ proposalId: string }`.
- **Output:** `{ proposalId, perQuestion: [{ questionId, reaskedQuestionId, verdict:
  "closed" | "still_open" }], closureStatus: "verified_closed" | "reopened" |
  "needs_attention" }`.
- **Policy:** mirrors maintenance jobs — retry 2×, heartbeat 60s, an expiration/job
  budget sized to bounded-wait for N re-asked answers (reuse the maintenance
  runner's bounded-wait shape and its deadline tuning).

## Flow

1. A proposal transitions to **`merged`**:
   - GitHub PRs: `refresh_flow_snapshot` detects the merge and applies the
     transition.
   - Local-git: the console **Merge** action applies it.
   Both funnel through the same proposal-status transition, so the trigger is
   unified.
2. After the destination has been **re-indexed** (precondition — the merged doc must
   be searchable or the citation test cannot pass), the API enqueues
   `verify_gap_closure { proposalId }`, **only if the proposal has ≥1
   `triggeringQuestionId`**. This hooks into the existing post-merge re-index
   cascade so verification runs once the merged content is indexed.
3. The maintenance watcher claims the job and POSTs
   **`POST /api/proposals/:id/verify-closure`** (with the maintenance request
   timeout), exactly as it POSTs `reconcileGaps`/patrol endpoints today.
4. The API endpoint, for each triggering question, re-asks via
   `runJobToCompletion("answer_question", …)` with the proposal's flow pinned via
   **`requestedFlowId`** (so watcher routing cannot abstain). This enqueues a normal
   `answer_question` job that a provider watcher claims; the API bounded-waits for it.
5. The API runs the **deterministic closure test** per completed answer and writes the
   outcome (below). No provider call happens in the API process — only the deterministic
   evaluation and DB writes.

## Closure evaluation & outcomes

For each re-asked question, `verdict = closed` iff:

- the new answer's confidence ∈ `{ high, medium }`, **and**
- at least one of its citations resolves into one of the merged proposal's target
  documents (match on the proposal's target doc identity — file path / document id;
  the resolver must handle both path- and id-based citations).

**Important behavior change this gates.** Today `runMergeCascade` calls
`resolveGapsForMergedProposal` **unconditionally** on merge — it *assumes* the merge
closed the gap and marks the triggering questions' gaps resolved
(`questionLogs.resolveGaps`). This feature makes that resolution **evidence-based**:
the cascade re-indexes and enqueues `verify_gap_closure` instead of blindly resolving,
and resolution happens only when verification confirms it.

Aggregate per proposal (all-or-nothing — a partial fix still leaves a real gap):

- **All triggering questions `closed`** → proposal `closure_status =
  verified_closed`; call the existing `resolveGaps(questionIds, summaries, proposalId)`
  to mark the triggering questions' gaps resolved.
- **Any question `still_open`** → proposal `closure_status = reopened`: **do not**
  resolve the gaps (they stay open, so they naturally re-cluster and re-draft on the
  next reconcile tick). Record the failed verification so the next
  `draft_markdown_proposal` sees why it is being resubmitted — as a
  `QuestionGap` on the still-open triggering question with `source: "verification"`
  and a `note` carrying what was merged, the re-asked answer, and why it is still weak.
  The full detail also lands in `gap_closure_verification` (below).
- **Inconclusive** (a re-ask timed out / no provider watcher answered) → **not** a content
  verdict. *(Amended post-implementation — issue #150.)* Because this orchestrator blocks
  the claiming watcher inside the `/verify-closure` callback while it waits on the re-asks,
  a **single-watcher** deployment self-starves: the lone watcher can never claim its own
  re-asks, so they always time out. Treating that timeout as `still_open` (the original
  design) silently converted an infrastructure outage into a content verdict that wrongly
  reopened — and after two cycles parked — a correctly-merged doc. An incomplete re-ask now
  makes verification **throw** (endpoint returns `503`), so the `verify_gap_closure` job
  retries rather than recording a verdict; the proposal reads honestly as *unverified* until
  a re-ask completes. **Verification therefore requires ≥2 watchers** (the console warns at
  one). The re-asks also now run concurrently.
- **Loop guard:** count prior `still_open` `gap_closure_verification` rows for the
  triggering question. After **2** failed verifications, mark the proposal
  `closure_status = needs_attention` and record the still-open gap with
  `source: "needs_attention"` instead of leaving it to auto-redraft — preventing an
  infinite draft → merge → fail → draft loop.

## Data model

New table **`gap_closure_verification`** (one row per re-asked triggering question):

| column                 | notes                                                    |
|------------------------|----------------------------------------------------------|
| `id`                   | pk                                                       |
| `proposal_id`          | fk → proposal                                            |
| `gap_cluster_id`       | fk → gap cluster (nullable if the proposal's gap is gone)|
| `question_id`          | the original triggering question                        |
| `reasked_question_id`  | the fresh question log produced by the re-ask           |
| `verdict`              | `closed` \| `still_open`                                |
| `confidence`           | the re-asked answer's confidence                        |
| `cited_merged_doc`     | boolean — did a citation resolve into the merged doc     |
| `detail`               | re-asked answer text + why-weak note (evidence)          |
| `created_at`           | timestamp                                                |

Schema additions:

- Proposal gains **`closure_status`**: `verified_closed | reopened |
  needs_attention` (null until verified).
- The **loop-guard counter is derived**, not a new column: count prior `still_open`
  rows in `gap_closure_verification` for the triggering question. (Gap clusters carry
  no evidence/counters — gaps live on question logs — so nothing is added there.)
- `QuestionGap.source` gains two values — **`verification`** and
  **`needs_attention`** — and `QuestionGap` carries an optional **`note`** for the
  verification detail. (Existing values: `auto`, `followup`, `manual`.)

All schema changes go through the custom SQL migrator (`packages/db/migrations`,
`NNNN_` naming, append-only) per the **write-a-migration** skill.

## Web

The Proposals page gains a **closure badge** per proposal — *Verified closed* /
*Reopened* / *Needs attention* — with an expandable per-question breakdown and trace
links to the re-asked answers. This lets an operator immediately see "this PR merged
but did not actually answer its triggering question," which today is invisible.

## Error handling & edge cases

- **Re-index not yet complete:** the closure test needs the merged doc in the index.
  The job checks the merged doc is present before re-asking; if not, it fails and
  relies on the standard retry (bounded) so it effectively waits for indexing. Wiring
  the enqueue into the post-merge re-index cascade (step 2) makes this the rare case.
- **Proposal with zero triggering questions:** skipped entirely (no job enqueued).
- **Flow routing abstention:** avoided by passing the proposal's flow explicitly to
  each re-asked `answer_question`.
- **Citation resolution:** the resolver maps a proposal's target document(s) to
  citation references by both file path and document id, since citations may carry
  either.
- **GitHub vs local-git:** both reach the job through the unified proposal→`merged`
  transition, so no separate paths.
- **Idempotency:** re-delivered completions/callbacks must not double-write
  verification rows or double-increment the attempt counter (follow the existing
  idempotent-completion pattern used in the source-sync/job stores).

## Testing

- **Unit — closure evaluation** (table-driven): closed; cites the wrong doc;
  low/unknown confidence; no citation. Pure function over an answer + the proposal's
  target-doc set.
- **Unit — aggregation:** all-closed → `verified_closed`; any-open → `reopened` with
  evidence; attempt counter at cap → `needs_attention`.
- **Integration (Postgres, `RUN_PG_INTEGRATION`, throwaway-container harness):**
  enqueue `verify_gap_closure`, feed deterministic `answer_question` completions via
  provider fixtures, assert proposal `closure_status`, `gap_closure_verification`
  rows, gap reopen + `prior_attempt_verification` evidence, and the loop-guard
  transition to `needs_attention`.

Follow the **writing-magpie-tests** skill for conventions.

## Docs to update

- `docs/question-logging.md` — the closure loop and its outcomes.
- `docs/architecture.md` — the tier-1/tier-2 table + the new job.
- `docs/ai-jobs.md` — the new orchestrator job and its re-ask fan-out.
- `docs/api.md` — the `POST /api/proposals/:id/closure` callback.
- The `magpie-orientation` skill's job list.

## Open decisions (defaulted, easy to change)

- **All-or-nothing closure per proposal** (any open question reopens the whole gap).
- **Attempt cap = 2** before `needs_attention`.
- **Regression detection deferred** to a follow-up spec.
