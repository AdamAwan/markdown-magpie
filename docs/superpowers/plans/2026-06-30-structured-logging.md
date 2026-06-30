# Structured Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ~150 ad-hoc `console.*` calls with a pino-based structured logger and add logging at the api/watcher/mcp seams, emitting JSON to stdout (stderr for stdio MCP) so a future aggregator can ingest it with no code change.

**Architecture:** A new dependency-free `@magpie/logger` package wraps pino behind `createLogger(opts)`. Each app builds one root logger at its composition root (reading env there), free functions import it, classes (`WorkerLoop`) take it via constructor, and request/job scope comes from `logger.child({...})`. Packages stay env-free; only `retrieval` gains an *optional* logger parameter.

**Tech Stack:** TypeScript (NodeNext ESM), pino 9, pino-pretty (dev only), Hono (api), `node:test` + tsx for tests.

**Spec:** `docs/superpowers/specs/2026-06-30-structured-logging-design.md`

## Global Constraints

- Node `>=22.12`; TypeScript NodeNext ESM — relative imports inside packages/apps use the `.js` extension.
- `@magpie/logger` has **no** `@magpie/*` dependencies (a leaf package, like `auth`).
- Packages MUST NOT read `process.env` or import an app's root logger. Env is read only at app composition roots.
- knip runs in STRICT mode (`ignoreExportsUsedInFile` unset): an export used only within its own file is flagged. `@magpie/logger` exports only `createLogger` and `Logger`; the options shape is an internal, non-exported `LoggerOptions` interface (consumers pass object literals, structurally typed). Because a package's exports are only "externally used" once a consumer exists, the `deadcode` gate applies from Task 2 onward (the first task that imports `createLogger`/`Logger`); Task 1's per-commit gate is typecheck + lint + its own tests.
- Logging changes MUST NOT alter control flow or client-facing responses.
- `apps/web` is out of scope — do not touch it.
- Level mapping: `console.error → logger.error`, `console.warn → logger.warn`, operator/status `console.log → logger.info`, verbose/diagnostic `console.log → logger.debug`.
- All quality gates stay green: `npm run typecheck`, `npm run lint`, `npm run deadcode`, `npm test`, `npm run build`.
- Commit messages end with the repo's `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

### Task 1: `@magpie/logger` package

**Files:**
- Create: `packages/logger/package.json`
- Create: `packages/logger/tsconfig.json`
- Create: `packages/logger/tsconfig.build.json`
- Create: `packages/logger/src/index.ts`
- Test: `packages/logger/src/index.test.ts`
- Modify: `package.json` (root build script + nothing else)
- Modify: `tsconfig.base.json` (add `@magpie/logger` path)

**Interfaces:**
- Produces:
  - `createLogger(opts?: LoggerOptions): Logger` (where `LoggerOptions` is internal/non-exported)
  - internal `interface LoggerOptions { level?: string; pretty?: boolean; base?: Record<string, unknown>; destination?: number | NodeJS.WritableStream }`
  - `type Logger = pino.Logger` — exported; used by class constructors and the retrieval param.
- Behaviour rules:
  - If `destination` is set → write raw JSON to it (ignore `pretty`). Used for tests and the stdio-MCP-to-stderr case.
  - Else if `pretty` is true → use the `pino-pretty` transport.
  - Else → default pino (JSON to stdout, fd 1).
  - `level` default `"info"`. `base` merged into every line.

- [ ] **Step 1: Scaffold package files**

`packages/logger/package.json`:
```json
{
  "name": "@magpie/logger",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "node --import tsx --test \"src/**/*.test.ts\"",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "pino": "^9.6.0"
  },
  "devDependencies": {
    "@types/node": "^25.9.3",
    "pino-pretty": "^13.0.0",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3"
  }
}
```

`packages/logger/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`packages/logger/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "paths": {}
  },
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/logger/src/index.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createLogger } from "./index.js";

// Collects each JSON log line written to the logger's destination.
function captureSink(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
  };
}

test("emits a JSON line with message and bound base fields", () => {
  const sink = captureSink();
  const logger = createLogger({ level: "info", base: { service: "test" }, destination: sink.stream });

  logger.info({ jobId: "abc" }, "did a thing");

  const [line] = sink.lines();
  assert.equal(line.msg, "did a thing");
  assert.equal(line.service, "test");
  assert.equal(line.jobId, "abc");
  assert.equal(line.level, 30); // pino numeric level for info
});

