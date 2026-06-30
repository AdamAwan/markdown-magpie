# Structured Logging Design

## Goal

Replace ad-hoc logging with a single structured logging foundation and raise log
coverage at the operationally important seams. Today there is no logging
abstraction: ~150 raw `console.*` calls are scattered through service-layer
business logic (api ~100, watcher ~43, mcp ~6, retrieval ~1). They have no log
levels, no structured fields, and no request/job correlation, which makes them
hard to filter, route, or trace in a deployed environment.

This work makes the app's logs **structured JSON on stdout**, so a future log
aggregator (tracked separately as an infrastructure concern) can ingest them
with no code changes.

Out of scope: the aggregator itself, and `apps/web` (pino is server-only; the
web app's `console` use is browser-side and was excluded from the audit counts).

## Decisions

These were settled during brainstorming:

- **Library: pino.** Industry-standard Node logger, low overhead, the format
  aggregators integrate with most readily. Accepts a runtime dependency in an
  otherwise dependency-light codebase, which is a deliberate trade.
- **Scope: replace and instrument.** Convert all existing `console.*` calls to
  the leveled logger *and* add new logs at the key seams (below).
- **Reach: hybrid.** One root logger per app, reached three ways depending on
  the shape of the code (see "How the logger reaches call sites").

## Architecture

### `@magpie/logger` package

A thin, env-free wrapper over pino, following the existing package conventions
(mirror `packages/auth`: `tsconfig.json` + `tsconfig.build.json`, `main`/`types`
pointing at `dist`).

Exports:

- `createLogger(opts: { level?: string; pretty?: boolean; base?: Record<string, unknown> }): Logger`
  — constructs a configured pino instance.
- `Logger` — the logger type (pino's `Logger`), so consumers and class
  constructors can type-annotate without importing pino directly.

The package never reads `process.env`. Configuration is passed in by each app at
its composition root, preserving the codebase rule that packages stay env-free.

Output behaviour:

- `pretty: false` (production default) → raw JSON lines to stdout (aggregator-ready).
- `pretty: true` (dev default) → `pino-pretty` transport for human-readable output.

Wiring: `@magpie/logger` has no `@magpie/*` dependencies (it is a leaf, like
`auth`), so it builds early. Add it to the root `package.json` build order
before the apps, to `tsconfig.base.json` `paths`, and to the `dependencies` of
the consuming workspaces (`api`, `watcher`, `mcp`, and `retrieval` — see
"Packages" below).

### How the logger reaches call sites (hybrid)

One root logger per app, created once at startup and configured from env there:

```ts
// apps/api/src/logger.ts (and equivalents in watcher, mcp)
import { createLogger } from "@magpie/logger";

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  pretty: process.env.NODE_ENV !== "production",
  base: { service: "api" },
});
```

Everything else derives from this one logger:

1. **Free functions (api services) — import the root logger.** The bulk of the
   call sites. `logger.warn({ proposalId }, "message")` replaces
   `console.warn(...)`. No signature changes.
2. **Classes (`WorkerLoop`, runners, stores) — constructor injection.** The
   composition root passes the logger (or a child) into the constructor; the
   class holds it as a field and logs through `this.logger`.
3. **Per-request / per-job scope — child loggers.** `logger.child({ requestId })`
   returns a logger that binds those fields to every line it emits. A Hono
   middleware mints one child per request; `WorkerLoop.execute` mints one child
   per job. This is the analog to a scoped `ILogger` and provides correlation
   without threading ids through every call.

The root logger is a module-level singleton, which is acceptable here because it
is a pure output sink with no business state; the varying behaviour
(request/job correlation) comes from children, not from shared mutable state.

## Instrumentation seams

### apps/api

- **Request logging middleware** (registered in `app.ts` after `cors` and
  `bodyLimit`, before the routes): assign a `requestId`, create a child logger
  bound to `{ requestId, method, path }`, store it on the Hono context
  (`c.set("logger", ...)`), and on completion log one line at `info` with
  `status` and `durationMs`. The Hono `Variables` type is extended so
  `c.get("logger")` is typed.
- **Error handler** (`http/errors.ts` `onError`): log non-`HttpError` 500s at
  `error` with the error stack, via the logger rather than `console.error`.
  Client-facing behaviour is unchanged (still a generic `internal_error` body).
- **Service-layer conversions**: convert the ~100 `console.*` calls in
  `features/*`, `scheduling/*`, `stores/*`, and `context.ts` to the imported
  root logger with structured fields and appropriate levels.
- **Startup**: keep the resolved-config summary (`features/config/service.ts`)
  but emit it at `info` through the logger.

### apps/watcher

- **`WorkerLoop`**: add a `logger: Logger` constructor parameter. Convert the
  existing lifecycle lines (`Got job` / `Done` / `failed` / `cancelled` /
  `poll failed`) to structured logs with `{ jobId, jobType, capability,
  durationMs, outcome }`, emitted through a per-job child logger created in
  `execute`. Add a `debug` log on claim attempts.
- **`main.ts`** (composition root): build the root logger, pass it into
  `WorkerLoop` and the runners, and log the advertised capability readiness at
  startup (set/MISSING per the existing capability gates — without logging
  secret values).
- **Runners**: where they log, accept a logger via their existing
  constructor/factory wiring.

### apps/mcp

- Convert the 6 `console.*` calls to the root logger and add request logging in
  `http.ts` consistent with the api middleware.

### Packages

Packages must not import an app's root logger (that would invert the
package→app dependency direction). The only package call site is
`packages/retrieval/src/routing.ts:48` (a `console.debug` when provider-based
routing fails and degrades to the default flow). Resolution: `routeQuestionToFlow`
gains an optional `logger?: Logger` parameter (type imported from the leaf
`@magpie/logger`); the api caller passes its request/root logger, and when no
logger is supplied the routing degrades silently as today. No other package
needs a logger.

## Level mapping

| Current | New |
| --- | --- |
| `console.error` | `logger.error` |
| `console.warn` | `logger.warn` |
| `console.log` (operator/status, e.g. startup, completion) | `logger.info` |
| `console.log` (verbose/diagnostic) | `logger.debug` |

Add a `LOG_LEVEL` env var (default `info`; `debug` in development) and document
it in `.env.example` and `.env.compose.example`.

## Error handling

Logging changes must not alter control flow or client-facing responses. Existing
`try/catch` blocks keep their behaviour; only the logging call inside them
changes. The api error handler continues to return `internal_error` to clients
and now logs the diagnostic detail through the structured logger.

## Testing (TDD)

- **`@magpie/logger`**: `createLogger` emits JSON at the configured level to an
  injectable destination stream; lines below the level are filtered; a child
  logger's bound fields appear on every emitted line. (pino accepts a custom
  destination stream, so output is captured and asserted without touching real
  stdout.)
