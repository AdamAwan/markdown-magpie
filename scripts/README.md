# Scripts

Small repo-level helpers live here. Prefer adding an npm script in the root `package.json` when a command is part of the regular developer workflow.

## Database and Tests

- `migrate.mjs` applies SQL migrations from `packages/db/migrations` to `DATABASE_URL`.
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