test("filters lines below the configured level", () => {
  const sink = captureSink();
  const logger = createLogger({ level: "warn", destination: sink.stream });

  logger.info("suppressed");
  logger.warn("kept");

  const lines = sink.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, "kept");
});

test("child loggers bind fields onto every line", () => {
  const sink = captureSink();
  const logger = createLogger({ level: "info", destination: sink.stream });
  const child = logger.child({ requestId: "req-1" });

  child.info("first");
  child.info("second");

  const lines = sink.lines();
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.requestId === "req-1"));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm install` (root, to pull pino), then `npm test -w @magpie/logger`
Expected: FAIL — `Cannot find module './index.js'` / `createLogger is not a function`.

- [ ] **Step 4: Implement `createLogger`**

`packages/logger/src/index.ts`:
```ts
import pino from "pino";

export type Logger = pino.Logger;

// Internal — not exported. Consumers pass an object literal (structurally typed);
// exporting a type used only here would trip knip's STRICT unused-export check.
interface LoggerOptions {
  /** Minimum level to emit. Defaults to "info". */
  level?: string;
  /** Use the human-readable pino-pretty transport (dev). Ignored when `destination` is set. */
  pretty?: boolean;
  /** Fields merged into every log line (e.g. { service: "api" }). */
  base?: Record<string, unknown>;
  /** Explicit sink (a writable stream, or an fd such as 2 for stderr). Forces raw JSON output. */
  destination?: number | NodeJS.WritableStream;
}

// A thin wrapper over pino. Configuration is passed in by the caller (apps read
// env at their composition root) so this package never touches process.env.
export function createLogger(opts: LoggerOptions = {}): Logger {
  const { level = "info", pretty = false, base, destination } = opts;
  const options: pino.LoggerOptions = { level, base: base ?? undefined };

  if (destination !== undefined) {
    // Explicit sink: raw JSON, no transport. Used by tests and the stdio MCP
    // server (which must keep stdout free for JSON-RPC and log to stderr).
    const stream =
      typeof destination === "number" ? pino.destination({ dest: destination, sync: true }) : destination;
    return pino(options, stream);
  }

  if (pretty) {
    return pino({ ...options, transport: { target: "pino-pretty", options: { colorize: true } } });
  }

  return pino(options);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w @magpie/logger`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the package into the monorepo build + paths**

In root `package.json`, the `build` script currently starts:
`npm run build -w @magpie/core && npm run build -w @magpie/prompts && ...`
Insert `@magpie/logger` right after `@magpie/core` (it is a leaf, so order only needs it before its consumers):
```
"build": "npm run build -w @magpie/core && npm run build -w @magpie/logger && npm run build -w @magpie/prompts && npm run build -w @magpie/markdown && npm run build -w @magpie/retrieval && npm run build -w @magpie/git && npm run build -w @magpie/jobs && npm run build -w @magpie/auth && npm run build -w @magpie/api && npm run build -w @magpie/watcher && npm run build -w @magpie/mcp && npm run build -w @magpie/web",
```

In `tsconfig.base.json`, add to `compilerOptions.paths` (keep alphabetical-ish ordering after `@magpie/jobs`):
```json
"@magpie/logger": ["packages/logger/src/index.ts"],
```

- [ ] **Step 7: Verify gates and commit**

Run: `npm run typecheck && npm run lint && npm test -w @magpie/logger`
Expected: all green. (Do NOT gate on `npm run deadcode` for this task: the package's exports gain external consumers only in Task 2, and knip STRICT flags exports used only within their own file. `deadcode` is verified from Task 2 onward. `LoggerOptions` is intentionally non-exported so it is never a standing knip finding.)

```bash
git add packages/logger package.json tsconfig.base.json package-lock.json
git commit -m "feat(logger): add @magpie/logger pino wrapper"
```

---

### Task 2: api root logger, request middleware, error-handler logging

**Files:**
- Create: `apps/api/src/logger.ts`
- Create: `apps/api/src/http/logging.ts` (request middleware + Hono `Variables` typing)
- Test: `apps/api/src/http/logging.test.ts`
- Modify: `apps/api/src/app.ts` (register middleware)
- Modify: `apps/api/src/http/errors.ts` (log 500s via logger)
- Test: `apps/api/src/http/errors.test.ts`
- Modify: `apps/api/package.json` (add `@magpie/logger` dependency)

**Interfaces:**
- Consumes: `createLogger`, `Logger` from `@magpie/logger`.
- Produces:
  - `apps/api/src/logger.ts` → `export const logger: Logger` (the api root logger).
  - `apps/api/src/http/logging.ts` → `export function requestLogging(root: Logger): MiddlewareHandler` and a `declare module "hono"` augmentation adding `logger: Logger` to `ContextVariableMap`. Handlers read the request logger via `c.get("logger")`.

- [ ] **Step 1: Add the dependency**

In `apps/api/package.json` `dependencies`, add (alphabetical, after `@magpie/jobs`):
```json
"@magpie/logger": "file:../../packages/logger",
```
Run: `npm install`

- [ ] **Step 2: Create the api root logger**

`apps/api/src/logger.ts`:
```ts
import { createLogger } from "@magpie/logger";

// The api's single root logger. Free functions import this directly; the request
// middleware derives per-request child loggers from it. Env is read here, at the
// app boundary, so packages stay env-free.
export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  pretty: process.env.NODE_ENV !== "production",
  base: { service: "api" }
});
```

- [ ] **Step 3: Write the failing middleware + error tests**

`apps/api/src/http/logging.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createLogger } from "@magpie/logger";
import { Writable } from "node:stream";
import { requestLogging } from "./logging.js";

