# Markdown Magpie

Markdown Magpie is a vendor-neutral knowledge maintenance system for Git-backed Markdown documentation.

It answers questions with citations, records where the knowledge base is weak, proposes Markdown changes, and raises pull requests for human review.

## Product Loop

1. Sync a Git repository of Markdown docs.
2. Parse frontmatter and split documents by heading.
3. Index sections for keyword and vector retrieval.
4. Answer questions with citations to file paths, headings, and commits.
5. Log low-confidence answers and user feedback.
6. Cluster repeated gaps.
7. Generate proposed Markdown additions or edits.
8. Open pull requests for maintainers to review.

## Documentation

- [docs/architecture.md](docs/architecture.md) — boundaries, provider strategy, and the primary flow.
- [docs/api.md](docs/api.md) — full HTTP API reference.
- [docs/ingestion.md](docs/ingestion.md) — how Markdown repositories are indexed.
- [docs/chat-providers.md](docs/chat-providers.md) — answer-synthesis providers and configuration.
- [docs/ai-jobs.md](docs/ai-jobs.md) — the queueable AI job contract and watcher model.
- [docs/question-logging.md](docs/question-logging.md) — recorded question fields and the gap loop.
- [docs/mvp.md](docs/mvp.md) — milestone roadmap.

## Repository Layout

```text
apps/
  api/   Core HTTP API and background worker host
  mcp/   MCP server for Codex, Claude, and other agent clients
  watcher/ Local AI job watcher for Codex, Claude Code, or other agent CLIs
  web/   Review and administration UI
packages/
  core/       Shared domain types and provider interfaces
  db/         Database schema and migrations
  git/        Git repository and pull request adapters
  jobs/       Scheduled and queued maintenance jobs
  markdown/   Markdown parsing, frontmatter, and section chunking
  retrieval/  Search, ranking, embeddings, and cited answer orchestration
infra/
  docker-compose.yml-friendly deployment docs
  azure/ optional managed deployment notes
```

## Local Development

Use npm for day-to-day development. Docker Compose is for running the application outside the development loop, such as production-like demos, internal showcases, and single-host deployments.

Postgres is the primary storage backend. The in-memory stores still exist as a compatibility fallback, but local development should use `STORAGE_BACKEND=postgres`.

### 1. Install Dependencies

```bash
npm install
```

Use npm 10 if npm 11 fails with `Exit handler never called!` or leaves empty package directories in `node_modules`:

```bash
npx --yes npm@10 ci
```

### 2. Configure Environment

Create the local environment file once:

```bash
cp .env.example .env
```

The npm dev tooling loads `.env` for the API, watcher, and migration commands. Next.js also reads local environment files for the web app. In normal local development, edit `.env` and then use the npm scripts below.

The default `.env.example` points at:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/markdown_magpie
STORAGE_BACKEND=postgres
AI_EXECUTION_MODE=direct
AI_PROVIDER=mock
```

### 3. Prepare Postgres and Redis

The inner dev loop runs the app processes **on your host** with `npm`, while the
external dependencies run in containers. The Compose file gates every app service
behind the `app` profile, so a bare `up` starts only the dependencies:

```bash
docker compose up -d        # postgres + redis only, published on localhost
```

This is the recommended way to satisfy `DATABASE_URL` for local development
(Postgres also backs the AI job queue, so it covers `AI_EXECUTION_MODE=queue`
too; Redis comes up alongside it for future Redis-backed adapters). Ports `5432`
and `6379` are published, which is why `.env.example` points at `localhost`. (If
you prefer, provision Postgres any other way you like — Compose is just the
convenient option.)

With Postgres reachable at `DATABASE_URL`, run migrations from the host:

```bash
npm run db:migrate
```

Run migrations before starting the API whenever the database is new or migrations have changed.

> **Two modes, one Compose file.** `docker compose up` brings up just the
> dependencies for this host-based dev loop. Adding `--profile app` runs the
> entire stack in containers instead — see
> [Production Showcase with Docker Compose](#production-showcase-with-docker-compose).

### 4. Run Only the Components You Need

For API work:

```bash
npm run dev:api
```

For web UI work, run the API and web app in separate shells:

```bash
npm run dev:api
npm run dev:web
```

Open:

```text
http://localhost:3000
```

For queued AI job work, run the API in queue mode and start a watcher in another shell:

```bash
AI_EXECUTION_MODE=queue AI_PROVIDER=mock npm run dev:api
AI_PROVIDER=mock npm run dev:watcher
```

For MCP work, build first and run the MCP server from an MCP client:

```bash
npm run build -w @magpie/mcp
API_BASE_URL=http://localhost:4000 node apps/mcp/dist/main.js
```

The root `npm run dev` starts every workspace dev script that exists. Prefer the targeted scripts above unless you intentionally need every component.

### 5. Seed and Exercise the App

With the API running, index the bundled cats knowledge base:

```bash
curl -s -X POST http://localhost:4000/api/knowledge/repositories/index \
  -H 'content-type: application/json' \
  -d '{"repositoryId":"cats"}'
