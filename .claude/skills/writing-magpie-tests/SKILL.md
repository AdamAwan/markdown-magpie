---
name: writing-magpie-tests
description: Write and run tests in Markdown Magpie — node:test conventions, colocated unit tests, Postgres-backed integration tests gated by RUN_PG_INTEGRATION and run via the single-use-database harness (Docker or an existing Postgres), the queue e2e/eval scripts, and deterministic provider fixtures. Use when adding tests, deciding unit vs integration, or figuring out how to run DB-backed tests.
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
  model). `changeValue` works on selects, inputs and textareas; `buttonByText` /
  `buttonsByText` find buttons by label.

Supporting pieces, same directory:

- **`fakeApi.ts`** — `installFakeApi({ "GET /jobs": () => ({ jobs: [] }) })` replaces
  `globalThis.fetch` with a route table (`"METHOD /path"`, no `/api` prefix or query
  string), so `lib/api` runs unmodified. Throw `FakeApiError(status, message)` from a
  handler for an error response; an unrouted request answers 404 naming the route.
  `deferred()` holds a route open to test races.
- **`console.tsx`** — `mountConsole({ routes, ui })` mounts the real `ConsoleProvider`
  over the fake API with a fake Next router and **mocked `setTimeout`/`setInterval`**.
  Read state/actions with `m.console()`, drive actions with `m.run(...)`, and advance
  polls / toast expiry / the search debounce with `m.tick(ms)`. Pass a page component
  as `ui` to test provider + page + panel together (`ConsoleProvider.test.tsx` is the
  model). Always `t.after(() => m.unmount())` — it restores fetch and the timers.
- **`fixtures.ts`** — typed builders (`jobFixture`, `questionFixture`, `documentFixture`,
  `configFixture`, …). Extend these rather than hand-rolling objects per test file.

Two traps the harness exists to avoid:

- **Any test file whose components call `lib/api` under happy-dom needs
  `after(closeDom)`.** Each request arms happy-dom's `AbortSignal.timeout(30s)`, a ref'd
  timer that otherwise holds the test process open for 30 seconds after the last test.
- **Never import `react-dom/client` statically in test code.** It decides at module load
  whether a DOM exists; loaded before happy-dom registers, it silently ignores typed
  edits to text fields. `renderDom` imports it lazily for this reason.

## Browser smoke tests (apps/web, Playwright)

`apps/web/e2e/*.spec.ts` is a small Playwright suite that drives the built console in
Chromium with the API mocked in the browser (`e2e/mockApi.ts`, via `page.route`) — no
Postgres, API or watcher. It is the **one exception** to "no other framework", and it is
**not** part of `npm test` or CI:

```bash
npm run test:e2e:web             # build libs + web, then run the suite (trace off)
npm run test:e2e -w @magpie/web  # re-run against the existing build
```

Keep it a smoke suite (load, navigation, one end-to-end ask): logic belongs in the
`node:test` component tests above. A page that starts calling a new endpoint must get a
default response in `mockApi.ts` — unmocked requests fail the spec. `@playwright/test` is
pinned exactly to match one Chromium build; set `E2E_CHROMIUM_PATH` to use a different
binary. See `docs/web-testing.md`.

## Postgres-backed integration tests

Anything needing a real database is **gated by an env flag** so `npm test` stays fast and
DB-free, and **run against a single-use database** so it never touches your dev DB.

- **Gate the test** so it's skipped unless explicitly requested:
  ```ts
  import { test } from "node:test";
  const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
  test("…", { skip: !runIntegration }, async (t) => { /* … */ });
  ```
- **Isolate schema per process** so concurrent runs don't collide — the broker integration
  test uses `const schema = \`pgboss_test_${process.pid}\``. Follow that pattern for anything
  creating tables. Use `t.before`/`t.beforeEach`/`t.after` to start/reset/tear down.
