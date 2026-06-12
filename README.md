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
