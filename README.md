# Markdown Magpie

Markdown Magpie is a Git-backed Markdown knowledge maintenance system. It indexes documentation, answers questions with citations, records weak answers, clusters repeated gaps, drafts Markdown improvements, and can publish proposed changes for review.

The project is intentionally provider-neutral: AI work is queued by the API and completed by a separate watcher using OpenAI-compatible chat, Azure OpenAI, Codex, or Claude.

> **Built with AI:** Markdown Magpie is developed primarily by AI coding agents — chiefly Claude (Claude Code) and Codex — with human direction and review. The planning notes under `docs/superpowers/` are the agent-driven specs, plans, and task reports that produced the code.

## What It Does

1. Sync or read Markdown knowledge sources.
2. Parse frontmatter and split documents into cited sections.
3. Search with keyword and optional vector retrieval.
4. Answer questions from the web UI, API, or MCP.
5. Track feedback and low-confidence answers.
6. Cluster repeated knowledge gaps.
7. Generate proposed Markdown changes.
8. Publish branches or pull requests for maintainers.

## Repository Layout

```text
apps/
  api/       HTTP API and job queue owner
  web/       Next.js review and administration console
  watcher/   Worker that claims AI jobs and calls the configured provider
  mcp/       MCP server for agent clients
packages/
  core/       Shared domain types
  auth/       Auth0 token validation helpers
  db/         Database schema and migrations
  git/        Git and pull request adapters
  jobs/       Job contracts and queue metadata
  markdown/   Markdown parsing and sectioning
  prompts/    Shared AI prompt catalog
  retrieval/  Search, embeddings, ranking, and answer orchestration
docs/          Architecture and feature documentation
knowledge-bases/  Optional local Markdown knowledge bases
```

## Requirements

- Node.js `22.12` or newer
- npm
- Docker and Docker Compose v2 for Postgres or full-stack demos

Postgres is the normal local backend. It stores application data and backs the pg-boss job queue used for AI work.

## Local Development

Install dependencies:

```bash
npm install
```

If npm 11 fails with `Exit handler never called!`, use npm 10:

```bash
npx --yes npm@10 ci
```

Create your local environment file:

```bash
cp .env.example .env
```

The defaults are set up for host-based development with Postgres on `localhost:5432`:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/markdown_magpie
STORAGE_BACKEND=postgres
AI_PROVIDER=openai-compatible
```

Set `AI_PROVIDER` to one of:

```text
openai-compatible | azure-openai | codex | claude
```

Then add the matching credentials or CLI settings in `.env`. See `.env.example` and [docs/ai-jobs.md](docs/ai-jobs.md) for the full provider model.

Start Postgres:

```bash
docker compose up -d
```

Run migrations:

```bash
npm run db:migrate
```

Start the parts you need:

```bash
npm run dev:api
npm run dev:web
npm run dev:watcher
```

Use separate shells for long-running processes. The web console runs at:

```text
http://localhost:3000
```

The API runs at:

```text
http://localhost:4000
```

The watcher is required for queued AI work such as answering, drafting proposals, publication jobs, and maintenance jobs.

## Quick Demo

Configure a knowledge flow in `.env` first. For a local Markdown folder, create a directory such as `knowledge-bases/product` and set:

```env
KNOWLEDGE_SOURCES=[{"id":"docs","name":"Product Docs","path":"knowledge-bases/product"}]
KNOWLEDGE_DESTINATIONS=[{"id":"docs","name":"Product Docs","path":"knowledge-bases/product"}]
KNOWLEDGE_FLOWS=[{"id":"docs","name":"Product Docs","sourceIds":["docs"],"destinationId":"docs"}]
```

With the API and watcher running, index the configured flow:

```bash
curl -s -X POST http://localhost:4000/api/knowledge/repositories/index \
  -H 'content-type: application/json' \
  -d '{"flowId":"docs"}'
