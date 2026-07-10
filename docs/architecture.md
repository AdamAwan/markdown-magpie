# Architecture

Markdown Magpie is designed around provider-neutral interfaces and a Postgres-backed runtime.
Use npm for local development. Docker Compose is the default shape for running the
application outside the development loop, such as production-like demos, internal
showcases, and single-host deployments.

## Boundaries

- The Git repository is the source of truth for published knowledge.
- Postgres stores indexes, logs, metadata, proposals, and audit history.
- The API owns permissions, retrieval orchestration, proposal creation, and review workflow.
- The API throttles metered work: per-principal request rate limits plus a global
  cap on concurrent in-flight AI jobs. See [rate-limiting.md](./rate-limiting.md).
- The MCP server is a client surface over the API.
- Background jobs perform sync, indexing, clustering, proposal generation, and maintenance checks.

## Provider Strategy

The core packages define interfaces for:

- Chat completion
- Embeddings
- AI job execution (queue + watcher)
- Git repository sync
- Pull request creation
- Job scheduling

Concrete adapters can target local services, Docker-deployed services, Azure, GitHub, GitLab, Azure DevOps, OpenAI-compatible APIs, or other providers.

An object storage interface is planned but not yet defined in the core packages.

Azure is the preferred managed deployment option when a hosted provider is required, but it should not leak into core domain logic.

## AI Job Execution

Generative (chat) AI work is modeled as jobs on a pg-boss queue in Postgres, not as a
hard dependency on one model vendor. **The API never calls a chat model inline.** It
enqueues a job; a separate **watcher** process claims it, invokes the configured
provider, and posts the result back over HTTP. The API and watcher share only the
HTTP API and the managed-checkout volume — the watcher has no direct database
access. The shared checkout volume now also hosts *source* checkouts for
source-grounded jobs (seed planning + drafting, gap drafting, and the patrol child jobs
`verify_document` / `correct_document` / `improve_document`): the watcher resolves a
job's `SourceDescriptor[]` to read-only workspaces there and lets the agent explore
them directly, so no source-grounded job samples source files API-side. The shared
source-corpus snapshot store and its `/api/source-corpus` endpoint are gone. See
the source-agentic grounding spec
([docs/superpowers/specs/2026-07-06-source-agentic-grounding-design.md](superpowers/specs/2026-07-06-source-agentic-grounding-design.md)).
Source-grounded prompts now begin with per-source "source map" hints — lightweight topic-indexed
navigation metadata maintained by the agents themselves, stored in Postgres, and fetched through the
watcher's scoped-context API — internal to source navigation and never appearing in answer retrieval
or user-facing output.

Embeddings are the one exception to the queue model: the API computes them **inline**
(it holds an embedding provider) for both indexing and query-time retrieval, rather than
dispatching them as watcher jobs. Embedding providers are configured separately from the
chat provider (see [ai-jobs.md](ai-jobs.md)).

`AI_PROVIDER` is mandatory and selects the provider work is routed to:

- `openai-compatible` — any OpenAI-compatible `/chat/completions` endpoint.
- `azure-openai` — Azure OpenAI chat completions.
- `codex` / `claude` — an external agent CLI (Codex or Claude Code) the watcher
  shells out to.

A watcher advertises a provider's **capability** only when that provider's
credentials are present in its environment, and the API routes a job to a
capability only a running watcher actually offers. See
[ai-jobs.md](ai-jobs.md) for the job contract and capability model.

Useful jobs include:

- Answer synthesis from retrieved context.
- Knowledge gap summarization.
- Draft Markdown proposal generation.
- Contradiction analysis.
- Duplicate consolidation suggestions.

The watcher should receive a tightly scoped job payload with source context, expected output schema, and write permissions limited to posting the result. It should not get direct database access.

## Primary Flow

```text
Git Markdown repo
  -> sync repository
  -> parse Markdown and frontmatter
  -> split into sections by heading
  -> store document metadata and section text
  -> generate embeddings
  -> answer questions with citations (agentic loop over hybrid keyword + vector
     retrieval: relevance-floored, model-driven follow-up searches, used-only citations)
  -> record questions, answers, citations, confidence, feedback
  -> cluster weak answers into knowledge gaps
  -> generate Markdown proposals
  -> publish proposals to a branch and raise a pull request
  -> on merge: re-index the knowledge base, then verify closure by re-asking the
     triggering questions — resolve the gaps only if the merged doc actually
     answers them, otherwise reopen them for another draft
```

