# Architecture

Markdown Magpie is designed around provider-neutral interfaces and a Postgres-backed runtime.
Use npm for local development. Docker Compose is the default shape for running the
application outside the development loop, such as production-like demos, internal
showcases, and single-host deployments.

## Boundaries

- The Git repository is the source of truth for published knowledge.
- Postgres stores indexes, logs, metadata, proposals, and audit history.
- The API owns permissions, retrieval orchestration, proposal creation, and review workflow.
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
  -> on merge: resolve the closed gaps and re-index the knowledge base
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

Every tier-2 producer that writes a document expresses a `ChangeIntent` and passes
through the **reconcile gate** (`open-new` / `fold` / `defer`) before a
`publish_proposal` GitHub job opens or updates the PR — so all four producing
schedules converge on one mechanism. The **Scheduled Jobs → Job Types** diagram on
the `/dataflow` page draws the full fan-out.

Orchestration detail: a maintenance watcher claims a `process_gaps_to_pull_requests`
job and POSTs the API's `/api/gaps/reconcile` endpoint, where the orchestration
lives. The reconciler's only generative step — the cluster reshape (propose
merge/split, then critic-confirm) — is itself a provider-partitioned
`reconcile_gap_clusters` AI job the API enqueues and bounded-waits on, so no
generative work runs in the API process. Reshape is best-effort: if no chat watcher
is available within the deadline, the reconciler logs and skips it, still running
clustering, drafting, publication, and the PR-state pass.

Before clustering, the reconciler also **prunes resolved gaps**: a gap is resolved by
`(question, summary)` when its proposal merges, but a prior reshape may have moved that
gap into a cluster other than the one the merge freezes. So each tick deactivates the
cluster membership of any gap now resolved, and freezes any active cluster left with no
still-open members — keeping "active membership" to mean "this gap belongs to this
cluster *and* is still open", so a covered gap never re-surfaces as a cluster member or
gets re-drafted. The draft and cluster-read paths also scope to a cluster's unresolved
members as defence-in-depth.

> The former whole-knowledge-base **Crunch** pass has been retired; its
> consolidate/split responsibilities now live in the patrols and the gap reconciler.

## Implementation Status

The pipeline runs end to end, including raising pull requests on a hosted provider and
refreshing their status. `LocalGitProposalPublisher` (`provider: "local-git"`) commits a
proposal to a Git branch and pushes it; when a host token is configured the branch is also
raised as a pull request, and the `gaps-to-pull-requests` reconciler advances proposals as
their PRs are merged or closed. If no token is available, publishing degrades gracefully to a
pushed branch.