- **Run against a single-use database** with the DB harness (`scripts/test-db.mjs`) — it
  provides a freshly migrated database, runs the command with `DATABASE_URL` pointed at it
  **and `RUN_PG_INTEGRATION=1` set**, then throws the database away:
  ```bash
  npm run test:db                 # scripts/test-db.mjs npm run test  (whole suite, migrated DB)
  npm run test:integration        # just the pg-boss broker lifecycle test, same harness
  ```
  By default it boots a throwaway **pgvector container** (needs a Docker daemon; override the
  image with `TEST_POSTGRES_IMAGE`). **Without Docker**, point it at any Postgres that has
  pgvector installed and it creates/migrates/drops a `magpie_test_<pid>_<random>` database
  there per run (this is what CI does, on a `pgvector/pgvector:pg16` service container):
  ```bash
  TEST_DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:db
  ```
  pgvector is required either way — migration `0001` creates the `vector` extension (on
  Ubuntu: `apt-get install postgresql-16-pgvector`). Model new DB tests on
  `apps/api/src/jobs/pg-boss-broker.integration.test.ts`.
- **Isolate from concurrent files.** `node --test` runs a workspace's test files in parallel
  processes on the SAME database, so an integration test must not assert on unscoped global
  counts: scope rows to a per-pid flow/id, or give pg-boss-shaped fixtures their own schema
  (the insights and queue-stats integration tests show both). Compare timestamps against a
  window end strictly after your inserts — a JS `new Date()` is millisecond-truncated and
  can land before a Postgres `now()` stamp from the same millisecond.

## Queue end-to-end and answer-quality

These are Node scripts (run with `tsx`), not `node:test` files:

- `npm run eval:golden` (`scripts/eval-golden.ts`) — the **golden-question regression
  eval** (#241): boots fixture provider + API + watcher against the throwaway DB, asks the
  versioned golden set, scores routing/confidence/citations/groundedness/behaviour, and
  fails on any regression vs the committed baseline (`-- --update-baseline` to re-pin).
  Runs in CI on every PR. See `docs/golden-eval.md` before touching the answer pipeline.
- `npm run e2e:jobs` (`scripts/e2e-jobs.ts`) — drives a running API + watcher through the
  full job lifecycle (answer, cancel in flight, retry → permanent fail, job/schedule
  listing). `npm run e2e:jobs:local` (`scripts/e2e-jobs-local.ts`) boots that stack itself —
  `openai-fixture.mjs` + API + watcher as Node processes on a `test-db.mjs` database — and is
  what CI's **Queue E2E** job runs (~3.5 min, mostly the retry scenario's real backoff; logs
  in `.magpie/e2e-jobs/`).
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
- Full queue path across API + watcher → **`e2e:jobs`** (`e2e:jobs:local` self-contained).

## Validate your changes (project rhythm)

Run frequently, not once at the end:
```bash
npm run build && npm test && npm run typecheck && npm run lint
npm run test:db           # when you touched SQL, stores, or the broker
```
`npm run deadcode` (knip) catches tests importing things that no longer exist.

## Gotchas

- **Job outputs are validated strictly in tests.** `makeTestContext()` sets
  `MAGPIE_JOB_OUTPUT_STRICT=true` and every watcher runner you construct defaults to the
  strict policy, so a fixture output (or canned model reply) carrying a field the job's
  schema does not declare fails the job / throws — production would have silently stripped
  it. Declare the field on the schema; only a test *about* the lenient production policy
  should opt out (`settings.jobs.undeclaredOutputFields: "strip"` /
  `{ undeclaredOutputFields: "strip" }`). The golden eval and the e2e compose stack run
  strict too.
- **Don't add a test framework.** If a helper seems missing, it's usually a `node:test`
  feature (`t.mock`, subtests, `{ skip }`, `{ only }`) — use those.
- **Integration tests silently skip without the flag.** A green `npm test` does **not** mean
  DB tests ran; they only run under `RUN_PG_INTEGRATION=1` (which `test:db`/`test:integration`
  set for you, and CI's Test job runs). Don't assume coverage you didn't trigger.
- **Never point DB tests at your dev database.** Always go through `scripts/test-db.mjs`; it
  exists precisely so integration tests use an ephemeral container, not `.env`'s `DATABASE_URL`.
- **`.js` import specifiers in tests too** — a bare `./foo` import fails under NodeNext.
- **`npm run -w @magpie/api typecheck` (per-workspace) can fail with TS6059** — a known
  pre-existing config quirk; the real gate is the root `npm run typecheck`.
- Broken local DB/container? See the **`magpie-local-troubleshooting`** skill.
