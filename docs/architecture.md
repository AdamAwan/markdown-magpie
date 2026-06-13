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
  -> answer questions with citations
  -> record questions, answers, citations, confidence, feedback
  -> cluster weak answers into knowledge gaps
  -> generate Markdown proposals
  -> publish proposals to a branch
  -> raise pull requests
```

## Implementation Status

The flow above describes the target design. Today the pipeline runs end to end up to
publishing a proposal: the `PullRequestProvider` interface exists, but the only implemented
adapter is `LocalGitProposalPublisher`, which commits the proposal to a local Git branch
(`provider: "local-git"`). Opening pull requests on a hosted provider (GitHub, GitLab,
Azure DevOps) and refreshing their status are planned but not yet implemented.
