# Markdown Magpie

Markdown Magpie is a Docker-first, vendor-neutral knowledge maintenance system for Git-backed Markdown documentation.

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
  docker-compose.yml-friendly local deployment docs
  azure/ optional managed deployment notes
```

## Default Deployment

The default target is Docker Compose:

- API container
- Web container
- MCP container
- Postgres with `pgvector`
- Redis-compatible queue, if needed by the selected job adapter
- Local object storage, if raw document snapshots are enabled

Managed cloud services are optional adapters. Azure is the preferred managed path when a concrete provider is needed, but the product should remain portable.

## Production Showcase with Docker Compose

This repository includes a production-oriented Docker setup that is intended for demos, internal showcases, and small single-host deployments.

The Compose deployment uses **one shared Markdown Magpie application image** and runs separate containers from that image:

- `api`: HTTP API on port `4000`
- `web`: Next.js web console on port `3000`
- `watcher`: background AI job worker
- `mcp`: optional stdio MCP server process, enabled with the `mcp` Compose profile
- `migrate`: one-shot database migration job
- `postgres`: Postgres 16 with `pgvector`
- `redis`: Redis 7, available for future Redis-backed adapters

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

The Compose file always loads `.env.compose.example`. For a quick local showcase, you can use it as-is.

Create a private override file when you need to change settings or add secrets:

```bash
cp .env.compose.example .env.compose
```

For a local showcase on your own machine, the defaults are enough.

For a remote host or VPS, keep the container-internal URLs as service names:

```env
DATABASE_URL=postgres://postgres:postgres@postgres:5432/markdown_magpie
API_BASE_URL=http://api:4000
QUEUE_URL=redis://redis:6379
```

The web UI automatically falls back to the current browser host with API port `4000`. For example, if you open:

```text
http://203.0.113.10:3000
```

the browser will call:

```text
http://203.0.113.10:4000
```

If you later put the app behind a reverse proxy or a custom domain, set `NEXT_PUBLIC_API_BASE_URL` or `PUBLIC_API_BASE_URL` in `.env.compose` to the public API URL.

### 2. Choose the AI Mode

The easiest showcase mode is the default mock queue mode:

```env
AI_EXECUTION_MODE=queue
AI_JOB_PROVIDER=mock
CHAT_PROVIDER=mock
```

This requires no external keys. The watcher will claim queued jobs and return deterministic demo answers/proposals.

To use an OpenAI-compatible API from the watcher, edit `.env.compose`:

```env
AI_EXECUTION_MODE=queue
AI_JOB_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_API_KEY=your-key
OPENAI_COMPATIBLE_MODEL=gpt-4.1-mini
```

Any OpenAI-compatible `/chat/completions` endpoint can be used.

To make the API answer directly instead of queueing work for the watcher:

```env
AI_EXECUTION_MODE=direct
CHAT_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_API_KEY=your-key
OPENAI_COMPATIBLE_MODEL=gpt-4.1-mini
```

For Azure OpenAI direct mode:

```env
AI_EXECUTION_MODE=direct
CHAT_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_CHAT_DEPLOYMENT=your-chat-deployment
AZURE_OPENAI_API_VERSION=2024-10-21
```

### 3. Build and Start Everything

Run:

```bash
docker compose up --build -d
```

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

The MCP server is a stdio process intended to be launched by an MCP client, so it is not started by default. To include it for testing:

```bash
docker compose --profile mcp run --rm mcp
```

### 4. Open the Showcase

Open the web console:

```text
http://localhost:3000
```

On a remote host, use the host IP or domain:

```text
http://your-host:3000
```

The API health endpoint is:

```text
http://localhost:4000/health
```

Expected response:

```json
{"ok":true,"service":"markdown-magpie-api"}
```

### 5. Add Demo Knowledge

The web console has a **Knowledge** section where you can paste or upload Markdown. This is the easiest way to seed a showcase.

You can also upload Markdown through the API:

```bash
curl -s http://localhost:4000/documents/upload \
  -H 'content-type: application/json' \
  -d '{
    "repositoryId": "showcase",
    "name": "Showcase Knowledge",
    "documents": [
      {
        "path": "cats/health.md",
        "content": "# Cat Health\n\nUrgent warning signs include breathing trouble, collapse, seizures, repeated vomiting, and inability to urinate."
      },
      {
        "path": "cats/care.md",
        "content": "# Cat Care\n\nIntroduce food changes gradually over seven to ten days. Keep water available and monitor appetite."
      }
    ]
  }'
```

Then ask:

```bash
curl -s http://localhost:4000/ask \
  -H 'content-type: application/json' \
  -d '{"question":"What cat warning signs are urgent?"}'
```

In queue mode, the API returns a job first. The watcher should complete it shortly. Refresh the web UI or inspect jobs:

```bash
curl -s http://localhost:4000/ai-jobs
curl -s http://localhost:4000/questions
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