```

Search indexed Markdown sections:

```bash
curl -s 'http://localhost:4000/api/knowledge/search?q=claws'
```

Ask a question:

```bash
curl -s http://localhost:4000/api/ask \
  -H 'content-type: application/json' \
  -d '{"question":"How should I introduce a new cat food?"}'
```

Inspect logged questions and gap candidates:

```bash
curl -s http://localhost:4000/api/questions
curl -s http://localhost:4000/api/gaps/candidates
```

The PowerShell cats demo starts the API in queued mode, starts the watcher, starts the web console, indexes `knowledge-bases/cats`, and writes logs under `tmp/`:

```powershell
.\scripts\run-cat-demo.ps1 -Provider mock -StopExisting
```

### Troubleshooting

- If `npm install` fails with `Exit handler never called!`, use `npx --yes npm@10 ci`.
- If `npm run db:migrate` cannot connect, verify `DATABASE_URL` in `.env` and confirm Postgres is running.
- If a managed shell reports `listen EPERM` on ports `3000` or `4000`, run the dev command in a normal host shell or approve port binding for that command.

## Default Deployment

The default non-development deployment target is Docker Compose:

- API container
- Web container
- MCP container
- Postgres with `pgvector`
- Redis-compatible queue, if needed by the selected job adapter
- Local object storage, if raw document snapshots are enabled

Managed cloud services are optional adapters. Azure is the preferred managed path when a concrete provider is needed, but the product should remain portable.

## Production Showcase with Docker Compose

This repository includes a production-oriented Docker setup that is intended for demos, internal showcases, and small single-host deployments. Do not use this as the inner development loop; use the npm workflow above for code changes.

The Compose deployment uses **one shared Markdown Magpie application image** and runs separate containers from that image:

- `api`: HTTP API on port `4000`
- `web`: Next.js web console on port `3000`
- `watcher`: background AI job worker
- `mcp`: optional stdio MCP server process, enabled with the `mcp` Compose profile
- `migrate`: one-shot database migration job
- `postgres`: Postgres 16 with `pgvector`
- `redis`: Redis 7, available for future Redis-backed adapters

The app services (`api`, `web`, `watcher`, `migrate`) are gated behind the `app`
Compose profile; `postgres` and `redis` have no profile and so are always
started. This is what lets the same file serve two modes: a bare
`docker compose up` brings up only the dependencies (for the host-based dev loop
in [Local Development](#local-development)), while `docker compose --profile app up`
runs the full stack described here.

Postgres and Redis use their own upstream images. The Markdown Magpie code is built once into `markdown-magpie:latest`, then Compose starts each app process with a different command. This keeps deployment simple while preserving the right runtime shape: one container per long-running process.

### Prerequisites

Install these on the host where you want to run the showcase:

- Docker Engine
- Docker Compose v2
- Git

Check that Docker is available:

```bash
docker --version
docker compose version
```

Clone the repository on the host:

```bash
git clone <your-repo-url> markdown-magpie
cd markdown-magpie
```

### 1. Configure the Compose Environment

The Compose file always loads `.env.compose.example`. For a quick showcase, you can use it as-is.

Create `.env.compose` only when you need private overrides or secrets. Compose loads it on top of `.env.compose.example`:

```bash
cp .env.compose.example .env.compose
```

For a local or single-host showcase, the defaults are enough.

For a remote host or VPS, keep the container-internal URLs as service names:

```env
DATABASE_URL=postgres://postgres:postgres@postgres:5432/markdown_magpie
API_BASE_URL=http://api:4000
QUEUE_URL=redis://redis:6379
```

The web UI uses `NEXT_PUBLIC_API_BASE_URL` or `PUBLIC_API_BASE_URL` exactly as configured, trimming only trailing slashes. If neither is set, browser API calls stay on the same origin as the web app.

For example, if you open:

```text
http://203.0.113.10:3000
```

and your API is exposed separately on port `4000`, set the browser-facing API URL in `.env.compose`:

```env
PUBLIC_API_BASE_URL=http://203.0.113.10:4000
NEXT_PUBLIC_API_BASE_URL=http://203.0.113.10:4000
```

The browser will then call:

```text
http://203.0.113.10:4000
```

If you later put the app behind a reverse proxy or a custom domain, set `NEXT_PUBLIC_API_BASE_URL` or `PUBLIC_API_BASE_URL` in `.env.compose` to that exact public API URL.

### 2. Choose the AI Mode

The easiest showcase mode is queue execution with the deterministic mock provider:

```env
AI_EXECUTION_MODE=queue
AI_PROVIDER=mock
```

This requires no external keys. The watcher will claim queued jobs and return deterministic demo answers/proposals.

To use an OpenAI-compatible API from the watcher, edit `.env.compose`:

```env
AI_EXECUTION_MODE=queue
AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_API_KEY=your-key
OPENAI_COMPATIBLE_MODEL=gpt-4.1-mini
```

Any OpenAI-compatible `/chat/completions` endpoint can be used.

To make the API answer directly instead of queueing work for the watcher:

```env
AI_EXECUTION_MODE=direct
AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_API_KEY=your-key
OPENAI_COMPATIBLE_MODEL=gpt-4.1-mini
```

For Azure OpenAI direct mode:

```env
AI_EXECUTION_MODE=direct
AI_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_CHAT_DEPLOYMENT=your-chat-deployment
AZURE_OPENAI_API_VERSION=2024-10-21
```

When multiple providers are configured in the environment, switch between valid direct and queue combinations from the web console's **Config** page without restarting the API. Storage remains a startup setting.

### 3. Build and Start Everything

Run the full stack with the `app` profile:

```bash
docker compose --profile app up --build -d
```

The `--profile app` flag is what starts the application containers; without it,
`docker compose up` brings up only Postgres and Redis (the dependencies-only mode
used for [local development](#local-development)).

The first boot will:

1. Build `markdown-magpie:latest`.
2. Start Postgres and Redis.
3. Wait for Postgres to become healthy.
4. Run `npm run db:migrate` in the one-shot `migrate` container.
5. Start the API, web UI, and watcher containers.

Check service status:

```bash
docker compose ps
```

You should see `api`, `web`, `watcher`, `postgres`, and `redis` running. The `migrate` service should show as exited successfully.

The MCP server is a stdio process intended to be launched by an MCP client, so it is not started by default. It depends on the `api` service, so activate the `app` profile alongside `mcp` (or have the stack already running from the step above):

```bash
docker compose --profile app --profile mcp run --rm mcp
```

#### Connecting an agent client (Claude Code, Codex, etc.)

The MCP server speaks the standard MCP **stdio transport** (newline-delimited JSON-RPC) and proxies to the API at `API_BASE_URL` (default `http://localhost:4000`). It exposes two tools:

