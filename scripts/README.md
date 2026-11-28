# Scripts

Small repo-level helpers live here. Prefer adding an npm script in the root `package.json` when a command is part of the regular developer workflow.

## Database and Tests

- `migrate.mjs` applies SQL migrations from `packages/db/migrations` to `DATABASE_URL`.
  - Migrations are applied in filename order and tracked by full filename, so the
    numeric prefix (`NNNN_description.sql`) is the only signal of intended order.
    New migrations must use a **unique, sequential** prefix — `migrate.mjs` fails
    fast (before touching the database) if two files share a prefix or a name is
    malformed. A handful of historical collisions predate this rule and are
    grandfathered in `lib/migration-order.mjs`; don't add to that list, and don't
    renumber already-applied migrations (that makes the migrator re-run them).
- `lib/migration-order.mjs` is the pure prefix-uniqueness guard used by
  `migrate.mjs`; `lib/migration-order.test.mjs` covers it (`npm run test:scripts`).
- `test-db.mjs` provides a single-use, freshly migrated database and runs the command passed
  after it with `DATABASE_URL` pointed at it and `RUN_PG_INTEGRATION=1` set (so the gated
  `*.integration.test.ts` files run). By default it boots a throwaway pgvector container
  (needs Docker); with `TEST_DATABASE_ADMIN_URL` set to an admin connection on an existing
  pgvector-enabled Postgres it instead creates a `magpie_test_<pid>_<random>` database there
  and drops it afterwards (CI's service container, Docker-less machines). Pure helpers in
  `lib/test-db-target.mjs`.
- `e2e-jobs.ts` drives an already-running API + watcher through queue lifecycle smoke tests
  (`npm run e2e:jobs`, `E2E_API_BASE_URL` defaults to `http://localhost:4000`).
- `e2e-jobs-local.ts` boots that stack itself — chat fixture + API + watcher as Node
  processes against the `test-db.mjs` database — and runs `e2e-jobs.ts` against it
  (`npm run e2e:jobs:local`; CI's Queue E2E job). Logs land in `.magpie/e2e-jobs/`.
- `lib/local-stack.mjs` holds the child-process helpers (`launch`, `cleanEnv`, `freePort`,
  `waitFor`) shared by `e2e-jobs-local.ts` and `eval-golden.ts`.
- `fixtures/openai-fixture.mjs` is the deterministic OpenAI-compatible chat fixture used by the E2E stack.

## Evaluation

- `eval-golden.ts` is the golden-question regression eval (issue #241): boots the full
  answer pipeline self-contained against the throwaway DB, asks the versioned question set
  in `fixtures/golden-questions.json`, and fails on any regression vs
  `fixtures/golden-baseline.json`. Run with `npm run eval:golden`
  (`-- --update-baseline` to re-pin); see `docs/golden-eval.md`.
- `fixtures/golden-provider.mjs` + `lib/golden-core.mjs` are the deterministic provider it
  uses; `lib/golden-scoring.mjs` scores and compares to baseline; `fixtures/golden-kb/` is
  the fixture knowledge base.
- `eval-api.ts` runs a few fixed API answer-quality checks against a live API.
- `eval-gap-threshold.ts` sweeps gap-cluster assignment thresholds over fixture embeddings.

## Presentation

- `shoot.mjs` renders all static UI screenshots used by the deck.
- `render-static-ui-shots.mjs` contains the screenshot renderer and fixture markup.
- `optimize-assets.py` downscales raw deck assets into `presentation/assets/opt`.
- `build-deck.mjs` assembles the self-contained HTML deck.
- `verify-deck.mjs` renders deck screenshots for visual inspection.
