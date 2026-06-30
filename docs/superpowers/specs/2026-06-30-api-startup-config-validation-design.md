# API startup config validation

**Date:** 2026-06-30
**Scope:** `apps/api`
**Status:** Approved — implementing

## Problem

`apps/api` reads ~36 environment variables ad-hoc, scattered across the
composition root (`platform/providers.ts`, `platform/stores.ts`,
`platform/repositories.ts`, `context.ts`, `config-holder.ts`) and beyond
(`main.ts`, `features/jobs/service.ts`, `features/workers/service.ts`,
`features/config/service.ts`, `jobs/pg-boss-broker.ts`), each with an inline
`?? default` fallback and **no validation at startup**. A typo'd or malformed
var (non-numeric timeout, missing required credential, bad URL) surfaces lazily
mid-request rather than failing fast at boot. Several readers silently fall back
to a default on malformed input, masking the misconfiguration entirely.

## Goal

1. A single validated config module reads and validates the env **once** at
   startup. On invalid/missing-required config, fail fast with a clear,
   aggregated error naming the offending var(s) — before the server accepts
   requests.
2. Composition-root readers consume the validated config object instead of
   reading `process.env` with inline defaults. Env access stays at the app
   boundary (packages stay env-free).
3. Behavior for valid configs is preserved (same defaults, same backend
   selection). This is hardening, not a behavior change — with one deliberate
   exception (below).

## Non-goals

- **Runtime-mutable config** (`config-holder.ts` — the active AI provider,
  changed via the config feature at runtime) is NOT folded into the static env
  schema. The schema validates `AI_PROVIDER` as a plain field and that value
  *seeds* the holder; the holder remains a separate runtime object.
- **Knowledge JSON vars** (`KNOWLEDGE_SOURCES/DESTINATIONS/FLOWS/REPOSITORIES/`
  `REPO_PATH`) keep their existing tolerant parsing in `knowledge-repositories.ts`.
  `loadConfig` invokes those parsers (they already accept an injected `env`) and
  stores the result; it does not re-implement or tighten JSON parsing.
- **Auth wiring** stays in `@magpie/auth`'s `authSettingsFromEnv`. The schema
  only adds a *validate-only* coherence rule so misconfig fails at boot.
- `INIT_CWD` / `process.cwd()` path-anchoring stays in `repositories.ts` /
  `knowledge-index.ts` (npm-lifecycle var, not user config).

## Design

### New module: `apps/api/src/platform/config.ts`

```ts
export interface AppConfig { /* fully typed, validated env-derived config */ }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig
```

- Pure function (no caching/singleton). Builds a zod schema, runs
  `safeParse(env)`, and on failure throws **one** `Error` whose message
  aggregates every issue (one line per offending var: name + what was wrong +
  expected). On success returns a frozen, typed `AppConfig`.
- Lives in `platform/` with the other composition-root modules.

### Schema groups & conditional rules