```

Ask a question:

```bash
curl -s http://localhost:4000/api/ask \
  -H 'content-type: application/json' \
  -d '{"question":"What does this documentation cover?"}'
```

`POST /api/ask` returns `202` with a job. Wait for it to finish, then read the stored answer:

```bash
curl -s http://localhost:4000/api/jobs/<job-id>/wait
curl -s http://localhost:4000/api/questions/<question-id>
```

## Docker Compose

For a full-stack demo or small single-host deployment, run the application containers with the `app` profile:

```bash
cp .env.compose.example .env.compose
docker compose --profile app up --build -d
```

This starts:

- `api` on port `4000`
- `web` on port `3000`
- `watcher`
- `migrate`
- `postgres`

Without `--profile app`, `docker compose up` starts only Postgres for the host-based development loop.

Useful operations:

```bash
docker compose ps
docker compose logs -f api
docker compose logs -f watcher
docker compose restart api
docker compose down
```

Use `docker compose down -v` only when you want to delete the local Postgres volume.

## MCP

The MCP server lets agent clients call the indexed knowledge base through tools such as `kb_ask`, `kb_search`, and `kb_feedback`.

Build it and run the stdio server:

```bash
npm run build -w @magpie/mcp
API_BASE_URL=http://localhost:4000 node apps/mcp/dist/main.js
```

A project-scoped `.mcp.json` is included for local clients. The API and a watcher must be running before `kb_ask` can complete.

See [docs/mcp.md](docs/mcp.md) for stdio, Streamable HTTP, auth, and client setup.

## Common Commands

```bash
npm run build
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:db
```

## Documentation

- [docs/architecture.md](docs/architecture.md) - system boundaries, provider strategy, and primary flow
- [docs/api.md](docs/api.md) - HTTP API reference
- [docs/ingestion.md](docs/ingestion.md) - Markdown indexing model
- [docs/chat-providers.md](docs/chat-providers.md) - chat and embedding provider configuration
- [docs/ai-jobs.md](docs/ai-jobs.md) - queued AI jobs and watcher model
- [docs/question-logging.md](docs/question-logging.md) - feedback and gap logging
- [docs/mcp.md](docs/mcp.md) - MCP transports, tools, auth, and clients
- [docs/threat-model.md](docs/threat-model.md) - prompt-injection threat model and the mandatory-human-review control
- [docs/security-review.md](docs/security-review.md) - hosting/IT-review pack: data flows, controls, and the operator hardening checklist
- [docs/mvp.md](docs/mvp.md) - milestone roadmap

## Authentication

Authentication **fails closed**: it is required unless an operator explicitly opts out by setting `AUTH_REQUIRED=false`. An unset, blank, or misspelled value leaves auth **on**, so a misconfigured deployment is locked down rather than silently exposed. When auth is required, the API also refuses to start unless Auth0 is configured (a missing or placeholder `AUTH0_AUDIENCE` aborts startup).

When enabled, the API, web app, and both MCP transports validate Auth0-issued tokens. Configure the relevant `AUTH0_*`, `NEXT_PUBLIC_AUTH0_*`, watcher, and MCP service credentials in `.env` or `.env.compose`. For local development, run unauthenticated by explicitly setting `AUTH_REQUIRED=false`.

See `.env.example` and [docs/mcp.md](docs/mcp.md) for the current auth variables.

## Troubleshooting

- `npm install` fails with `Exit handler never called!`: run `npx --yes npm@10 ci`.
- `npm run db:migrate` cannot connect: confirm Postgres is running and `DATABASE_URL` points at it.
- Questions stay queued: start `npm run dev:watcher` and confirm its provider credentials match `AI_PROVIDER`.
- The web UI cannot call the API: check `NEXT_PUBLIC_API_BASE_URL`, `PUBLIC_API_BASE_URL`, and `http://localhost:4000/api/health`.

## License

Released under the [MIT License](LICENSE).
