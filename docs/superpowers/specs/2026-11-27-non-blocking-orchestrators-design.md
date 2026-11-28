# Non-blocking maintenance orchestrators

Status: implemented (2026-11-27)

## Problem

A maintenance job is claimed by a watcher, which POSTs a thin API endpoint. For
three of the five orchestrators the API then **bounded-waits**
(`runJobToCompletion`) on a follow-up AI job it has just enqueued, and the
claiming watcher stays blocked inside that POST for the whole wait. A watcher runs
one job at a time, so the follow-up can only be claimed by a *second* watcher.
With one watcher the orchestration starves itself and times out — hence the
"run at least two watchers" rule, the console's single-watcher warning, and the
`VerificationIncompleteError → 503 → retry` dance in `verify_gap_closure` (#150).

`seed_bootstrap` already shows the alternative: enqueue, return, and let the
completion handler carry on.

## Audit: who actually blocks

Every `runJobToCompletion` caller, and every orchestrator:

| Orchestrator | Follow-up job | Before |
|---|---|---|
| `source_change_sync` | `sync_source_changes_generate_plan` | Already enqueue-only. A `source_sync_runs` row links the plan job; `attachSourceSyncPlanFromCompletedJob` continues. **No change.** |
| `editorial_patrol` | `improve_document` | Already enqueue-only; the proposal is drafted from the completion. **No change.** |
| `verify_gap_closure` | `answer_question` re-asks (one per triggering question) | Blocks on all re-asks (`proposals/service.ts`). |
| `process_gaps_to_pull_requests` | `reconcile_gap_clusters` reshape | Blocks on the reshape, then drafts (`gap-reconciler.ts`). |
| `correctness_patrol` | `verify_document` (≤10 per tick, sequential) | Blocks on each verify in turn (`patrol/service.ts`). |

So three conversions remove the constraint; the other two only needed their
"bounded-waits" comments corrected.

## Continuation model

One rule for all three: **the orchestrator enqueues its follow-up jobs, records
what it was in the middle of, and returns. The follow-up's completion resumes the
orchestration.**

The resume point is the completion dispatcher (`completeJob`), which persists the
job's output *before* running side effects and replays the side effects on a
retried completion. A continuation is one more side effect, so it inherits that
contract: a continuation that throws returns 500, the watcher re-POSTs, and the
replay re-runs the continuation — never the paid generation.

### Persisted state: `orchestration_followups` (migration 0070)

One row per follow-up job, keyed by job id:

| column | meaning |
|---|---|
| `job_id` | the follow-up AI job |
| `orchestrator` | which orchestration owns it |
| `scope_key` | the unit that settles as a whole — proposal id, flow key, patrol run id |
| `context` | what the continuation needs that the job input lacks |
| `status` | `pending` until the outcome has been applied, then `settled` |
| `result` | the applied outcome |

A job with no row is not an orchestrated follow-up (a live `/api/ask`, a manually
created job), so every continuation is a no-op for it.

Why a table rather than extra job-input fields: several of these inputs are
rendered verbatim into prompts (the code already guards them as "byte-identical"),
`verify_gap_closure` needs "all re-asks of this proposal" — a lookup by scope that
a scan of the busiest job type cannot serve reliably — and bookkeeping does not
belong in a job's domain contract (the same reasoning as `job_repair_contexts`).

The **broker stays the source of truth for whether a job is running**. A `pending`
row whose job is terminal is an outcome nobody has applied yet, not work in
flight — which is what makes the model self-healing (below).

### Three properties every continuation keeps

1. **Serialised.** A continuation runs under the same advisory lock as the thing
   it could race: the flow's reconcile tick, the proposal's other re-asks, or a
   second application of the same follow-up. Continuations must not *skip* on a
   held lock (the outcome would be lost), so they use `withFlowRunLockWaiting`,
   which polls the try-lock. It deliberately does not block on
   `pg_advisory_lock`: a blocked waiter pins a pooled connection, and enough
   simultaneous waiters would starve the lock holder of connections.
2. **Idempotent.** A settled row means "already applied"; a replay does nothing
   paid. Enqueues that cost money happen before the row settles and are guarded
   so a replay does not repeat them.
3. **Self-healing.** If a completion's continuation never ran (the watcher
   exhausted its `complete()` retries, the API restarted), the next orchestrator
   tick finds the `pending` row, sees the job is `completed`, and applies it
   inline through the same code path. If the job is `failed`/`cancelled`/gone,
   the tick settles the row as abandoned.

"No paid generation whose result nobody reads" used to be enforced by cancelling
the orphan when the bounded wait timed out. Nothing times out any more: a
follow-up's result is always read, by its completion or by the next tick.

## Per orchestrator

### `verify_gap_closure`

