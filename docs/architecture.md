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

All AI work is modeled as jobs on a pg-boss queue in Postgres, not as a hard
dependency on one model vendor. **The API never calls a model inline.** It
enqueues a job; a separate **watcher** process claims it, invokes the configured
provider, and posts the result back over HTTP. The API and watcher share only the
HTTP API and the managed-checkout volume — the watcher has no direct database
access.

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
  -> answer questions with citations (hybrid keyword + vector retrieval)
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

Background tasks registered in the scheduler (configured from the Crunch page):

- `gaps-to-pull-requests` — the single gap reconciler: it gates model work on the gap-catalog
  revision, applies critic-confirmed cluster merges/splits, publishes open proposals through an
  idempotent outbox, and (folding in the former `pull-request-refresh` task) checks open pull
  requests — resolving the gaps a merged PR closed and re-indexing, or marking a closed PR's
  proposal rejected (default: every 10 minutes; requires `GITHUB_TOKEN` for PR operations).
  This runs as a `process_gaps_to_pull_requests` maintenance job: a watcher POSTs
  the API's `/api/gaps/reconcile` endpoint, where the orchestration lives. The reconciler's only
  generative step — the cluster reshape (propose merge/split, then critic-confirm) — is itself a
  provider-partitioned `reconcile_gap_clusters` AI job the API enqueues and bounded-waits on, so
  no generative work runs in the API process. Reshape is best-effort: if no chat watcher is
  available within the deadline, the reconciler logs and skips it, still running clustering,
  drafting, publication, and the PR-state pass.
- `source-change-sync` — watches each flow's git sources and rewrites knowledge-base documents
  a source change has outdated (default: every 10 minutes).

**Crunch** is a separate knowledge-base tidying flow (scheduled or on-demand) that builds a
plan of consolidation/clean-up operations over a destination's documents; an operator then
reviews the plan and publishes it as a branch.

## Implementation Status

The pipeline runs end to end, including raising pull requests on a hosted provider and
refreshing their status. `LocalGitProposalPublisher` (`provider: "local-git"`) commits a
proposal to a Git branch and pushes it; when a host token is configured the branch is also
raised as a pull request, and the `gaps-to-pull-requests` reconciler advances proposals as
their PRs are merged or closed. If no token is available, publishing degrades gracefully to a
pushed branch.
