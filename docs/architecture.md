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
access.

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

Both paths stop at a **pull request**: automated flows open and update PRs, but the *merge*
that changes the source of truth is always a human action on the hosting provider. Because AI
flows ingest untrusted content (questions, source Markdown, diffs), this mandatory-human-review
gate is the primary control against prompt injection — see
[threat-model.md](threat-model.md) for the threat model, the controls already in place, and the
branch-protection expectations that keep the review gate enforced.

### Scheduled tasks and job types

Background tasks are registered **per flow** in the scheduler and managed from the
**Schedules** page. The model has two tiers: each scheduled task fires *exactly one*
job on its cron (tier 1), and four of those are *maintenance orchestrators* that fan
out into the AI and GitHub jobs that do the real work (tier 2). The job-type
identifier is also the pg-boss queue name, so the same string names the row in the
Schedules UI, the box in the dataflow diagram, and the `type=` filter in the job
queue.

| Scheduled task (UI label) | Job type (= queue name) | Cadence | Capability | Fans out into (tier 2) |
| --- | --- | --- | --- | --- |
| Gap drafting | `process_gaps_to_pull_requests` | ~10 min | maintenance | `reconcile_gap_clusters`, `draft_markdown_proposal`, then publish/fold/comment GitHub jobs |
| Source sync | `source_change_sync` | ~10 min | maintenance | `sync_source_changes_generate_plan` → proposal |
| Snapshot refresh | `refresh_flow_snapshot` | ~5 min | github | — *(leaf: writes the flow snapshot of gaps, proposals, and PR state the reconciler reads)* |
| Correctness patrol | `correctness_patrol` | hourly | maintenance | `verify_document` → `correct_document`, `dedupe_documents`, `split_document` |
| Editorial patrol | `editorial_patrol` | hourly | maintenance | `improve_document` |

One more maintenance job — `verify_gap_closure` — is **not** scheduled on a cron; it is
enqueued *on merge* (the merge cascade below) for any proposal that had triggering
questions. A maintenance watcher claims it and POSTs `/api/proposals/:id/verify-closure`,
where the API re-asks each triggering question as an `answer_question` job it bounded-waits
on (tier 2), so it fans out into AI work exactly like the scheduled orchestrators.

Every tier-2 producer that writes a document expresses a `ChangeIntent` and passes
through the **reconcile gate** (`open-new` / `fold` / `defer`) before a
`publish_proposal` GitHub job opens or updates the PR — so all four producing
schedules converge on one mechanism. The **Scheduled Jobs → Job Types** diagram on
the `/dataflow` page draws the full fan-out.

Not every producer is scheduled. **Flow seeding** is an on-demand producer:
`POST /api/flows/:id/seed` (and the `kb_seed` MCP tool) enqueue a `draft_seed_document`
AI job per requested doc, bypassing the demand-inference half (gap clustering + the
intent gate) since the caller supplies the intent. The resulting clusterless proposals
still converge on the same reconcile gate and `publish_proposal` path, so seeding a new
flow — or adding a new area to an existing one — ends at a reviewable PR like everything
else. The item list can be authored by hand or proposed by the `outline_flow_seed` AI job
(`POST /api/flows/:id/outline`), which is grounded in the flow's existing docs via inline
retrieval and only *proposes* — its `SeedItem[]` output feeds the seed endpoint after a human
edits it. The console's **Seed / add an area** page drives topic → outline → edit → seed. See
[`ai-jobs.md`](./ai-jobs.md) (§ Seeding a flow).

Orchestration detail: a maintenance watcher claims a `process_gaps_to_pull_requests`
job and POSTs the API's `/api/gaps/reconcile` endpoint, where the orchestration
lives. The reconciler's only generative step — the cluster reshape (propose
merge/split/**dismiss**, then critic-confirm) — is itself a provider-partitioned
`reconcile_gap_clusters` AI job the API enqueues and bounded-waits on, so no
generative work runs in the API process.

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

### Merge cascade and gap-closure verification

A merge no longer *blindly* resolves the gaps a proposal set out to close. The merge
cascade (shared by the local-git Merge action and the PR poller) re-indexes the
destination, then — for any proposal that had triggering questions — enqueues a
`verify_gap_closure` job instead of marking the gaps resolved. When a maintenance watcher
drives that job, the API **re-asks each triggering question** through the normal
queue-only `answer_question` path (against the now-updated index) and applies a
deterministic closure test: a question is *closed* only when the re-ask returns a
confident answer (`high`/`medium`) that **cites one of the merged proposal's target
docs**. If every triggering question closes, the gaps are resolved (`closure_status =
verified_closed`); if any stays open, the gaps are **reopened** with the verification
detail as a `note` so they re-draft (`reopened`). After two failed verifications for the
same question its gap is filed under the `needs_attention` source, which parks the whole
question from auto-redrafting (`needs_attention`) so a human can look. Clusterless / seed
proposals have no triggering questions and skip verification entirely. See
[question-logging.md](question-logging.md) for the gap sources and
[ai-jobs.md](ai-jobs.md) for the job.

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