`verifyGapClosure` runs under a per-proposal lock and is re-entrant. For each
triggering question it either classifies it without a re-ask (already closed,
log missing, gap already settled — unchanged) or looks at the question's latest
follow-up row:

- no row, or its job failed/was cancelled → enqueue a re-ask and register a row
  (only when called as the orchestrator; a completion never enqueues);
- job in flight → pending;
- job completed → a real answer.

If anything is pending it returns `closureStatus: "pending"` and writes nothing.
Once every question has an outcome it commits them exactly as before (the Phase 2
loop is untouched) and deletes the proposal's rows.

Each re-ask's completion calls the same function with `enqueue: false`. The last
one to arrive finds every question answered and commits.

**The #150 rule holds by construction.** A verdict is only ever derived from a
re-ask job in state `completed`. A re-ask that failed, was cancelled, or has not
run yet produces *no* verdict — it is `pending` — so an infrastructure failure can
never be recorded as `still_open`. `VerificationIncompleteError`,
`VerificationAbortedError` and the 503 mapping are gone because the conditions
they reported (a bounded wait expiring, a request aborting mid-wait) no longer
exist.

Retry budget: the re-ask is an `answer_question` job with its own pg-boss retry
budget, and with no watcher free it simply waits in the queue. A re-ask that fails
*terminally* leaves the proposal unverified (as an exhausted `verify_gap_closure`
job did before) and logs an error; retrying that job in the console resumes the
verification, as does re-running `verify_gap_closure`.

Re-asks are still created directly (not through the maintenance fan-out budget),
so they keep `answer_question`'s interactive standing exactly as before.

### `process_gaps_to_pull_requests`

The reshape used to sit in the middle of a tick: assign gaps → **reshape** →
apply verdicts → draft → mark the revision processed. Now:

- The tick enqueues the reshape (through the fan-out budget, reusing an in-flight
  one via the same reuse key), registers a row carrying the composition hash and
  catalog revision it was judged at, **skips drafting**, holds the processed
  revision, and returns. Drafting before the verdicts arrive would turn clusters
  the critic is about to merge or dismiss into pull requests.
- The reshape's completion, under the flow's reconcile lock, applies the verdicts
  and records the judged composition hash. If the active composition is still the
  one that was judged, it drafts the uncovered clusters, marks the captured
  revision processed and drains the outbox — the rest of the old tick. If the
  composition moved while the reshape was in flight, it stops after applying, and
  the next tick re-judges.
- A tick that finds a reshape in flight skips clustering altogether.
- Best-effort is preserved: if the reshape for *this exact composition* failed,
  the next tick drafts without it, as a timed-out reshape did before.

### `correctness_patrol`

A tick used to verify ≤10 documents one after another. Now it enqueues every
verify (budget, reuse key and change gate unchanged) and returns; the dedupe and
split lenses, which never depended on the verdict, still run in the tick.

Each `verify_document` completion applies that one document's verdict through the
same code the tick used: annotate source conflicts, repair resolved ones, pass
the finding through the reconcile gate, enqueue `correct_document`, then stamp
the patrol cursor with the hash of the content it actually verified. A document
whose indexed content changed while the verify ran is left unstamped so it is
re-checked rather than gated on a state nobody verified.

The tick's `MaintenanceRun` is recorded `running` and completed when its last
verify settles, so its findings and summary are final rather than always zero.

## Behaviour changes a reviewer should know

- Maintenance endpoints return in milliseconds and report *enqueued* work:
  `verify-closure` may answer `closureStatus: "pending"`; `fix-patrol/run` reports
  how many verifies are still pending.
- A reshape tick no longer drafts in the same tick; drafting follows the reshape
  completion (typically seconds to minutes later).
- A correctness-patrol run stays `running` until its verifies finish.
- `correct_document` enqueues made from a verify completion are admitted through
  a fresh fan-out budget (the tick that enqueued the verify is long gone), so the
  per-tick budget no longer bounds verify + correct together. The global
  non-interactive ceiling still does.
- The two-watcher requirement is gone: no orchestrator waits on a job, so one watcher runs
  the whole pipeline. `runJobToCompletion`, its orphan-cancel and `MaintenanceShedError`
  are deleted with their last caller.

## Left for a follow-up

- **The console's single-watcher warning is still there** (`apps/web/src/lib/console.ts`,
  the `single-watcher` notice). It is now wrong, but a test in
  `apps/web/src/lib/console.test.tsx` pins it and the web tests were out of scope for this
  change. Removing it is a two-hunk edit: delete the `workers.length === 1` block, and turn
  the "warns when exactly one watcher is connected" test into "raises nothing for a single
  fully-capable watcher".
- **`JOB_RUN_TO_COMPLETION_TIMEOUT_MS` / `settings.jobs.runToCompletionTimeoutMs` no longer
  do anything** — the bounded wait they capped is gone. The config key, its test and the
  `.env.example` line were left in place for the separate env-var cleanup.
