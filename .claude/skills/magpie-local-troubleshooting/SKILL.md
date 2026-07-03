---
name: magpie-local-troubleshooting
description: Diagnose and fix common failures when running Markdown Magpie locally, especially on Windows/PowerShell — Docker not starting, private-repo clone auth, silent knowledge-config parsing, the web app's blank/hanging UI, watcher ECONNREFUSED, and CLI-provider spawn errors (ENAMETOOLONG / ENOENT). Use when the local stack won't start, a service crashes, or the console/browser shows errors. Pairs with run-magpie (the launch recipe).
---

# Troubleshooting Markdown Magpie locally

This skill is the **failure-mode companion** to `run-magpie`. Get the launch recipe
(Postgres → migrate → API → Watcher → Web, and the local `.env` overrides) from
**`run-magpie`** — don't re-derive it here. Come here when something breaks.

Most of these were hit on **Windows / PowerShell**, but the config gotchas (knowledge
sources, `next dev` env loading) are cross-platform.

## Windows / PowerShell syntax

The `run-magpie` recipe is written in bash. On PowerShell:

- **Inline env override** `VAR=val cmd` doesn't exist → set it first: `$env:VAR = 'val'; cmd`.
  Node's `--env-file` does **not** overwrite already-set shell vars, so this is how the
  local overrides in `run-magpie` take effect.
- **`mkdir -p x`** → `New-Item -ItemType Directory -Force x | Out-Null`.
- **`curl`** is an alias for `Invoke-WebRequest` → use **`curl.exe`** for the recipe's
  `curl -s ...` calls.
- The migrate script is `scripts/migrate.mjs` (**`.mjs`**, not `.js`).

## Symptom → cause → fix

### `docker compose up` → "cannot find the file ... dockerDesktopLinuxEngine"
The Docker daemon isn't reachable. Almost always **Docker Desktop isn't running** (or is
in Windows-containers mode). Start Docker Desktop, wait for the engine, retry. Check the
active context with `docker context show` (should be `desktop-linux`).

### `node --env-file=.env scripts/migrate.mjs` → `Cannot find package 'pg'`
The **checkout has no `node_modules`**. Each clone/worktree needs its own `npm install`
at the repo root — a fresh worktree otherwise resolves `@magpie/*` to MAIN's stale dist
and misses root deps like `pg`. Run `npm install`, then retry.

### API exits on boot right after "syncing configured git checkouts"
`bootstrap()` clones every configured **git source**; a failed clone exits the process
(exit 1) with `Failed to sync configured git repositories`. Common causes:

- **Private remote needs credentials** (e.g. Azure DevOps `https://…@dev.azure.com/…`).
  The API clones **non-interactively**, so it can't prompt. Make `git clone <url>` succeed
  standalone first — cache a PAT in Git Credential Manager, or embed a token in the URL.
- `MAGPIE_CHECKOUT_ROOT` points at a non-writable path (prod default `/data/checkouts`
  isn't writable locally) → override it to a local dir (see `run-magpie`).

### `knowledge/stats` empty / "syncing configured git checkouts count: 0"
The knowledge-config parsers are **deliberately defensive — they never throw, they
silently drop malformed entries** (`apps/api/src/stores/knowledge-repositories.ts`). So a
typo yields "0 sources" instead of an error. Check `KNOWLEDGE_SOURCES` /
`KNOWLEDGE_DESTINATIONS` / `KNOWLEDGE_FLOWS`:

- **A stray `==`** (`KNOWLEDGE_SOURCES==[…]`) makes the value `=[…]`, which fails
  `JSON.parse` and is dropped. Use a single `=`.
- **A source `url` ⇒ `kind: "git"`** (gets cloned, bumps the checkout `count`); a `path`
  ⇒ `kind: "local"`. A `count: 0` with a configured source usually means the source line
  didn't parse.
- **Flow ids must line up.** A flow's `sourceIds` must reference **source** ids and
  `destinationId` a **destination** id. A flow whose `sourceIds` don't all match a
  configured source is **filtered out entirely** — so `flowId` won't exist to index/ask.

### Web UI: blank page, all `_next/static/chunks/*.js` fail, script requests hang
**The web dev server does not read the repo-root `.env`.** `next dev` only loads env from
`apps/web/` (`.env.local`, `.env.development`, `.env`) plus the shell. So
`NEXT_PUBLIC_API_BASE_URL` / `MAGPIE_DEV_API_PROXY` sitting in the **root** `.env` are
invisible to the web app.

Consequence: with no API base configured, the browser calls **same-origin `/api/*` on
`:3000`**; with no proxy rewrite those requests hit the Next server (or hang against a
dead API) and **saturate the browser's ~6-connections-per-origin limit**, starving the JS
chunk requests. Tell-tale sign: **a chunk URL loads fine once you close the app tab.**

Fix — give the web app the API location via the **shell** (or `apps/web/.env.local`),
and make sure the API is up:

```powershell
$env:MAGPIE_DEV_API_PROXY = 'http://localhost:4000'   # same-origin proxy (no CORS)
npm run dev:web
```

Or persist it in **`apps/web/.env.local`** (gitignored, and Next *will* load it):

```dotenv
MAGPIE_DEV_API_PROXY=http://localhost:4000
```

### Watcher spams `watcher poll failed … ECONNREFUSED`
The watcher can't reach the API. It defaults to `http://localhost:4000` and polls every
2s (`WATCHER_POLL_INTERVAL_MS`); the same interval is the error backoff, hence ~1 log
every 2s. **The watcher is fine — the API is down or on another port.** Confirm nothing is
listening (`Get-NetTCPConnection -State Listen -LocalPort 4000`) and restart the API; the
watcher recovers on its own.

### `POST /api/ask` returns 202 but never completes
No watcher is running, or it advertises no `provider` capability. All chat/generative work
is **queue-only** — the watcher is required. Its startup log lists each capability as
ready/missing; the selected `AI_PROVIDER` must have a ready runner.

### CLI provider (codex / claude): `spawn ENAMETOOLONG`
The prompt is passed as a **command-line argument** and exceeds Windows' ~32 KB limit.
Switch that provider to stdin mode: `CODEX_CLI_PROMPT_MODE=stdin` /
`CLAUDE_CLI_PROMPT_MODE=stdin` (pipes the prompt in instead). Effectively required on
Windows for retrieval-augmented prompts.

### CLI provider: `spawn ENOENT` for `claude` / `codex`
The runner spawns **without a shell**, so a Windows `.cmd`/`.ps1` PATH shim can't be
resolved. Point `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH` at a directly-spawnable executable
(e.g. `claude.exe`), not the shim.

## Running in "claude" (or "codex") CLI provider mode

Two settings must line up — see `docs/chat-providers.md`:

1. **Watcher** advertises the capability: set `CLAUDE_CLI_PATH` (or `CODEX_CLI_PATH`).
2. **API** routes jobs to it: set `AI_PROVIDER=claude` (or `codex`). Otherwise jobs go to
   a different provider's queue and the CLI runner sits idle even though it's ready.

Pick the model with **`CLAUDE_CLI_MODEL`** / **`CODEX_CLI_MODEL`** — when set, the watcher
appends `--model <value>` to the CLI args (the flag both CLIs share). Unset ⇒ the CLI's
own default.

## Fast health checks

```powershell
curl.exe -s localhost:4000/api/health          # API up + resolved config
curl.exe -s localhost:3000/api/health          # proves the web → API proxy works
curl.exe -s localhost:4000/api/knowledge/stats # {repositoryCount,documentCount,sectionCount}
Get-NetTCPConnection -State Listen -LocalPort 4000   # is the API actually listening?
```