- **api request middleware**: a request produces one completion log carrying
  `status` and `durationMs`, and `c.get("logger")` is the request-scoped child.
- **api `onError`**: a non-`HttpError` produces an `error`-level log and the
  response body is still `{ error: "internal_error" }`.
- **watcher `WorkerLoop`**: complete / fail / cancel paths each emit the
  expected structured lifecycle log, asserted via an injected capture logger.

For class seams, tests inject a logger writing to a capture stream. For the
free-function services, tests do not assert on logs (logging there is not
behaviour); existing service tests continue to pass unchanged.

## Scope guardrails

- Logging only — no behaviour changes, no refactoring of unrelated code.
- `apps/web` is untouched.
- knip runs in STRICT mode: every `@magpie/logger` export must be consumed, so
  the package exposes only `createLogger` and `Logger`.
- Quality gates (`typecheck`, `lint`, `deadcode`, `test`, `build`) must all stay
  green.

## Work breakdown (high level)

1. Create and wire the `@magpie/logger` package (build order, tsconfig paths,
   app dependencies) with tests.
2. api: add per-app root logger, request middleware, error-handler logging;
   convert service/store/scheduling `console.*`.
3. watcher: thread the logger through `main.ts` → `WorkerLoop`/runners; convert
   lifecycle logs to structured.
4. mcp: root logger, request logging, convert `console.*`.
5. retrieval: add the optional `logger?: Logger` param to `routeQuestionToFlow`
   and pass the request logger from the api caller.
6. Add `LOG_LEVEL` to env examples; run the full gate suite.
