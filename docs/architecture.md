# Architecture

Markdown Magpie is designed around provider-neutral interfaces and Docker-first local deployment.

## Boundaries

- The Git repository is the source of truth for published knowledge.
- The database stores indexes, logs, metadata, proposals, and audit history.
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
- Object storage
- Job scheduling

Concrete adapters can target local Docker services, Azure, GitHub, GitLab, Azure DevOps, OpenAI-compatible APIs, or other providers.

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
  -> raise pull requests
```