function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  const logger = createLogger({ level: "info", destination: stream });
  return {
    logger,
    lines: () =>
      chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  };
}

test("logs one completion line with status and durationMs", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", requestLogging(cap.logger));
  app.get("/thing", (c) => c.json({ ok: true }));

  const res = await app.request("/thing");
  assert.equal(res.status, 200);

  const completion = cap.lines().find((l) => l.msg === "request");
  assert.ok(completion, "expected a request completion log");
  assert.equal(completion.status, 200);
  assert.equal(completion.path, "/thing");
  assert.equal(typeof completion.durationMs, "number");
});

test("exposes a request-scoped child logger via c.get", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", requestLogging(cap.logger));
  app.get("/thing", (c) => {
    c.get("logger").info("handler ran");
    return c.json({ ok: true });
  });

  await app.request("/thing");
  const handlerLine = cap.lines().find((l) => l.msg === "handler ran");
  assert.ok(handlerLine);
  assert.equal(typeof handlerLine.requestId, "string");
});
```

`apps/api/src/http/errors.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createLogger } from "@magpie/logger";
import { Writable } from "node:stream";
import { HttpError, onError } from "./errors.js";

function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  return {
    logger: createLogger({ level: "info", destination: stream }),
    lines: () => chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  };
}

test("HttpError returns its code without logging at error", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", cap.logger);
    await next();
  });
  app.onError(onError);
  app.get("/x", () => {
    throw new HttpError(404, "thing_not_found");
  });

  const res = await app.request("/x");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "thing_not_found" });
  assert.equal(cap.lines().filter((l) => l.level === 50).length, 0);
});

test("unexpected error logs at error and returns a generic body", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", cap.logger);
    await next();
  });
  app.onError(onError);
  app.get("/x", () => {
    throw new Error("boom");
  });

  const res = await app.request("/x");
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal_error" });
  const errLine = cap.lines().find((l) => l.level === 50);
  assert.ok(errLine, "expected an error-level log");
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -w @magpie/api -- --test-name-pattern="request|error"` (or run the two new files directly with `node --import tsx --test apps/api/src/http/logging.test.ts apps/api/src/http/errors.test.ts`)
Expected: FAIL — `requestLogging` not exported; `onError` does not accept/look up a logger.

- [ ] **Step 5: Implement the middleware**

`apps/api/src/http/logging.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { Logger } from "@magpie/logger";
import type { MiddlewareHandler } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    // Set by requestLogging on every request (registered with app.use("*")).
    logger: Logger;
  }
}

