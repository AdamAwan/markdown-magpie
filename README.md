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

## Feature Timeline

Dates are when the work landed on `main`. Design notes for each item live in
`docs/superpowers/specs/`.

### June 2026 - foundations

| Date | What landed |
| --- | --- |
| Jun 12 | Initial scaffold: npm-workspace monorepo, local Markdown ingestion, Postgres-backed AI job queue and watcher contract, configurable chat providers, question logging with gap candidates, and the first console + proposal workflow. |
| Jun 13 | Hybrid retrieval - pgvector nearest-neighbour fused with keyword ranking via RRF, HNSW index, `[0,1]` relevance scale. Publish ready proposals to Git branches. Manual knowledge-gap flagging with the `kb.feedback` MCP tool. |
| Jun 14 | Knowledge bases configured from the environment; Mermaid data-flow diagrams in the console. |
| Jun 15 | Git repository integration; API endpoints moved under `/api`. |
| Jun 16 | Gap clustering into a single proposal; Crunch (cron-scheduled knowledge-base tidying); PR raise plus resolve-gaps-and-reindex on merge; reset-data endpoint and button; API decomposed into services behind an `AppContext`. |
| Jun 17 | API rebuilt on Hono with zod request validation; MCP Streamable HTTP transport; `app` Compose profile; shared prompt catalog. |
| Jun 18 | Auth0 across the API, web app, and both MCP transports, gated by scope. Source-change sync: watch sources and correct the knowledge base. |
| Jun 19 | Per-flow snapshots feeding the reconciler; MCP connect page and runtime service-token refresh. |
| Jun 20-21 | Jobs backed by pg-boss; product schedules reconciled into pg-boss and the timer schedulers dropped. |
| Jun 22 | **Queue-only AI** - the generative chat provider is removed from the API; source-sync planning and publication become queued jobs. |
| Jun 23 | Maintenance vocabulary: `ChangeIntent` + `MaintenanceLens`, and a lens-agnostic reconciliation gate. |
| Jun 24 | The `fix_patrol` job, patrol store, and per-flow scheduling; the **verify** lens; source-sync changesets deferred when they overlap an open PR. |
| Jun 25 | The **dedupe** lens. |
| Jun 26 | The **split** lens and improve-patrol editorial expansion; `MaintenanceRun` replaces `PatrolRun`. |
| Jun 28 | Source-sync plans become first-class proposals through the same gate. |
| Jun 30 | Operational spine: structured logging, request-validation standardization, and API/watcher startup config validation. |

### July 2026 - depth, cost control, and questionnaires

| Date | What landed |
| --- | --- |
| Jul 1 | Per-principal rate limiting and AI cost controls. |
| Jul 2 | OpenTelemetry traces and metrics (`@magpie/telemetry`); RFC 8693 token exchange so MCP can call the API on behalf of the end user; `/admin/reset` gated behind an admin capability. |
| Jul 3 | Local-git destinations - publish `file://` branches and merge from the console. Flow seeding: `draft_seed_document`, outline generation, and the `kb_seed` / `kb_outline` MCP tools. |
| Jul 4 | Verify-closure endpoint: a gap only resolves on re-ask evidence. |
| Jul 6 | First-class local-git flow mode (Accept/Bin, no GitHub ceremony); stale-PR detection with auto-regeneration against a fresh base; the branching question-journey Sankey plus job-error, KB-freshness, and patrol-impact insights. |
| Jul 7 | Embedding-based gap bucketing with lazy centroid maintenance; patrol grounded in source descriptors instead of a sampler. |
| Jul 9 | **Claim provenance** end to end - structured claims on drafts, rendered into PR bodies, folded across rewrites, and checked first by the verify lens. Seed plans become source-grounded and reviewable. |
| Jul 10 | `seed_bootstrap` auto-proposes plans for sparse flows. |
| Jul 14 | The `kb_citation` MCP tool and full-section resolution endpoint; per-job provider token usage captured and charted. |
| Jul 15 | Operator-supplied `AI_PRICING` table; token usage priced into cost on Insights, per flow and per schedule. |
| Jul 16 | **Questionnaire mode** - questionnaire tables, matching, two-condition answer reuse, drip answering, export, a web console section, and MCP tools. Local-git proposals can be rejected before publishing. |
| Jul 17 | Questionnaire trust: confidence snapshots, top-N matching with reconciliation reuse, and verdict mapping. Security wave - fail-closed per-flow authorization, per-tool scope on MCP JSON-RPC batches, protocol-allowlisted clone URLs, untrusted-content delimiters. |
| Jul 18 | Reliability wave: durable replay-safe post-merge cascade, atomic AI admission control, a per-tick maintenance budget, `answer_question_batch`, and a terminal-fail backstop with repair reprompts. Secret redaction in logs, a minimal env allowlist for spawned agent CLIs, and `npm run verify` as the pre-push gate. |
| Jul 19 | Per-repository PAT overrides resolved through a `tokenEnv` reference. |
| Jul 20-21 | Documentation reworked into clause-numbered living product specs, plus a guide to consuming Magpie from another app. |
| Jul 25 | Citation usage tracking - how often each section is actually cited by an answer, surfaced on the Knowledge page. |
| Jul 31 | Per-questionnaire answering direction; detection and surfacing of disagreements between sources. |

### August 2026

| Date | What landed |
| --- | --- |
| Aug 11 | Completed questionnaires ingested as **evidence** rather than as answers; questionnaire file upload with a confirmed column mapping; keyword-only retrieval promoted to a usable first-class mode, so embeddings are optional. |

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
npm run format        # auto-format with Prettier
npm run format:check
npm run typecheck
npm test
npm run test:db
```

Formatting is enforced automatically. A Prettier `format:check` runs in CI
(the Verify workflow), and a husky pre-commit hook runs `lint-staged` to
auto-format staged files on every commit — the hook is installed by the
`prepare` script on `npm install`. To enable blame filtering for the one-time
bulk-format commit, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`
(GitHub applies it automatically).

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
