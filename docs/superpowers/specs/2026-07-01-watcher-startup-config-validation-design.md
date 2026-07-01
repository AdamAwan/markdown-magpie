# Watcher startup config validation

**Date:** 2026-07-01
**Scope:** `apps/watcher`
**Status:** Implemented

## Problem

Unlike the API's rigorous zod config (`apps/api/src/platform/config.ts`, which
aggregates and reports every invalid var at boot — see the
[2026-06-30 API design](./2026-06-30-api-startup-config-validation-design.md)),
the watcher read `process.env` ad hoc in its composition root
(`apps/watcher/src/main.ts`) with silent `??` fallbacks — most dangerously
`API_BASE_URL ?? "http://localhost:4000"`. A misconfigured watcher in production
therefore fell back to localhost defaults instead of failing fast, and a missing
machine-to-machine credential silently 401'd every claim forever. The watcher
already gated AI capabilities on credential presence (`capabilities.ts`) and had
validated health-server config (`loadHealthConfig`), but its core wiring — API
URL, poll interval, auth credential — was unvalidated.

## Goal

1. A single validated config module reads and validates the watcher env **once**
   at startup. On invalid/missing-required config, fail fast with a clear,
   aggregated error naming the offending var(s) — before the poll loop starts.
2. The composition root (`main.ts`) consumes the validated config object instead
   of reading `process.env` with inline defaults.
3. Remove silent localhost fallbacks for production-required settings; keep
   dev-friendly defaults only where clearly safe (and gate them on auth being
   explicitly disabled).

## Non-goals

- **Health-server config** (`loadHealthConfig`) stays its own validated module.
- **Capability gating** (`capabilities.ts` / `deriveCapabilities`) stays as-is —
  it already derives from credential presence and must remain permissive so a
  watcher can advertise exactly the providers it has creds for.
- **Auth wiring** stays in `@magpie/auth` (`authSettingsFromEnv`,
  `isAuthRequired`). The schema only adds validate-only coherence rules and reads
  the resolved issuer/audience back out to build the token endpoint URL.

## Design

### New module: `apps/watcher/src/config.ts`

```ts
export interface WatcherConfig { /* apiBaseUrl, watcherName, pollIntervalMs, auth */ }
export function loadWatcherConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig
```

Pure function (no caching). Builds a zod schema, runs `safeParse(env)`, and on
failure throws **one** `Error` aggregating every issue (one line per offending
var). On success returns a typed `WatcherConfig`. Called as the first statement
of the composition root in `main.ts`.

### Schema & conditional rules

| Group | Vars | Rule |
|---|---|---|
| API URL | `API_BASE_URL` | Valid URL when present. **Required** when auth is enabled (no silent localhost fallback in prod); defaults to `http://localhost:4000` only when `AUTH_REQUIRED=false`. |
| Label | `WATCHER_NAME` | Optional; default `local-dev-watcher`. |
| Poll | `WATCHER_POLL_INTERVAL_MS` | Positive int when present; default `2000`. |
| Credentials | `API_TOKEN`, `WATCHER_API_CLIENT_ID`, `WATCHER_API_CLIENT_SECRET` | Client-id and client-secret are **both-or-neither** (a lone half silently degrades to no M2M token — always rejected). When auth is enabled, at least one credential (the client-credentials quad **or** the legacy static `API_TOKEN`) is **required**. |
| Auth (validate-only) | `AUTH_REQUIRED`, `AUTH0_*` | Auth fails closed (`isAuthRequired`). When enabled **and** the client-credentials grant is in use, `AUTH0_AUDIENCE` (not the committed placeholder) and (`AUTH0_ISSUER_BASE_URL` or `AUTH0_DOMAIN`) must be present, since the token fetch needs a real audience/issuer. |

The returned `auth` slice carries the raw credentials plus the `tokenUrl` and
`audience` resolved from `authSettingsFromEnv`, so `main.ts` builds the API token
provider without re-reading env.

## Behavior preservation

Valid/absent config in local dev (`AUTH_REQUIRED=false`) behaves exactly as
before — localhost default, no credential required (matches the `run-magpie`
recipe, which clears the M2M creds locally). The intended changes all tighten the
production posture (`AUTH_REQUIRED` on): a missing `API_BASE_URL`, a missing
credential, a lone credential half, a malformed URL/poll interval, or a
placeholder audience now **fail fast** at boot instead of surfacing as a wedged,
always-401ing watcher.

## Testing

`apps/watcher/src/config.test.ts`: dev defaults; valid overrides; blank-as-unset;
malformed URL and poll interval; lone-credential-half rejection; the full set of
auth-enabled fail-fast gates (missing API URL, missing credential, static-token
fallback, placeholder/missing audience, missing issuer); and aggregation of
multiple errors into one message.

## Gates

`npm run typecheck`, `npm run lint`, `npm run deadcode`, `npm test`.