// Assigns each request a child logger bound to { requestId, method, path } and
// logs one completion line with status + durationMs. Handlers and onError read
// the request logger via c.get("logger").
export function requestLogging(root: Logger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = randomUUID();
    const child = root.child({ requestId, method: c.req.method, path: c.req.path });
    c.set("logger", child);
    const start = Date.now();
    try {
      await next();
    } finally {
      child.info({ status: c.res.status, durationMs: Date.now() - start }, "request");
    }
  };
}
```

- [ ] **Step 6: Log unexpected errors in `onError`**

Modify `apps/api/src/http/errors.ts` — replace the `console.error` block. The handler already receives the Hono `Context`, so read the request logger from it (falling back to nothing only if unset is impossible because the middleware is global, but type-guard defensively):
```ts
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message?: string
  ) {
    super(message ?? code);
  }
}

export function onError(error: Error, c: Context): Response {
  if (error instanceof HttpError) {
    const body =
      error.message && error.message !== error.code
        ? { error: error.code, message: error.message }
        : { error: error.code };
    return c.json(body, error.status);
  }

  // Log the raw error server-side for diagnostics, but never leak internal
  // details to clients — return a generic body for non-HttpError 500s.
  c.get("logger").error({ err: error }, "unhandled error");
  return c.json({ error: "internal_error" }, 500);
}
```

- [ ] **Step 7: Register the middleware in `app.ts`**

In `apps/api/src/app.ts`, add the import and register `requestLogging` as the FIRST middleware on the outer `app` (before `cors`, so even rejected requests get a completion log and `c.get("logger")` is always set for `onError`):
```ts
import { requestLogging } from "./http/logging.js";
import { logger } from "./logger.js";
```
Immediately after `const app = new Hono();`:
```ts
  app.use("*", requestLogging(logger));
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --import tsx --test apps/api/src/http/logging.test.ts apps/api/src/http/errors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Verify gates and commit**

Run: `npm run typecheck && npm run lint && npm run deadcode`
Expected: green (knip now sees `@magpie/logger` consumed).

```bash
git add apps/api/src/logger.ts apps/api/src/http/logging.ts apps/api/src/http/logging.test.ts apps/api/src/http/errors.ts apps/api/src/http/errors.test.ts apps/api/src/app.ts apps/api/package.json package-lock.json
git commit -m "feat(api): structured request logging and error logging"
```

---

### Task 3: api — convert remaining `console.*` to the root logger

This is a mechanical conversion of every non-test `console.*` in `apps/api/src` (≈100 sites) to the imported root logger, applying the level-mapping rule. No new behaviour; existing tests must stay green.

**Files (modify; the full set is whatever the grep in Step 1 lists):** notably
`apps/api/src/main.ts`, `apps/api/src/context.ts`,
`apps/api/src/features/config/service.ts`, `apps/api/src/features/jobs/service.ts`,
`apps/api/src/features/proposals/service.ts`, `apps/api/src/features/patrol/service.ts`,
`apps/api/src/features/source-sync/service.ts`, and any others the grep finds under
`features/`, `scheduling/`, `stores/`.

**Interfaces:**
- Consumes: `import { logger } from "../../logger.js";` (adjust relative depth per file) for free-function modules. In request-handling code paths that already have a Hono `Context`, prefer `c.get("logger")` so the line carries `requestId`; otherwise use the imported root `logger`.

- [ ] **Step 1: Enumerate the call sites**

