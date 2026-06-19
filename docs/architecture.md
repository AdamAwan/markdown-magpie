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
- AI work execution
- Git repository sync
- Pull request creation
- Job scheduling

Concrete adapters can target local services, Docker-deployed services, Azure, GitHub, GitLab, Azure DevOps, OpenAI-compatible APIs, or other providers.

An object storage interface is planned but not yet defined in the core packages.

Azure is the preferred managed deployment option when a hosted provider is required, but it should not leak into core domain logic.

## AI Execution Modes

AI work is modeled as jobs, not as a hard dependency on one model vendor.

### Direct Provider

The API calls a configured provider synchronously or through an internal queue.

Examples:

- Azure OpenAI
- OpenAI-compatible APIs
- Anthropic
- Local model gateways
- Mock provider

### External Agent Watcher

The API writes AI jobs to the database. A user runs a watcher process locally or in a container. The watcher claims pending jobs, invokes an external agent, and posts results back to the API.

This lets Codex, Claude Code, or another CLI-based agent act as an AI provider.

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
