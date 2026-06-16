---
name: run-magpie
description: Launch and drive the Markdown Magpie app locally (Postgres + API + Web). Use when asked to run, start, smoke-test, or screenshot the app, or to confirm a change works in the real running stack.
---

# Running Markdown Magpie locally

Verified launch recipe for the npm-workspace monorepo (Node 22, ESM/NodeNext).
The app is: a **Postgres-backed API** (`@magpie/api`, port 4000) and a **Next.js web
console** (`@magpie/web`, port 3000). A **watcher** and **mcp** exist but are only
needed in queue mode / for MCP clients — skip them for a normal run.

## What the stack needs

`.env` (repo root) is the source of config. The default/production `.env` uses:
- `STORAGE_BACKEND=postgres` → needs Postgres (pgvector) on `:5432`.
- `AI_EXECUTION_MODE=direct` → the API calls the chat/embedding provider synchronously,
  so **no watcher is required** (the watcher only services `queue` mode).
- AI job queue + stores are Postgres → **Redis is not required** despite `QUEUE_URL`.
- `MAGPIE_CHECKOUT_ROOT=/data/checkouts` is a **production path that is not writable
  locally** — override it (see below) or bootstrap fails cloning the knowledge repos.

So a local run = **Postgres (docker) → migrate → API → Web**.

## Launch (each step verified)

```bash
cd <repo root>

# 1. Postgres (pgvector). The api/web/migrate compose services are behind the
#    `app` profile, so this starts ONLY the DB and won't try to build images.
docker compose up -d postgres
# wait for healthy:
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)")" = healthy ]; do sleep 2; done

# 2. Migrations (migrate.mjs reads DATABASE_URL from the env-file).
node --env-file=.env scripts/migrate.mjs

# 3. API on :4000. Override MAGPIE_CHECKOUT_ROOT to a writable local path so the
#    configured git knowledge repos can be cloned on boot. (Shell env overrides
#    --env-file; Node's --env-file does NOT override already-set vars.)
mkdir -p .magpie/checkouts
MAGPIE_CHECKOUT_ROOT="$PWD/.magpie/checkouts" npm run dev:api   # run in background

# 4. Web on :3000. Set MAGPIE_DEV_API_PROXY so the browser reaches the API
#    same-origin (next.config rewrites /api/* → this URL; inert when unset).
MAGPIE_DEV_API_PROXY="http://localhost:4000" npm run dev:web    # run in background
```

Launch steps 3 and 4 in the background (they're long-running servers) and tail their
logs. The API boots fast (~2s) but clones the knowledge repos on first run.

## Drive it (don't just launch it)

```bash
# API up + resolved config (backend, retrieval mode, providers, schedulers)
curl -s localhost:4000/api/health            # {"ok":true,...}
# web → API proxy
curl -s localhost:3000/api/health            # same, proves the rewrite works
# knowledge state
curl -s localhost:4000/api/knowledge/stats   # {repositoryCount,documentCount,sectionCount}

# If stats are empty (fresh/cleared DB), index the configured flow, then wait for
# the background embedding pass to finish before searching/asking:
curl -s -X POST localhost:4000/api/repositories/index -H 'content-type: application/json' -d '{"flowId":"flowerbi"}'
#   → API log prints "Embedded N section(s); 0 remaining" when ready
curl -s 'localhost:4000/api/search?q=FlowerBI&limit=3'      # sanity: sections returned

# Full primary flow: hybrid retrieval → chat provider → cited answer (direct mode)
curl -s -X POST localhost:4000/api/ask -H 'content-type: application/json' -d '{"question":"What is FlowerBI?"}'
```

The web console is at **http://localhost:3000** — open it to click through Ask /
Knowledge / Proposals / Crunch.

## Gotchas

- **`/data/checkouts` not writable** → always override `MAGPIE_CHECKOUT_ROOT` locally,
  or the API's `bootstrap()` logs "Failed to sync configured git repositories" and exits 1.
- **Web can't reach API / CORS** → you forgot `MAGPIE_DEV_API_PROXY=http://localhost:4000`
  on the web dev server.
- **Low-confidence "no source material" answers** → the knowledge index is empty or
  un-embedded; index the flow and wait for the embedding pass.
- **`npm run -w @magpie/api typecheck` fails (TS6059)** → known pre-existing per-workspace
  config issue; the real gate is the root `npm run typecheck`.
- Provider keys (DeepSeek / OpenRouter / GITHUB_TOKEN) live in `.env`; `/api/config`
  reports each as set/not-set without leaking values.