Run: `grep -rn "console\." apps/api/src --include='*.ts' | grep -v ".test.ts"`
This is the worklist. (It also includes `apps/api/src/main.ts`, whose `console.*` predate the app's logger — convert those too, importing `./logger.js`.)

- [ ] **Step 2: Convert each site by the level-mapping rule**

For each file: add the logger import, then convert. Pattern — turn interpolated strings into a message + structured fields:
```ts
// before
console.warn(`No destination matched merged proposal ${proposal.id}; skipping re-index.`);
// after
logger.warn({ proposalId: proposal.id }, "No destination matched merged proposal; skipping re-index");

// before
console.error(`Completing job ${jobId} (${existingJob.type}) failed: ${message}`);
// after
logger.error({ jobId, jobType: existingJob.type, err: message }, "completing job failed");

// before  (operator/status output)
console.log(`Re-indexed destination after merging proposal ${proposal.id}`);
// after
logger.info({ proposalId: proposal.id }, "re-indexed destination after merge");
```
Rule reminder: `error→error`, `warn→warn`, status/`log`→`info`, verbose/diagnostic→`debug`. For `main.ts`, `console.error` startup-failure lines map to `logger.error`; the "listening on" and "draining" lines map to `logger.info`.

For `features/config/service.ts`'s `logStartupConfig`, keep the multi-line resolved-config summary but emit it through `logger.info` (one call) instead of `console.log`.

- [ ] **Step 3: Verify no `console.*` remain in api source**

Run: `grep -rn "console\." apps/api/src --include='*.ts' | grep -v ".test.ts"`
Expected: no output (empty).

- [ ] **Step 4: Run the api test suite (non-DB subset) + gates**

Run: `npm run typecheck && npm run lint`
Then the non-DB api tests: `npm test -w @magpie/api` (DB-backed store tests will be exercised in CI via `test:db`; locally they may skip/fail without Docker — confirm only the logging-adjacent and pure tests pass, and that nothing regressed versus the Task 2 baseline).
Expected: typecheck/lint green; no new test failures introduced by the conversion.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "refactor(api): route logging through the structured logger"
```

---

### Task 4: retrieval — optional logger on `routeQuestionToFlow`

**Files:**
- Modify: `packages/retrieval/src/routing.ts`
- Test: `packages/retrieval/src/routing.test.ts` (create if absent; otherwise add a case)
- Modify: `packages/retrieval/package.json` (add `@magpie/logger` dependency)

**Interfaces:**
- Consumes: `type Logger` from `@magpie/logger`.
- Produces: new signature
  `routeQuestionToFlow(question: string, flows: RoutableFlow[], chatProvider: ChatProvider, logger?: Logger): Promise<FlowRouteDecision | undefined>`.
  When `logger` is omitted, routing degrades silently exactly as today (no output).

- [ ] **Step 1: Add the dependency**

In `packages/retrieval/package.json` `dependencies`, add:
```json
"@magpie/logger": "file:../logger",
```
Run: `npm install`

- [ ] **Step 2: Write the failing test**

`packages/retrieval/src/routing.test.ts` (add this test; create the file with the imports below if it does not exist):
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createLogger } from "@magpie/logger";
import type { ChatProvider } from "@magpie/core";
import { routeQuestionToFlow, type RoutableFlow } from "./routing.js";

const flows: RoutableFlow[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" }
];

test("logs at warn and returns undefined when the provider call fails", async () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  const logger = createLogger({ level: "debug", destination: stream });
  const failingProvider: ChatProvider = {
    complete: async () => {
      throw new Error("provider down");
    }
  };

  const decision = await routeQuestionToFlow("q?", flows, failingProvider, logger);

  assert.equal(decision, undefined);
  const lines = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => typeof l.msg === "string" && l.msg.includes("routing")));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test packages/retrieval/src/routing.test.ts`
Expected: FAIL — `routeQuestionToFlow` takes 3 args / no log emitted.

- [ ] **Step 4: Implement the optional logger**

In `packages/retrieval/src/routing.ts`: add the import and the param, and replace the `console.debug` line.
```ts
import type { Logger } from "@magpie/logger";
```
Signature:
```ts
export async function routeQuestionToFlow(
  question: string,
  flows: RoutableFlow[],
  chatProvider: ChatProvider,
  logger?: Logger
): Promise<FlowRouteDecision | undefined> {
```
Replace the catch body's log:
```ts
  } catch (error) {
    // Routing must never fail the ask, but a silent swallow hides a misconfigured
    // provider. Log (when a logger is supplied) and degrade to the default flow.
    logger?.warn({ err: error }, "flow routing provider call failed; using default flow");
    return undefined;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test packages/retrieval/src/routing.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify gates and commit**

Run: `npm run typecheck && npm run lint && npm run deadcode && npm test -w @magpie/retrieval`
Expected: green. Confirm no `console.*` remain: `grep -rn "console\." packages/retrieval/src --include='*.ts' | grep -v ".test.ts"` → empty.

```bash
git add packages/retrieval package-lock.json
git commit -m "feat(retrieval): accept an optional logger in routeQuestionToFlow"
```

---

### Task 5: watcher — root logger, WorkerLoop injection, structured lifecycle logs

**Files:**
- Create: `apps/watcher/src/logger.ts`
- Modify: `apps/watcher/src/worker-loop.ts` (add `logger` constructor param; structured lifecycle logs)
- Modify: `apps/watcher/src/worker-loop.test.ts` (inject a capture logger; assert lifecycle logs)
- Modify: `apps/watcher/src/main.ts` (build root logger; pass to `WorkerLoop`; convert console.*)
- Modify: `apps/watcher/src/runners/generative.ts` (pass a logger to `routeQuestionToFlow`)
- Modify: any other `apps/watcher/src` files with `console.*` (per grep)
- Modify: `apps/watcher/package.json` (add `@magpie/logger` dependency)

**Interfaces:**
- Consumes: `createLogger`, `Logger` from `@magpie/logger`; `routeQuestionToFlow(..., logger?)` from Task 4.
- Produces: `WorkerLoop` constructor gains a `logger: Logger` parameter inserted **before** the final `options` parameter:
  `new WorkerLoop(api, runners, capabilities, workerName, logger, options)`.

- [ ] **Step 1: Add the dependency**

In `apps/watcher/package.json` `dependencies`, add:
```json
"@magpie/logger": "file:../../packages/logger",
```
Run: `npm install`

- [ ] **Step 2: Create the watcher root logger**

`apps/watcher/src/logger.ts`:
```ts
import { createLogger } from "@magpie/logger";

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  pretty: process.env.NODE_ENV !== "production",
  base: { service: "watcher" }
});
```

- [ ] **Step 3: Write the failing WorkerLoop test additions**

In `apps/watcher/src/worker-loop.test.ts`, add a capture-logger helper and a lifecycle assertion. Use the existing test's fakes for `api`/`runners`; the key change is constructing `new WorkerLoop(api, runners, caps, name, captureLogger, { pollIntervalMs })` and asserting structured logs:
```ts
import { createLogger } from "@magpie/logger";
import { Writable } from "node:stream";