With `AI_JOB_PROVIDER=mock`, the generated proposal is deterministic. With `AI_JOB_PROVIDER=openai-compatible`, the watcher asks the configured model to return structured JSON and stores the resulting Markdown proposal.

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
docker compose up --build -d
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
KNOWLEDGE_STORE=postgres
QUESTION_LOG_STORE=postgres
PROPOSAL_STORE=postgres
AI_JOB_QUEUE=postgres
```

That means uploaded Markdown, questions, jobs, and proposals survive container restarts. They do not survive `docker compose down -v`.

### Ports and Firewall

For a local demo, no firewall changes are usually needed.

For a remote showcase, open:

- TCP `3000` for the web UI
- TCP `4000` for the API

Do not expose Postgres (`5432`) or Redis (`6379`) publicly. The current Compose file maps them to host ports for developer convenience. For a public server, restrict those ports with your host firewall, or remove the `ports` entries for `postgres` and `redis` and keep them available only on the Compose network.

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
docker compose up -d
```

### Troubleshooting

If the API is offline in the UI, check:

```bash
docker compose logs api
curl -s http://localhost:4000/health
```

If migrations fail, check:

```bash
docker compose logs migrate
```

Common causes are an invalid `DATABASE_URL`, Postgres not being ready, or an old partially initialized database. For a disposable showcase database, reset with:

```bash
docker compose down -v
docker compose up --build -d
```

If queued questions never complete, check the watcher:

```bash
docker compose logs -f watcher
```

For OpenAI-compatible mode, verify:

```env
AI_JOB_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=...
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=...
```

If the web UI loads but cannot call the API from a remote machine, check that port `4000` is reachable from your browser:

```text
http://your-host:4000/health
```

If that URL works but the UI still fails, set `NEXT_PUBLIC_API_BASE_URL` to the exact public API URL in `.env.compose` and restart the web container:

```bash
docker compose restart web
```

## AI Execution

Markdown Magpie treats AI work as provider-neutral jobs.

There are three intended execution modes:

- `mock`: deterministic local responses for development and tests.
- `direct`: the API calls a configured model provider directly, such as Azure OpenAI, OpenAI-compatible APIs, Anthropic, or local model gateways.
- `queue`: the API enqueues AI jobs and an external watcher claims them. This lets users run Codex, Claude Code, or another local agent as the model provider.

Watcher mode lowers the barrier to entry because early users can develop and test workflows with the agent tooling they already run locally, without provisioning cloud model credentials.

## Local Development

Start the API:

```bash
npm run dev:api
```

Index the sibling sample knowledge base:

```bash
curl -s -X POST http://localhost:4000/repositories/index \
  -H 'content-type: application/json' \
  -d '{"localPath":"../markdown-magpie-kb"}'
```

Search indexed Markdown sections:

```bash
curl -s 'http://localhost:4000/search?q=hotfix'
```

Start a mock watcher in another shell:

```bash
AI_EXECUTION_MODE=queue npm run dev:watcher
```

Create a queued answer job through the API:

```bash
curl -s http://localhost:4000/ask \
  -H 'content-type: application/json' \
  -d '{"question":"How do we deploy a hotfix?"}'
```

The watcher claims jobs from `/ai-jobs/claim` and completes them through `/ai-jobs/:id/complete`.

By default, AI jobs are stored in memory. To use Postgres:

```bash
docker compose up -d postgres
psql "$DATABASE_URL" -f packages/db/migrations/0001_initial.sql
AI_JOB_QUEUE=postgres AI_EXECUTION_MODE=queue npm run dev:api
```

By default, indexed knowledge is held in memory and can optionally be persisted:

```bash
KNOWLEDGE_STORE=postgres npm run dev:api
```

Question logs also default to memory. To persist them:

```bash
QUESTION_LOG_STORE=postgres npm run dev:api
```

Use a chat provider for answer synthesis:

```bash
CHAT_PROVIDER=mock npm run dev:api
CHAT_PROVIDER=openai-compatible npm run dev:api
CHAT_PROVIDER=azure-openai npm run dev:api
```

`mock` is the default and produces deterministic answers from retrieved Markdown context. OpenAI-compatible and Azure OpenAI providers use HTTP APIs configured through environment variables.

Inspect logged questions and gap candidates:

```bash
curl -s http://localhost:4000/questions
curl -s http://localhost:4000/gaps/candidates
```

Run the local cats demo with the Codex watcher:

```powershell
.\scripts\run-cat-demo.ps1 -StopExisting
```

The script starts the API in queued mode, starts the watcher with `AI_JOB_PROVIDER=codex`, starts the web console, indexes `knowledge-bases/cats`, and opens logs under `tmp/`.

Use the mock watcher instead of Codex:

```powershell
.\scripts\run-cat-demo.ps1 -Provider mock -StopExisting
```

Use an OpenAI-compatible API watcher:

```powershell
$env:OPENAI_COMPATIBLE_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_COMPATIBLE_API_KEY="..."
$env:OPENAI_COMPATIBLE_MODEL="..."
.\scripts\run-cat-demo.ps1 -Provider openai-compatible -StopExisting
```

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
