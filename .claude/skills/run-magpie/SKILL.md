---
name: run-magpie
description: Launch and drive the Markdown Magpie app locally (Postgres + API + Watcher + Web). Use when asked to run, start, smoke-test, or screenshot the app, or to confirm a change works in the real running stack.
---

# Running Markdown Magpie locally

Launch recipe for the npm-workspace monorepo (Node 22, ESM/NodeNext). The app is:
a **Postgres-backed API** (`@magpie/api`, port 4000), a **Next.js web console**
(`@magpie/web`, port 3000), and a **watcher** (`@magpie/watcher`) that executes all
AI/generative work. An **mcp** server also exists but is only needed for MCP clients —
skip it for a normal run.

The system is **queue-only**: the API never calls the chat/embedding provider itself.
It records the question and enqueues an `answer_question` job; the watcher claims it,
routes to a flow, calls back into the API for scoped context, then answers. So **the
watcher is required** — without it, `POST /api/ask` returns a `202` job that never
completes. (There is no longer an `AI_EXECUTION_MODE`/"direct mode" — it was removed
in the queue-only migration.)

## What the stack needs

`.env` (repo root) is the source of config, loaded by each app's dev script via
`--env-file=../../.env`. **Shell-set vars override it** (Node's `--env-file` does NOT
overwrite already-set vars), which is how the local overrides below work. The committed
`.env` is the **production** config, so a local run must override two things:

- `STORAGE_BACKEND=postgres` → needs Postgres (pgvector) on `:5432`.
- AI job queue + stores are Postgres → **Redis is not required** despite `QUEUE_URL`.
- `AUTH_REQUIRED=true` (prod) gates token validation across the API. Locally, **override
  `AUTH_REQUIRED=false`** so the API skips auth and the watcher can claim jobs without
  Auth0 — otherwise every call (and `/api/jobs/claim`) returns `401`. The watcher only
  sends an Authorization header when its M2M creds are set, so clear those locally too
  (see `apps/watcher/src/main.ts`).
- `MAGPIE_CHECKOUT_ROOT=/data/checkouts` is a **production path that is not writable
  locally** — override it (see below) or bootstrap fails cloning the knowledge repos.

So a local run = **Postgres (docker) → migrate → API → Watcher → Web**.

## Launch

```bash
cd <repo root>

# 1. Postgres (pgvector). The api/web/migrate compose services are behind the
#    `app` profile, so this starts ONLY the DB and won't try to build images.
docker compose up -d postgres
# wait for healthy:
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)")" = healthy ]; do sleep 2; done

# 2. Migrations (migrate.mjs reads DATABASE_URL from the env-file).
node --env-file=.env scripts/migrate.mjs

# 3. API on :4000. Override AUTH_REQUIRED so the API skips token validation, and
#    MAGPIE_CHECKOUT_ROOT to a writable local path so the configured git knowledge
#    repos can be cloned on boot.
mkdir -p .magpie/checkouts
AUTH_REQUIRED=false MAGPIE_CHECKOUT_ROOT="$PWD/.magpie/checkouts" npm run dev:api   # background

# 4. Watcher — REQUIRED for the queue-only world (answers, drafts, publishing).
#    Clear the M2M creds so it talks to the local API with no auth header.
#    On startup it logs which capabilities are ready; `provider` must be ready to
#    answer questions (it reads the OPENAI_COMPATIBLE_* keys from .env).
AUTH_REQUIRED=false WATCHER_API_CLIENT_ID= WATCHER_API_CLIENT_SECRET= \
  MAGPIE_CHECKOUT_ROOT="$PWD/.magpie/checkouts" npm run dev:watcher                 # background

# 5. Web on :3000. Set MAGPIE_DEV_API_PROXY so the browser reaches the API
#    same-origin (next.config rewrites /api/* → this URL; inert when unset).
MAGPIE_DEV_API_PROXY="http://localhost:4000" npm run dev:web                        # background
```

Launch steps 3, 4 and 5 in the background (they're long-running) and tail their logs.
The API boots fast (~2s) but clones the knowledge repos on first run.

## Drive it (don't just launch it)

```bash
# API up + resolved config (backend, providers, schedulers)
curl -s localhost:4000/api/health            # {"ok":true,...}
# web → API proxy
curl -s localhost:3000/api/health            # same, proves the rewrite works
# knowledge state
curl -s localhost:4000/api/knowledge/stats   # {repositoryCount,documentCount,sectionCount}

# If stats are empty (fresh/cleared DB), index the configured flow, then wait for
# the background embedding pass to finish before searching/asking:
curl -s -X POST localhost:4000/api/knowledge/repositories/index -H 'content-type: application/json' -d '{"flowId":"flowerbi"}'
#   → API log prints "Embedded N section(s); 0 remaining" when ready
curl -s 'localhost:4000/api/knowledge/search?q=FlowerBI&limit=3'      # sanity: sections returned

# Full primary flow (queue-only): /ask returns 202 + a job; the WATCHER does the
# routing → hybrid retrieval → chat → cited answer, then completes the job.
RESP=$(curl -s -X POST localhost:4000/api/ask -H 'content-type: application/json' -d '{"question":"What is FlowerBI?"}')
JOB=$(echo "$RESP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).job.id')
curl -s "localhost:4000/api/jobs/$JOB/wait"            # long-polls until the watcher finishes
# the answer + citations also land on the question log:
QID=$(echo "$RESP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).questionId')
curl -s "localhost:4000/api/questions/$QID"
```

The web console is at **http://localhost:3000** — open it to click through Ask /
Knowledge / Proposals / Crunch.

## Gotchas

- **`POST /api/ask` returns 202 and the job never completes** → no watcher running, or
  it advertises no `provider` capability. Start `dev:watcher` and check its startup log
  shows `Capability provider — ready`.
- **`401` on API calls / watcher can't claim jobs** → you're running against the prod
  `.env` with `AUTH_REQUIRED=true`. Override `AUTH_REQUIRED=false` for local dev (steps
  3 and 4).
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