- `kb.ask` — ask a question and get back a cited answer (`{ answer, confidence, citations }`). When the API runs in `queue` execution mode, the server waits for the background job to finish and returns the final answer; internal job, queue, and retrieval-context details are never exposed to the client.
- `kb.search` — keyword search over indexed Markdown sections.

To connect Claude Code, build once (`npm run build`) and add a project-scoped `.mcp.json` at the repo root (already included in this repository):

```json
{
  "mcpServers": {
    "markdown-magpie": {
      "command": "node",
      "args": ["apps/mcp/dist/main.js"],
      "env": { "API_BASE_URL": "http://localhost:4000" }
    }
  }
}
```

The API must be running and reachable at `API_BASE_URL`. In `queue` mode a watcher must also be running to process answer jobs. The wait behaviour is tunable via `ANSWER_POLL_INTERVAL_MS` (default `1000`) and `ANSWER_TIMEOUT_MS` (default `120000`).

See [docs/mcp.md](docs/mcp.md) for details.

### 4. Open the Showcase

Open the web console:

```text
http://localhost:3000
```

On a remote host, use the host IP or domain:

```text
http://your-host:3000
```

Each console section is a real route — `/ask`, `/knowledge`, `/gaps`, `/jobs`,
`/proposals`, `/crunch`, `/dataflow`, and `/config` — so links are shareable and a
page refresh keeps you on the section you were viewing. The root `/` redirects to
`/ask`.

The API health endpoint is:

```text
http://localhost:4000/api/health
```

Expected response:

```json
{"ok":true,"service":"markdown-magpie-api"}
```

### 5. Add Demo Knowledge

The web console's **Knowledge** section lists every configured flow. Select one and click **Index KB** to index its destination knowledge base — the corpus that `/ask` and the MCP tools answer from.

You can also index a flow through the API:

```bash
curl -s -X POST http://localhost:4000/api/knowledge/repositories/index \
  -H 'content-type: application/json' \
  -d '{"repositoryId":"cats"}'
```

Then ask:

```bash
curl -s http://localhost:4000/api/ask \
  -H 'content-type: application/json' \
  -d '{"question":"What cat warning signs are urgent?"}'
```

In queue mode, the API returns a job first. The watcher should complete it shortly. Refresh the web UI or inspect jobs:

```bash
curl -s http://localhost:4000/api/ai-jobs
curl -s http://localhost:4000/api/questions
```