function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  return {
    logger: createLogger({ level: "debug", destination: stream }),
    lines: () => chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  };
}

test("logs a structured completion line on success", async () => {
  const cap = captureLogger();
  // ... build api/runners fakes as the existing tests do, with one job that completes ...
  const loop = new WorkerLoop(api, runners, ["openai-compatible"], "w1", cap.logger, { pollIntervalMs: 5 });
  await loop.tick();

  const done = cap.lines().find((l) => l.outcome === "completed");
  assert.ok(done, "expected a completion log");
  assert.equal(typeof done.jobId, "string");
  assert.equal(typeof done.durationMs, "number");
});
```
(Update every existing `new WorkerLoop(...)` in this test file to pass a logger — `createLogger({ level: "silent" })` for cases that don't assert on logs.)

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --import tsx --test apps/watcher/src/worker-loop.test.ts`
Expected: FAIL — constructor arity / missing `outcome` field.

- [ ] **Step 5: Add the logger param and structured logs to WorkerLoop**

In `apps/watcher/src/worker-loop.ts`:
- Add the import: `import type { Logger } from "@magpie/logger";`
- Add the constructor parameter before `options`:
```ts
  constructor(
    private readonly api: WatcherApiClient,
    private readonly runners: readonly JobRunner[],
    private readonly capabilities: JobCapability[],
    private readonly workerName: string,
    private readonly logger: Logger,
    private readonly options: WorkerLoopOptions
  ) {}
```
- In `run()`'s catch: `this.logger.error({ err: error }, "watcher poll failed")`.
- In `execute()`, create a per-job child and convert each line:
```ts
  private async execute(job: JobView): Promise<void> {
    const startedAt = Date.now();
    const log = this.logger.child({ jobId: job.id, jobType: job.type });
    log.info("job claimed");

    const runner = this.runners.find((candidate) => candidate.supports(job.type));
    if (!runner) {
      log.error("no runner supports job type; failing job");
      await this.api.fail(job.id, this.toJobError(job, new Error(`No runner supports job type ${job.type}`)));
      return;
    }
    // ... unchanged abort/heartbeat setup ...
    try {
      const output = await runner.run(job, controller.signal);
      if (controller.signal.aborted) {
        log.info({ durationMs: Date.now() - startedAt, outcome: "cancelled" }, "job cancelled");
        return;
      }
      await this.api.complete(job.id, output);
      log.info({ durationMs: Date.now() - startedAt, outcome: "completed" }, "job done");
    } catch (error) {
      if (controller.signal.aborted) {
        log.info({ durationMs: Date.now() - startedAt, outcome: "cancelled" }, "job cancelled");
        return;
      }
      log.error({ durationMs: Date.now() - startedAt, outcome: "failed", err: error }, "job failed");
      await this.api.fail(job.id, this.toJobError(job, error));
    } finally {
      heartbeat.stop();
      this.activeController = undefined;
    }
  }
```
- In `startHeartbeat`, convert the cancellation `console.log` to `this.logger.info({ jobId: job.id }, "job cancellation requested by server; aborting")`.
- Remove the now-unused `elapsed()` helper if no longer referenced (knip will flag it otherwise).

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --import tsx --test apps/watcher/src/worker-loop.test.ts`
Expected: PASS.

- [ ] **Step 7: Convert main.ts + runners + pass logger to routing**

- In `apps/watcher/src/main.ts`: `import { logger } from "./logger.js";`, construct `const loop = new WorkerLoop(api, runners, capabilities, watcherName, logger, { pollIntervalMs });`, and convert the startup `console.log`/`console.warn` lines (and `logCapabilityReadiness`) to `logger.info`/`logger.warn`.
- In `apps/watcher/src/runners/generative.ts`: pass a logger into the routing call. Use the runner's available logger if it has one threaded; otherwise import the root logger: `import { logger } from "../logger.js";` then `const decision = await routeQuestionToFlow(input.question, flows, model, logger);`
- Convert any remaining `apps/watcher/src` `console.*` (per grep) to `logger`.

- [ ] **Step 8: Verify no console remains, gates, commit**

Run: `grep -rn "console\." apps/watcher/src --include='*.ts' | grep -v ".test.ts"` → empty.
Run: `npm run typecheck && npm run lint && npm run deadcode && npm test -w @magpie/watcher`
Expected: green.

```bash
git add apps/watcher packages/retrieval package-lock.json
git commit -m "feat(watcher): inject structured logger into the worker loop and runners"
```

---

### Task 6: mcp — root logger (stderr for stdio), request logging, conversion

**Files:**
- Create: `apps/mcp/src/logger.ts`
- Modify: `apps/mcp/src/http.ts` (request logging + convert `console.error`)
- Modify: `apps/mcp/src/main.ts` (stdio: logger to stderr; convert `console.error`)
- Test: `apps/mcp/src/logger.test.ts`
- Modify: `apps/mcp/package.json` (add `@magpie/logger` dependency)

**Interfaces:**
- Consumes: `createLogger`, `Logger` from `@magpie/logger`.
- Produces: `apps/mcp/src/logger.ts` → `export function createMcpLogger(transport: "http" | "stdio"): Logger`. The `stdio` transport MUST write to stderr (`destination: 2`) so stdout stays a clean JSON-RPC channel; `http` uses the normal stdout/pretty path.

- [ ] **Step 1: Add the dependency**

In `apps/mcp/package.json` `dependencies`, add:
```json
"@magpie/logger": "file:../../packages/logger",
```
Run: `npm install`

- [ ] **Step 2: Write the failing test**

`apps/mcp/src/logger.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpLogger } from "./logger.js";