Proposal generation runs along two paths:

- **Manual (human-in-the-loop):** an operator picks a gap cluster to draft, reviews the
  generated Markdown, then publishes it as a pull request.
- **Automated (scheduled):** the `gaps-to-pull-requests` reconciler clusters open gaps, drafts
  proposals for any cluster not already covered, publishes them as pull requests, and advances
  proposals as their PRs merge or close — all in one task with no manual review step.

Every proposal carries **per-claim provenance** (#214): the draft jobs return a structured
`provenance` array (each substantive claim plus the source files that ground it) instead of
citing repository paths inline in the document body, so internal source locations never
leak into answers. The map is persisted on the proposal row (append-only event-log
semantics: a merged proposal's row is the provenance event for its target path) and
rendered for reviewers in the PR body and the console's proposal view — for local-git
flows, which have no PRs, the console is the review surface. See
[the claim-provenance spec](superpowers/specs/2026-07-08-claim-provenance-design.md).

Both paths stop at a **pull request**: automated flows open and update PRs, but the *merge*
that changes the source of truth is always a human action on the hosting provider. Because AI
flows ingest untrusted content (questions, source Markdown, diffs), this mandatory-human-review
gate is the primary control against prompt injection — see
[threat-model.md](threat-model.md) for the threat model, the controls already in place, and the
branch-protection expectations that keep the review gate enforced.

### Scheduled tasks and job types

Background tasks are registered **per flow** in the scheduler and managed from the
**Schedules** page. The model has two tiers: each scheduled task fires *exactly one*
job on its cron (tier 1), and five of those are *maintenance* jobs — four fan out into
the AI and GitHub jobs that do the real work (tier 2); the seed bootstrap enqueues its
planning job and returns without waiting on it. The job-type
identifier is also the pg-boss queue name, so the same string names the row in the
Schedules UI, the box in the dataflow diagram, and the `type=` filter in the job
queue.

| Scheduled task (UI label) | Job type (= queue name) | Cadence | Capability | Fans out into (tier 2) |
| --- | --- | --- | --- | --- |
| Gap drafting | `process_gaps_to_pull_requests` | ~10 min | maintenance | `reconcile_gap_clusters`, `draft_markdown_proposal`, then publish/fold/comment GitHub jobs |
| Source sync | `source_change_sync` | ~10 min | maintenance | `sync_source_changes_generate_plan` → proposal |
| Snapshot refresh | `refresh_flow_snapshot` | ~5 min | github | — *(leaf: writes the flow snapshot of gaps, proposals, and PR state the reconciler reads, and reports each open PR's mergeability so a **stale PR** can auto-regenerate — see below; **not scheduled for local-git flows**, which have no PRs to poll)* |
| Correctness patrol | `correctness_patrol` | hourly | maintenance | `verify_document` → `correct_document`, `dedupe_documents`, `split_document` |
| Editorial patrol | `editorial_patrol` | hourly | maintenance | `improve_document` |
| Seed bootstrap | `seed_bootstrap` | hourly | maintenance | `outline_flow_seed` for a sparse flow (enqueue-and-return — never bounded-waits; the plan waits for human review) |

One more maintenance job — `verify_gap_closure` — is **not** scheduled on a cron; it is
enqueued *on merge* (the merge cascade below) for any proposal that had triggering
questions. A maintenance watcher claims it and POSTs `/api/proposals/:id/verify-closure`,
where the API re-asks each triggering question as an `answer_question` job it bounded-waits
on (tier 2), so it fans out into AI work exactly like the scheduled orchestrators.

**Stale-PR auto-regeneration.** A published proposal's PR can go stale: `main`
advances and touches the same file, so the branch no longer merges. Because a
single-file proposal is a whole-file write, a conflict means *that exact file changed
on main* — the right fix is to regenerate the doc against the new base, not a textual
merge. Each `refresh_flow_snapshot` poll reports GitHub's `mergeable_state` per open
PR; when the API sees a proposal flip to *conflicting* it enqueues a
`draft_markdown_proposal` keyed to that proposal (`regenerateProposalId`). The drafter
re-retrieves scoped context against the fresh base; on completion the API updates the
proposal in place — keeping its id, title, target path, branch, and open PR — and
re-publishes with `regenerate: true`, which re-cuts the branch from the current base
tip and force-pushes, updating the PR. Guards keep it safe: an **approved** PR is never
rewritten, a per-proposal **retry cap** (`regenerationCount`) stops a structural
conflict from looping, and at most one regeneration is in flight per proposal. This is
GitHub-only (local-git destinations have no `mergeable_state`) and single-file only
(changeset proposals publish through a different path).

Every tier-2 producer that writes a document expresses a `ChangeIntent` and passes
through the **reconcile gate** (`open-new` / `fold` / `defer`) before a
`publish_proposal` GitHub job opens or updates the PR — so all four producing
schedules converge on one mechanism. The **Scheduled Jobs → Job Types** diagram on
the `/dataflow` page draws the full fan-out.

**Flow seeding** is plan-centric and self-seeding. Planning starts from the flow's
*sources*: `POST /api/flows/:id/outline` (one click, no topic; also the `kb_outline` MCP
tool) enqueues the source-grounded `outline_flow_seed` job, whose agent explores the
flow's source repositories and proposes a complete document plan — plus a charter/persona
proposal when the flow config lacks one (the system never writes flow config; the console
offers copy-to-config). The completion handler persists the plan in `seed_plans`, where it
waits behind a **human review gate**: edit charter/persona and items, approve or dismiss
(`/api/seed-plans/*`; the `kb_seed` MCP tool approves by plan id). Approval — the only
drafting entry point — enqueues one `draft_seed_document` per approved item carrying the
plan's run-scoped charter/persona, bypassing the demand-inference half (gap clustering +
the intent gate) since the plan supplies the intent. The resulting clusterless proposals
still converge on the same reconcile gate and `publish_proposal` path, so seeding ends at a
reviewable PR like everything else. A per-flow hourly `seed_bootstrap` maintenance task
auto-proposes a plan for any flow with sources but a near-empty KB (guards make it
self-quiescing; a dismissed plan is not re-proposed until the flow's sources change). The
console's **Seed** page drives propose → review/edit → approve. See
[`ai-jobs.md`](./ai-jobs.md) (§ Seeding a flow).

Orchestration detail: a maintenance watcher claims a `process_gaps_to_pull_requests`
job and POSTs the API's `/api/gaps/reconcile` endpoint, where the orchestration
lives. The reconciler's only generative step — the cluster reshape (propose
merge/split/**dismiss**, then critic-confirm) — is itself a provider-partitioned
`reconcile_gap_clusters` AI job the API enqueues and bounded-waits on, so no
generative work runs in the API process.

**Maintenance orchestrators need at least two watchers.** The claiming watcher blocks
inside the orchestration POST while the API bounded-waits on the tier-2 AI jobs it
enqueues, and a watcher runs one job at a time — so those tier-2 jobs can only be claimed
by a *second* watcher. On a single-watcher deployment the orchestration's inner AI jobs
never get claimed and time out. For `verify_gap_closure` this is handled safely: an
incomplete re-ask is reported as an infrastructure failure (the endpoint returns `503` and
the job retries), never recorded as a `still_open` content verdict that would wrongly
reopen a correctly-merged doc (#150). The console warns when only one watcher is connected.

**Overlap is serialized per flow, in the API.** pg-boss dedupes the reconciler
*enqueue* per cron slot (the timekeeper sends with a `singletonKey`/
`singletonSeconds`), but it does **not** serialize *execution*: because the
maintenance queues are standard-policy, a reconcile that legitimately outlasts its
~10-minute cadence (the reshape alone bounded-waits up to 5 min, then drafts per
cluster) can still be active when the next slot's job is claimed by a second
watcher. Two reconciles for the same flow would then run concurrently and double
every metered reshape + draft generation. So `reconcileGaps` takes a **Postgres
session-level advisory lock keyed on `(taskType, flowId)`** for the whole run
(`apps/api/src/scheduling/run-lock.ts`): an overlapping run for the same flow is
refused the lock and skips quietly (only the holder records a `MaintenanceRun`),
while a *different* flow still reconciles in parallel. The lock lives at the single
execution site both the cron path and the manual "Run now" path funnel through, and
being held in Postgres it serializes across API replicas, not just within one
process. As a second layer, `draftProposalsForUncoveredClusters` treats a
queued/active `draft_markdown_proposal` job for a cluster as already **covering**
it — drafting is enqueue-only, so the proposal row exists only once the draft job
completes, and without this a run whose draft is still in flight (or an overlap that
slips through) would enqueue a duplicate full generation for the same cluster.

**Phase-1 assignment is an embedding-based coarse pre-clusterer.** Before the
reshape, each unassigned gap's summary is embedded inline (embeddings are the
sanctioned inline exception to queue-only) and compared, within its flow only,
against each active cluster's stored representative embedding — the L2-normalised
centroid of the cluster's distinct member gap summaries
(`gap_clusters.representative_embedding`, migration 0046). A gap joins the nearest
cluster at or above `GAP_CLUSTER_ASSIGN_THRESHOLD` (default 0.84, set by the
offline sweep in `scripts/eval-gap-threshold.ts`); the rest form connected
components (pairwise cosine ≥ the threshold) that each seed one new cluster, so a
burst of near-identically-worded gaps lands as one bucket instead of N singletons.
Decisions are made against a tick-start snapshot of representatives (pure planner:
`apps/api/src/scheduling/gap-assignment.ts`), so assignment is order-independent
and a re-raised identical gap re-lands deterministically. The threshold is
deliberately conservative — the eval showed the worst must-not-merge pair
("encryption in transit" vs "at rest") sits at cosine 0.81 with the configured
embedding model, *above* most genuine paraphrase pairs — so phase 1 banks only
near-duplicate rewordings and leaves real paraphrase consolidation to the reshape
critic, which remains the semantic refiner. A cluster whose composition changes
(merge, split, resolved-gap pruning) has its representative nulled and lazily
recomputed from its surviving members' summaries on the next assignment pass.
With no embedding provider configured, phase 1 falls back to the original
one-cluster-per-distinct-summary behaviour; if the provider is configured but an
embed call fails, the tick fails (and retries) rather than silently fanning out
singletons.

**Fan-out containment.** Phase 1 (above) only pre-collapses near-identical
wordings, so the reshape (step 2) remains the step that must collapse genuinely
paraphrased singleton clusters, and two safeguards keep a batch of fine-grained
gaps from fanning out into one proposal each. First, the reshape's propose call is
parsed leniently (JSON mode plus the shared `extractJson`, first-`{`…last-`}`) — a
provider that wraps its proposal in a ```json fence or prose no longer has the whole
proposal silently discarded and every reshape collapsed to "no merges". Second,
`draftProposalsForUncoveredClusters` bounds NEW drafts to `MAX_DRAFTS_PER_TICK` per
flow per tick: reshape is best-effort (a timeout, failure, or under-merge leaves the
raw singletons intact), so when more uncovered clusters remain the reconciler drafts
a capped batch, warns loudly, and **holds the processed revision** so a later tick
re-enters and drains the rest — re-entry finds no new gaps and an unchanged
composition hash, so the metered reshape is skipped and only the capped drafting
repeats. Malformed gap signals never reach this stage: the synthesised
no-source-material fallback (a summary echoing the raw question) is dropped at gap
ingestion (`isSeedableGapSummary`), so a batch of unanswered questions does not each
seed its own singleton cluster.

Because the API bounded-waits on a batch of AI jobs inside these callbacks, a
maintenance orchestration request (`/api/gaps/reconcile`, `/api/source-sync/run`,
`/api/fix-patrol/run`, `/api/fix-patrol/improve/run`) legitimately stays open for
minutes — the maintenance job that drives it has a 1-hour budget and is heartbeated
throughout. The watcher's HTTP client therefore applies a dedicated, longer deadline
to these four calls (`WATCHER_MAINTENANCE_TIMEOUT_MS`, default 15 min) rather than the
short hot-path request timeout it uses for claim/heartbeat/complete/retrieve; a
too-short deadline here silently aborts the call and fails the patrol tick. To let the model judge scope, the API
attaches per-cluster grounding to that job (the flow's persona plus the best
retrieval relevance and closest snippets for the cluster's topic, via inline
retrieval against the flow's destination). A **dismissal** is how an off-topic
cluster — one unrelated to the source knowledge, e.g. a "cats" cluster in a product
flow — is dropped: the reshape job now runs whenever there is ≥1 active cluster (not
only ≥2), and a critic-confirmed dismissal moves the cluster to a terminal
`dismissed` state and stamps its member gaps dismissed, so it never drafts a proposal
and never re-clusters. Reshape is best-effort: if no chat watcher is available within
the deadline, the reconciler logs and skips it, still running clustering, drafting,
publication, and the PR-state pass. Both this reshape job and the fix-patrol verify
lens's `verify_document` job go through `runJobToCompletion`, which now closes an
orphaned-job leak: if the deadline elapses before the job reaches a terminal state,
the job is cancelled (safe even if a watcher has already claimed it — a late
`completeJob()` on a cancelled job is rejected rather than silently discarded after
paying for the generation), and a request for the same flow/document reuses an
already in-flight job instead of enqueueing a duplicate on top of it.

**Composition short-circuit (the reshape's second gate).** The per-flow catalog
revision advances on *every* gap event (each auto gap, manual flag, verification
reopen, resolve, dismiss), so the revision gate alone reopens the reshape far more
often than the active cluster set actually changes — re-running the metered
propose→critic generation just to re-conclude "no merges, splits, or dismissals". So
before enqueuing the reshape, the reconciler hashes the active cluster composition
(the sorted cluster ids, each paired with its sorted membership gap ids) and compares
it to the hash recorded at this flow's last reshape (a `last_reshape_composition_hash`
column on `gap_reconciler_state`, alongside the processed revision). An identical hash
means the critic already judged this exact set, so the reshape is skipped (recorded as
`reshapeSkipped` on the run). The hash is written **only after a completed reshape**, so
a skipped, timed-out, failed, or malformed reshape never records an unjudged set and
wedges the gate — the next tick retries. Any genuine change (a new or removed cluster,
a gap moving between clusters) changes the hash, so real work is never skipped; a
critic-confirmed merge/split/dismissal changes the set, so the next tick re-judges the
new composition once. Complementing this, `updateAnswer` no longer bumps the revision
(or deletes+reinserts the answer-derived gaps) when a re-answer's gaps are identical to
the ones it would replace — which also stops the delete+reinsert from minting new gap
ids that would orphan cluster memberships via `ON DELETE CASCADE` (issue #168).

### Merge cascade and gap-closure verification

A merge no longer *blindly* resolves the gaps a proposal set out to close. The merge
cascade (shared by the local-git **Accept** action and the PR poller) re-indexes the
destination, then — for any proposal that had triggering questions — enqueues a
`verify_gap_closure` job instead of marking the gaps resolved. When a maintenance watcher
drives that job, the API **re-asks each triggering question** through the normal
queue-only `answer_question` path (against the now-updated index) and applies a
deterministic closure test: a question is *closed* only when the re-ask returns a
confident answer (`high`/`medium`) that **cites one of the merged proposal's target
docs**. If every triggering question closes, the gaps are resolved (`closure_status =
verified_closed`); if any stays open, the gaps are **reopened** with the verification
detail as a `note` so they re-draft (`reopened`). After two failed verifications for the
same question its `verification` gap is stamped **`parkedAt`** — a first-class "awaiting a
human" state (not a source) that parks the whole question from auto-redrafting; the proposal
records `closure_status = needs_attention`. A human retries or dismisses it from the console's
Parked questions panel. Clusterless / seed proposals have no triggering questions and skip
verification entirely. See [question-logging.md](question-logging.md) for the gap sources,
the parked state, and the human workflow, and [ai-jobs.md](ai-jobs.md) for the job.

Before clustering, the reconciler also **prunes resolved gaps**: a gap is resolved by
`(question, summary)` — now only once the merge's closure verification passes (above) —
but a prior reshape may have moved that gap into a cluster other than the one the merge
freezes. So each tick deactivates the cluster membership of any gap now resolved, and
freezes any active cluster left with no still-open members — keeping "active membership"
to mean "this gap belongs to this cluster *and* is still open", so a covered gap never
re-surfaces as a cluster member or gets re-drafted. The draft and cluster-read paths also
scope to a cluster's unresolved members as defence-in-depth.

> The former whole-knowledge-base **Crunch** pass has been retired; its
> consolidate/split responsibilities now live in the patrols and the gap reconciler.

## Observability

- **Structured logging.** Both services log JSON via pino (`@magpie/logger`), each
  bound to a `service` field (`api` / `watcher`). The API's request middleware binds a
  per-request child logger; the watcher binds `jobId`/`jobType` per claimed job.
- **Crash handlers.** Each entrypoint registers process-level `uncaughtException` and
  `unhandledRejection` handlers (`installCrashHandlers` in `@magpie/logger`) at its
  composition root. A throw outside a handled path is logged **fatally** with
  structured context (service, `err`, stack) and the process exits non-zero, so the
  orchestrator's restart policy takes over — instead of a bare Node stderr trace with
  no captured context.
- **OpenTelemetry (traces + metrics + error recording).** Vendor-neutral, wired in
  `@magpie/telemetry` and **off by default** — the app emits through the lightweight OTel
  *API* (a no-op until the SDK starts). `initTelemetry` starts the SDK (OTLP trace + metric
  exporters, HTTP/undici/pg auto-instrumentation) only when `OTEL_EXPORTER_OTLP_ENDPOINT`
  is set (`MAGPIE_TELEMETRY_ENABLED=false` force-disables). Export is OTLP, which any
  backend ingests — Grafana/Tempo/Mimir, Datadog, Honeycomb, Sentry, or an OTel Collector
  that fans out (including to a Prometheus scrape endpoint), so no vendor is baked in.
- **Correlation via trace context.** With telemetry on, one **trace** threads the whole
  cross-service chain — **API request → enqueued job → watcher execution → API callback**.
  HTTP hops propagate W3C `traceparent` automatically (auto-instrumentation); the queue
  boundary is bridged manually — the broker injects the trace context onto the job envelope
  (`JobView.traceContext`) and the watcher runs the job inside a span extracted from it.
  Every log line carries `trace_id`/`span_id` (a pino mixin), so logs join traces. With
  telemetry **off** (the default) there is no cross-service correlation — only per-request
  `requestId` logging.
- **Metrics.** `magpie.jobs.finished` (counter by type/outcome) and `magpie.jobs.duration`
  (histogram) are recorded by the watcher; HTTP server latency/status metrics come from
  auto-instrumentation. All export over OTLP; there is no bespoke `/metrics` endpoint (run
  an OTel Collector with a Prometheus exporter if a scrape endpoint is wanted).
- **Error tracking.** Unhandled API 500s and job failures call `recordException`, attaching
  the error to the active span so it reaches the backend with full trace context. Fatal
  crashes are still handled by the crash handlers above.
- **Health/liveness.** The watcher exposes `/health` (is the poll loop ticking?) and
  `/ready` (does it advertise a runnable capability?) — see `apps/watcher/src/health-server.ts`.

## Implementation Status

The pipeline runs end to end, including raising pull requests on a hosted provider and
refreshing their status. `LocalGitProposalPublisher` (`provider: "local-git"`) commits a
proposal to a Git branch and pushes it; when a host token is configured the branch is also
raised as a pull request, and the `gaps-to-pull-requests` reconciler advances proposals as
their PRs are merged or closed. If no token is available, publishing degrades gracefully to a
pushed branch.

A **no-op publish** — a fresh branch create whose generated content is byte-identical to what
the base already carries, which autonomous generation can emit — is not an error. The publisher
returns the base tip flagged `noChange` instead of throwing, the watcher runner skips the PR
step, and the API settles the proposal as **superseded** (terminal, hidden from the inbox)
rather than recording a branch that was never pushed. The publication outbox action completes
normally, so it no longer retries a change that will always be a no-op.