| Group | Vars | Rule |
|---|---|---|
| Core | `DATABASE_URL` | **Required**, valid URL (pg-boss + every store needs it unconditionally; matches `requireDatabaseUrl()`). |
| Stores | `STORAGE_BACKEND` + 11 `*_STORE` | enum `memory\|postgres`. `STORAGE_BACKEND` default `memory`; each override defaults to inherit. Rejects typos. |
| AI | `AI_PROVIDER` | **Required**, enum `openai-compatible\|azure-openai\|codex\|claude` (reuse `isAiProviderName`); preserves current error wording. |
| Embeddings | `OPENAI_COMPATIBLE_*`, `AZURE_OPENAI_*`, `EMBEDDING_TIMEOUT_MS` | All **optional** (auto-detected; absent → keyword-only). `*_BASE_URL`/`ENDPOINT` validated as URL when present. `EMBEDDING_TIMEOUT_MS` positive-int when present. No all-or-nothing rule (would change behavior). |
| Numeric tunables | `PORT`, `JOB_WAIT_TIMEOUT_MS`, `JOB_WAIT_POLL_MS`, `JOB_RUN_TO_COMPLETION_TIMEOUT_MS`, `WATCHER_ACTIVE_WINDOW_MS`, `API_SHUTDOWN_DRAIN_MS`, `WATCHER_POLL_INTERVAL_MS`, `AGENT_API_TIMEOUT_MS` | coerced positive int; same defaults as today (PORT 4000, wait 25000, poll 250, drain 10000, active-window 900000, …). `JOB_RUN_TO_COMPLETION_TIMEOUT_MS` optional (no default). |
| Strings/paths | `MAGPIE_CHECKOUT_ROOT`, `MAGPIE_SNAPSHOT_ROOT`, `MAGPIE_LOCAL_INDEX_ROOT`, `GIT_PROVIDER`, `NODE_ENV`, `WATCHER_NAME`, `JOB_SCHEDULE_TIMEZONE`, `AZURE_OPENAI_API_VERSION`, `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` | optional with existing defaults (`.magpie/checkouts`, `local`, `development`, `UTC`, `2024-10-21`, …). |
| Booleans | `LOG_STARTUP_CONFIG` | optional; preserves `=== "false"` suppression semantics. |
| Auth (validate-only) | `AUTH_REQUIRED`, `AUTH0_*` | If `AUTH_REQUIRED=true` then `AUTH0_AUDIENCE` **and** (`AUTH0_ISSUER_BASE_URL` or `AUTH0_DOMAIN`) must be present → aggregated fail-fast. Wiring stays in `authSettingsFromEnv`. |

### Threading (DI, matching the codebase)

`loadConfig()` is called **once** at the top of `start()` in `main.ts`; the
result is passed into `createAppContext(config)` and stored as
`ctx.settings: AppConfig`.

- Composition-root functions (`storeBackend`, `createStore`,
  `requireDatabaseUrl`, `checkoutRoot`, `snapshotRoot`, `embeddingProviderName`,
  `createConfiguredEmbeddingProvider`, `retrievalMode`, …) take an `AppConfig`
  (or a slice) parameter instead of reading `process.env`.
- Per-request readers (`features/jobs/service.ts`, `features/workers/service.ts`)
  read `ctx.settings`.
- `features/config/service.ts` (`getRuntimeConfig`/`logStartupConfig`) reads
  `ctx.settings` — same masking / `set` / `not set` output.
- `PgBossJobBroker` gains a `scheduleTimezone` constructor option (from config)
  instead of reading `JOB_SCHEDULE_TIMEZONE` itself.
- `RuntimeConfigHolder` is seeded from `config.aiProvider`; `reset()` restores
  the stored seed instead of re-reading env (removes the only env read from
  `config-holder.ts`).
- `makeTestContext` supplies a default test `AppConfig`; schema tests call
  `loadConfig(fakeEnv)` directly.

### Fail-fast wiring

`loadConfig()` runs as the first statement of `start()` in `main.ts`, inside the
existing `try/catch` that logs `API startup failed: …` and sets `exitCode = 1`.
Invalid config aborts before the broker connects or the server listens.

## Behavior preservation — one deliberate change

Valid/absent config produces identical behavior (same defaults, same backend
selection). The single intended change: malformed values that today silently
fall back to a default (non-numeric `JOB_WAIT_TIMEOUT_MS` via `parsePositiveInt`,
bad `WATCHER_ACTIVE_WINDOW_MS`, typo'd `STORAGE_BACKEND`, `AUTH_REQUIRED=true`
with no audience) now **fail fast** — the hardening the audit asked for.

## Testing

- New `platform/config.test.ts`: rejects missing `DATABASE_URL`, non-numeric
  timeout, typo'd backend enum, bad `AI_PROVIDER`, `AUTH_REQUIRED=true` w/o
  audience — asserting the aggregated message names each offending var; accepts a
  full valid env and a minimal valid env; verifies conditional rules (per-store
  inherit, auth conditional).
- Update `config-holder.test.ts` (env-seed → config-seed) and tests that mutate
  `process.env` to build/inject config instead.

## Gates

`npm run typecheck`, `npm run lint`, `npm run deadcode` (knip STRICT — de-export
unused, do not relax config), `npm test`. `test:db` needs Docker and runs in CI.
