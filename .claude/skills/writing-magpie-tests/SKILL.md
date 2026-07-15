---
name: writing-magpie-tests
description: Write and run tests in Markdown Magpie — node:test conventions, colocated unit tests, Postgres-backed integration tests gated by RUN_PG_INTEGRATION and run via the throwaway-container harness, the queue e2e/eval scripts, and deterministic provider fixtures. Use when adding tests, deciding unit vs integration, or figuring out how to run DB-backed tests.
---

# Writing tests in Markdown Magpie

Tests use the **Node.js built-in test runner (`node:test`)** — no Jest, no Vitest, no Mocha.
Don't reach for another framework or add one. Test files are `*.test.ts` (run via `tsx`) or
`*.test.mjs`, **colocated with the source** they cover.

## The standard shape (unit tests)

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thingUnderTest } from "./index.js";   // NodeNext: import the .js specifier

describe("thingUnderTest", () => {
  it("does the expected thing", () => {
    assert.equal(thingUnderTest(input), expected);
  });
});
```

- `import ... from "node:test"` and `node:assert/strict` — always the strict assert.
- Import siblings with the **`.js` extension** even from `.ts` (ESM/NodeNext).
- In-process and fast: no DB, no network, no real provider. This is the default — most logic
  (schemas, catalog routing, markdown parsing, prompt building) should be unit-tested.

Run them:
```bash
npm test                       # all workspaces (npm run test --workspaces --if-present)
npm test -w @magpie/jobs       # one workspace
```

## Web component tests (apps/web)

Two harnesses in `apps/web/src/test`, both under `node:test`:

- **`renderMarkup`** (`render.tsx`) — `renderToStaticMarkup` inside the app's ThemeProvider.
  Default for "does it render the right markup" assertions. Effects **never run** here.
- **`renderDom` / `changeValue` / `click`** (`dom.tsx`) — mounts for real via
  `react-dom/client` on a happy-dom document (registered by `@happy-dom/global-registrator`),
  wrapped in `act`. Use when the behaviour only exists across renders: effects, polling,
  state persistence through prop-identity changes. `rerender` simulates a parent (e.g. the
  ConsoleProvider poll tick) handing down fresh callback identities — panels must not treat
  that as a data change and reset UI state (the seed-panel collapse regression test is the
  model).

## Postgres-backed integration tests

Anything needing a real database is **gated by an env flag** so `npm test` stays fast and
DB-free, and **run through a throwaway container** so it never touches your dev DB.

- **Gate the test** so it's skipped unless explicitly requested:
  ```ts
  import { test } from "node:test";
  const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
  test("…", { skip: !runIntegration }, async (t) => { /* … */ });
  ```
- **Isolate schema per process** so concurrent runs don't collide — the broker integration
  test uses `const schema = \`pgboss_test_${process.pid}\``. Follow that pattern for anything
  creating tables. Use `t.before`/`t.beforeEach`/`t.after` to start/reset/tear down.
- **Run against a single-use database** with the DB harness — it boots a throwaway pgvector
  container, migrates it from scratch, runs the command, and tears it down:
  ```bash
  npm run test:db                 # scripts/test-db.mjs npm run test  (whole suite, migrated DB)
  npm run test:integration        # just the pg-boss broker lifecycle test
  ```
  `test:db` requires a **Docker daemon** (not a running Postgres) and a **pgvector image** —
  migration `0001` creates the `vector` extension, so a plain `postgres` image fails. Override
  with `TEST_POSTGRES_IMAGE` if needed. Model new DB tests on
  `apps/api/src/jobs/pg-boss-broker.integration.test.ts`.

## Queue end-to-end and answer-quality

These are Node scripts (run with `tsx`), not `node:test` files:

- `npm run eval:golden` (`scripts/eval-golden.ts`) — the **golden-question regression
  eval** (#241): boots fixture provider + API + watcher against the throwaway DB, asks the
  versioned golden set, scores routing/confidence/citations/groundedness/behaviour, and
  fails on any regression vs the committed baseline (`-- --update-baseline` to re-pin).
  Runs in CI on every PR. See `docs/golden-eval.md` before touching the answer pipeline.
- `npm run e2e:jobs` (`scripts/e2e-jobs.ts`) — drives the API + watcher through the full job
  lifecycle (enqueue → claim → execute → complete). Use to smoke-test queue wiring.
- `npm run eval:api` (`scripts/eval-api.ts`) — fixed answer-quality checks against a live API.
- **Deterministic provider fixtures:** `scripts/fixtures/openai-fixture.mjs` is an
  OpenAI-compatible stub giving repeatable responses — point the watcher's
  `OPENAI_COMPATIBLE_BASE_URL` at it instead of a real model so e2e runs are stable and free.
  `scripts/fixtures/golden-provider.mjs` is the golden eval's smarter sibling: it speaks the
  full answer_question protocol (routing / assess loop / grounding verification)
  deterministically from the request text.

## Choosing unit vs integration

- Pure logic, schema validation, routing, formatting → **unit** (colocated `.test.ts`, no gate).
- Real SQL / broker semantics / store queries / migrations applying → **integration**
  (`RUN_PG_INTEGRATION=1`, per-pid schema, run via `test:db`).
- Full queue path across API + watcher → **`e2e:jobs`**.

## Validate your changes (project rhythm)

Run frequently, not once at the end:
```bash
npm run build && npm test && npm run typecheck && npm run lint
npm run test:db           # when you touched SQL, stores, or the broker
```
`npm run deadcode` (knip) catches tests importing things that no longer exist.

## Gotchas

- **Don't add a test framework.** If a helper seems missing, it's usually a `node:test`
  feature (`t.mock`, subtests, `{ skip }`, `{ only }`) — use those.
- **Integration tests silently skip without the flag.** A green `npm test` does **not** mean
  DB tests ran; they only run under `RUN_PG_INTEGRATION=1` (which `test:db`/`test:integration`
  set for you). Don't assume coverage you didn't trigger.
- **Never point DB tests at your dev database.** Always go through `scripts/test-db.mjs`; it
  exists precisely so integration tests use an ephemeral container, not `.env`'s `DATABASE_URL`.
- **`.js` import specifiers in tests too** — a bare `./foo` import fails under NodeNext.
- **`npm run -w @magpie/api typecheck` (per-workspace) can fail with TS6059** — a known
  pre-existing config quirk; the real gate is the root `npm run typecheck`.
- Broken local DB/container? See the **`magpie-local-troubleshooting`** skill.