### 6. Create a Proposal Demo

A useful showcase flow is:

1. Upload a small Markdown knowledge base.
2. Ask a question that is only partially covered.
3. Mark the answer as unhelpful in the web UI.
4. Open **Gaps**.
5. Draft a proposal from the gap.
6. Open **Jobs** and wait for the watcher to complete the proposal job.
7. Open **Proposals** and review the generated Markdown.

With `AI_PROVIDER=mock`, the generated proposal is deterministic. With `AI_PROVIDER=openai-compatible`, the watcher asks the configured model to return structured JSON and stores the resulting Markdown proposal.

### Operations

View logs:

```bash
docker compose logs -f api
docker compose logs -f web
docker compose logs -f watcher
docker compose logs -f migrate
```

Restart one service:

```bash
docker compose restart api
```

Rebuild after code changes:

```bash
docker compose --profile app up --build -d
```

Run migrations manually:

```bash
docker compose run --rm migrate
```

Stop the stack:

```bash
docker compose down
```

Stop the stack and delete the Postgres data volume:

```bash
docker compose down -v
```

Only use `down -v` when you are comfortable deleting the showcase database.

### Persistence

Postgres data is stored in the named Docker volume:

```text
postgres-data
```

The default `.env.compose.example` uses Postgres-backed stores:

```env
STORAGE_BACKEND=postgres
```

That means uploaded Markdown, questions, jobs, and proposals survive container restarts. They do not survive `docker compose down -v`.

### Ports and Firewall

For a local demo, no firewall changes are usually needed.

For a remote showcase, open:

- TCP `3000` for the web UI
- TCP `4000` for the API

Do not expose Postgres (`5432`) or Redis (`6379`) publicly. The current Compose file maps them to host ports for operator convenience. For a public server, restrict those ports with your host firewall, or remove the `ports` entries for `postgres` and `redis` and keep them available only on the Compose network.

### Reverse Proxy Notes

For a polished public demo, put a reverse proxy such as Caddy, Nginx, Traefik, or a cloud load balancer in front of the app.

One simple shape is:

```text
https://magpie.example.com        -> web:3000
https://magpie-api.example.com    -> api:4000
```

In that setup, add the public API URL to `.env.compose`:

```env
NEXT_PUBLIC_API_BASE_URL=https://magpie-api.example.com
```

Then start Compose again:

```bash
docker compose --profile app up -d
```

### Troubleshooting

If the API is offline in the UI, check:

```bash
docker compose logs api
curl -s http://localhost:4000/api/health
```

If migrations fail, check:

```bash
docker compose logs migrate
```

Common causes are an invalid `DATABASE_URL`, Postgres not being ready, or an old partially initialized database. For a disposable showcase database, reset with:

```bash
docker compose down -v
docker compose --profile app up --build -d
```

If queued questions never complete, check the watcher:

```bash
docker compose logs -f watcher
```

For OpenAI-compatible mode, verify:

```env
AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=...
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=...
```

If the web UI loads but cannot call the API from a remote machine, check that port `4000` is reachable from your browser:

```text
http://your-host:4000/api/health
```

If that URL works but the UI still fails, set `NEXT_PUBLIC_API_BASE_URL` to the exact public API URL in `.env.compose` and restart the web container:

```bash
docker compose restart web
```

## AI Execution

Markdown Magpie treats AI work as provider-neutral jobs.

There are two intended execution modes:

- `direct`: the API calls a configured model provider directly, such as Azure OpenAI, OpenAI-compatible APIs, Anthropic, or local model gateways.
- `queue`: the API enqueues AI jobs and an external watcher claims them. This lets users run Codex, Claude Code, or another local agent as the model provider.

`mock` is a provider, not an execution mode. It gives deterministic local responses for development and tests and can be selected in either direct or queue mode.

Watcher mode lowers the barrier to entry because early users can develop and test workflows with the agent tooling they already run locally, without provisioning cloud model credentials.

### AI prompts

All AI/agent prompts live in the `@magpie/prompts` package (`packages/prompts`) as a single catalog of `PromptDefinition` entries. The watcher (queue mode) wraps an instruction with the serialised job input via `buildJobPrompt`; the API and retrieval (direct mode) pass the same instruction text as the chat `system` message. The catalog is served read-only at `GET /api/prompts` and rendered in the console's **Prompts** section, so the exact instruction text sent to the model is always inspectable without reading the source.

## MVP Milestone

The first milestone is an end-to-end loop against one Markdown Git repository:

1. Configure a repository URL or local path.
2. Sync and index Markdown documents.
3. Ask a question from the web UI or MCP.
4. Receive a cited answer.
5. Mark weak answers as unhelpful.
6. Cluster repeated gaps.
7. Generate a proposed Markdown change.
8. Raise a pull request.