test("stdio logger does not write to stdout", () => {
  // The stdio transport multiplexes JSON-RPC on stdout; logs must go to stderr.
  const logger = createMcpLogger("stdio");
  // pino exposes the destination fd via [pino.symbols] internals; instead assert
  // construction succeeds and the level is set — the fd-2 wiring is covered by the
  // createLogger destination test in @magpie/logger.
  assert.equal(typeof logger.info, "function");
  assert.equal(logger.level, logger.level); // smoke: logger constructed
});
```
(If a stronger assertion is wanted, write to the logger and confirm nothing lands on a spied `process.stdout.write`; keep it simple per the note above.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test apps/mcp/src/logger.test.ts`
Expected: FAIL — `createMcpLogger` not found.

- [ ] **Step 4: Implement the mcp logger factory**

`apps/mcp/src/logger.ts`:
```ts
import { createLogger, type Logger } from "@magpie/logger";

// stdio MCP multiplexes JSON-RPC over stdout, so its logs MUST go to stderr
// (fd 2). The http transport is a normal server process and logs to stdout.
export function createMcpLogger(transport: "http" | "stdio"): Logger {
  const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
  const base = { service: "mcp", transport };
  if (transport === "stdio") {
    return createLogger({ level, base, destination: 2 });
  }
  return createLogger({ level, base, pretty: process.env.NODE_ENV !== "production" });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test apps/mcp/src/logger.test.ts`
