# Architecture

Markdown Magpie is designed around provider-neutral interfaces and a Postgres-backed runtime.
Use npm for local development. Docker Compose is the default shape for running the
application outside the development loop, such as production-like demos, internal
showcases, and single-host deployments.

> This document is the **overview** — boundaries, provider strategy, and the primary
> end-to-end flow. Subsystem detail lives in the per-subsystem product specs indexed in
> [README.md](./README.md); each section below links to the spec that owns it.

## Boundaries

- The Git repository is the source of truth for published knowledge.
- Postgres stores indexes, logs, metadata, proposals, and audit history.
- The API owns permissions, retrieval orchestration, proposal creation, and review workflow.
- The API throttles metered work: per-principal request rate limits plus a global
  cap on concurrent in-flight AI jobs. See [rate-limiting.md](./rate-limiting.md).
- The MCP server is a client surface over the API. See [mcp.md](./mcp.md).
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
HTTP API and the managed-checkout volume — the watcher has no direct database access.

Embeddings are the one exception to the queue model: the API computes them **inline**
(it holds an embedding provider) for both indexing and query-time retrieval.

`AI_PROVIDER` is mandatory and selects the provider work is routed to (`openai-compatible`,
`azure-openai`, or an external agent CLI `codex` / `claude`). A watcher advertises a
provider's **capability** only when that provider's credentials are present in its
environment, and the API routes a job to a capability only a running watcher actually
offers.

The full job contract, the capability/routing model, the interactive vs maintenance job
classes, and the job catalog are specified in **[ai-jobs.md](./ai-jobs.md)**. Source-grounded
jobs read source repositories directly from read-only workspaces on the shared checkout
volume, with agent-maintained navigation "source maps" — see **[source-sync.md](./source-sync.md)**.

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

Each stage is owned by a subsystem spec:

- **Ingestion & indexing** (sync → parse → split → store → embed) — [ingestion.md](./ingestion.md).
- **Retrieval & answering** (the agentic loop, hybrid search, flow routing, citations) —
  [retrieval.md](./retrieval.md).
- **Gaps & maintenance** (clustering, the reconciler, the patrols, gap-closure
  verification) — [gaps-and-maintenance.md](./gaps-and-maintenance.md).
- **Proposals & publishing** (draft, provenance, publish, stale-PR regeneration,
  merge/accept) — [proposals-and-publishing.md](./proposals-and-publishing.md).
- **Flows & seeding** (bootstrapping a flow's KB from its sources) —
  [flows-and-seeding.md](./flows-and-seeding.md).

Proposal generation runs along two paths — **manual** (an operator drafts, reviews, and
publishes a gap cluster) and **automated** (the `gaps-to-pull-requests` reconciler
clusters open gaps, drafts uncovered clusters, and advances proposals as their PRs merge
or close). Both paths stop at a **pull request**: automated flows open and update PRs, but
the *merge* that changes the source of truth is always a human action on the hosting
provider. Because AI flows ingest untrusted content (questions, source Markdown, diffs),
this mandatory-human-review gate is the primary control against prompt injection — see
[threat-model.md](./threat-model.md).

### Scheduled tasks and maintenance

Background tasks are registered **per flow** and managed from the **Schedules** page. The
model has two tiers: each scheduled task fires *exactly one* orchestrator job on its cron
(tier 1), and the maintenance orchestrators fan out into the AI and GitHub jobs that do
the real work (tier 2). The job-type identifier is also the pg-boss queue name, so the
same string names the Schedules row, the dataflow box, and the job-queue `type=` filter.

The reconciler, the correctness/editorial patrols, embedding-based gap clustering, the
per-flow advisory lock and short-circuits, the reconcile gate (`ChangeIntent`), and the
merge-cascade gap-closure verification are all specified in
**[gaps-and-maintenance.md](./gaps-and-maintenance.md)**; source-change sync is in
**[source-sync.md](./source-sync.md)**. The **Scheduled Jobs → Job Types** diagram on the
`/dataflow` page draws the full fan-out.

> The former whole-knowledge-base **Crunch** pass has been retired; its
> consolidate/split responsibilities now live in the patrols and the gap reconciler.

## Observability

Both services log structured JSON (pino), and — when telemetry is enabled — emit
OpenTelemetry traces and metrics over OTLP, with one trace threading the API request →
enqueued job → watcher execution → API callback chain across the queue boundary.
Telemetry is **off by default**. Logging, crash handling, tracing, metrics, error
tracking, and the health/liveness endpoints are specified in
**[observability.md](./observability.md)**.

## Implementation Status

The pipeline runs end to end, including raising pull requests on a hosted provider and
refreshing their status. `LocalGitProposalPublisher` (`provider: "local-git"`) commits a
proposal to a Git branch and pushes it; when a host token is configured the branch is also
raised as a pull request, and the `gaps-to-pull-requests` reconciler advances proposals as
their PRs are merged or closed. If no token is available, publishing degrades gracefully to a
pushed branch. A **no-op publish** — a fresh branch whose generated content is byte-identical
to the base — settles the proposal as *superseded* rather than recording an unpushed branch.
See [proposals-and-publishing.md](./proposals-and-publishing.md) for the publish path.
