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
- `test-db.mjs` starts a throwaway pgvector Postgres container, runs migrations, then runs the command passed after it.
- `e2e-jobs.ts` drives the API and watcher through queue lifecycle smoke tests.
- `fixtures/openai-fixture.mjs` is the deterministic OpenAI-compatible chat fixture used by the E2E stack.

## Evaluation`r`n`r`n- `eval-api.ts` runs a few fixed API answer-quality checks against a live API.

## Presentation

- `shoot.mjs` renders all static UI screenshots used by the deck.
- `render-static-ui-shots.mjs` contains the screenshot renderer and fixture markup.
- `optimize-assets.py` downscales raw deck assets into `presentation/assets/opt`.
- `build-deck.mjs` assembles the self-contained HTML deck.
- `verify-deck.mjs` renders deck screenshots for visual inspection.