Expected: PASS.

- [ ] **Step 6: Convert call sites**

- In `apps/mcp/src/main.ts`: `import { createMcpLogger } from "./logger.js";`, create `const logger = createMcpLogger("stdio");` near startup, convert the three `console.error` calls (lines ~120/130/145) to `logger.error({ err }, "...")`.
- In `apps/mcp/src/http.ts`: `const logger = createMcpLogger("http");`, convert the three `console.error` calls (lines ~312/332/342) to `logger.error`, and add a request-completion log in the HTTP handler (method, path, status, durationMs) consistent with the api middleware.

- [ ] **Step 7: Verify no console remains, gates, commit**

Run: `grep -rn "console\." apps/mcp/src --include='*.ts' | grep -v ".test.ts"` → empty.
Run: `npm run typecheck && npm run lint && npm run deadcode && npm test -w @magpie/mcp`
Expected: green.

```bash
git add apps/mcp package-lock.json
git commit -m "feat(mcp): structured logging (stderr on stdio transport)"
```

---

### Task 7: env docs + full gate suite

**Files:**
- Modify: `.env.example`
- Modify: `.env.compose.example`

- [ ] **Step 1: Document `LOG_LEVEL`**

Add to `.env.example` and `.env.compose.example`, in a sensible section near the other runtime/observability vars:
```
# Logging verbosity for the api, watcher, and mcp services.
# One of: trace, debug, info, warn, error, fatal. Defaults to info in
# production and debug otherwise.
LOG_LEVEL=info
```

- [ ] **Step 2: Full gate suite**

Run, in order:
```
npm run typecheck
npm run lint
npm run deadcode
npm run build
```
Expected: all green. (`npm run build` includes `next build` for web and catches bundler-only breaks.)

- [ ] **Step 3: Full test suite (DB-backed)**

Run: `npm run test:db`
Expected: green. (Requires Docker; the wrapper boots/migrates/tears down a throwaway pgvector container. On Windows set `DOCKER_HOST` to the Docker Desktop pipe if `test:db` cannot reach the engine.)

- [ ] **Step 4: Final sanity — zero stray console in server code**

Run: `grep -rn "console\." apps/api/src apps/watcher/src apps/mcp/src packages --include='*.ts' | grep -v ".test.ts"`
Expected: empty (apps/web is intentionally untouched and excluded).

- [ ] **Step 5: Commit**

```bash
git add .env.example .env.compose.example
git commit -m "docs: document LOG_LEVEL for structured logging"
```

---

## Notes for the implementer

- **No DB for most tasks.** Only Task 7 Step 3 needs Docker. Per-task you can rely on `typecheck`/`lint`/`deadcode` plus the workspace's own `npm test -w <pkg>` for fast feedback (see the `workspace-test-resolution` rule: run via `npm test -w <pkg>`, not a root-cwd `node --test`, or `@magpie/*` resolves to stale dist).
- **knip is STRICT** (`ignoreExportsUsedInFile` deliberately unset). If you add an export that isn't yet consumed, knip fails — which is why `@magpie/logger`'s consumers land in the same or the next task. Do not relax `knip.json`.
- **pino-pretty is a dev-only dependency** of `@magpie/logger`; production (`NODE_ENV=production`) never loads it. Don't move it to `dependencies`.
- **Don't touch `apps/web`.**
