---
name: write-a-migration
description: Write a database migration for Markdown Magpie's custom SQL migrator (packages/db/migrations, applied by scripts/migrate.mjs). Use when adding, altering, or backfilling a Postgres table/column/index/constraint — covers the NNNN_ naming rule, prefix-uniqueness guard, append-only/no-rollback model, and how migrations get applied and tested.
---

# Writing a database migration

Migrations are **plain `.sql` files in `packages/db/migrations/`**, applied by a bespoke
Node migrator (`scripts/migrate.mjs`) — there is no ORM/migration framework. The model has a
few hard rules that aren't obvious; get them right and the migrator does the rest.

## How the migrator works (so the rules make sense)

`scripts/migrate.mjs`:
1. Reads every `*.sql` in the dir and **sorts by full filename** — so the numeric prefix is
   the *only* signal of apply order.
2. Runs `assertMigrationPrefixesUnique` (`scripts/lib/migration-order.mjs`) which **fails fast**
   if any name is malformed or a *new* duplicate prefix appears.
3. Takes a fixed Postgres **advisory lock** (`7264531`) so concurrent migrators serialize.
4. For each file not already in the `schema_migrations` table, runs it **inside a single
   transaction** and records the filename. Applied files are tracked **by full filename**.

## Rules

- **Name it `NNNN_snake_case_description.sql`.** Four-digit zero-padded sequence prefix, then
  `_`, then a description, then `.sql`. The regex is `/^(\d+)_.+\.sql$/`; anything else fails
  the guard before the DB is touched.
- **Use the next unused prefix.** Find it with `ls packages/db/migrations/ | tail`. Do **not**
  reuse or collide with an existing prefix — new duplicates are rejected. (A handful of
  historical collisions — `0006 0027 0028 0034` — are grandfathered in
  `GRANDFATHERED_DUPLICATE_PREFIXES`; **never add to that set.**)
- **Migrations are append-only and forward-only.** There are **no down-migrations** and no
  automated rollback. Never edit or rename a migration that may already be applied anywhere —
  because tracking is by filename, renaming an applied file makes the migrator treat it as new
  and **re-run it**. To change something already shipped, write a *new* migration.
- **Make it re-runnable-safe and additive where possible.** Prefer `IF NOT EXISTS` /
  `IF EXISTS`, `ADD COLUMN ... DEFAULT`, and `DROP CONSTRAINT IF EXISTS` before re-adding a
  widened `CHECK` (see `0035_followup_gap_source.sql` for the constraint-widen pattern).
  Existing rows must survive — backfill explicitly rather than assuming NULLs are fine.
- **One migration = one coherent change**, wrapped implicitly in the migrator's transaction
  (don't add your own `BEGIN`/`COMMIT` — the migrator owns the transaction). Keep a top
  comment explaining *why*, like the existing files do.

## Write it

```bash
# 1. next prefix
ls packages/db/migrations/ | tail
# 2. create packages/db/migrations/00NN_describe_change.sql  (leading comment + SQL)
# 3. apply against your local dev DB (reads DATABASE_URL from .env)
node scripts/migrate.mjs      # or: npm run db:migrate
```

The migrator prints `Applying 00NN_…` then `Database migrations complete`. Re-running is a
no-op (`Skipping …`) — that's how you confirm it recorded.

## Validate

```bash
node --test scripts/lib/migration-order.test.mjs   # the naming/ordering guard
npm run test:db                                    # boots a throwaway pgvector container,
                                                   # runs ALL migrations, then the suite
```

`npm run test:db` (`scripts/test-db.mjs`) migrates a single-use container from scratch, so it
proves your migration applies on a clean database and doesn't break the suite — run it before
pushing. If a store's queries change, update its tests too (see **`writing-magpie-tests`**).

## Gotchas

- **The prefix — not the description — orders migrations.** A file sorting earlier than a
  table it depends on will fail on a fresh DB even if it "looks" later. Use the next sequential
  number.
- **Renaming an applied migration re-runs it.** Tracking is by filename. If you must fix a
  typo in a name that's only ever run locally, reset your dev DB; never rename one that's
  shipped.
- **The `vector` extension is required.** `0001` creates it; `test-db.mjs` therefore needs a
  pgvector image (`pgvector/pgvector:pg16`, overridable via `TEST_POSTGRES_IMAGE`). A plain
  `postgres` image will fail the migrate step.
- **`DATABASE_URL` is required.** The migrator loads `.env` (without overriding shell vars)
  and throws if it's unset. For a local run see the **`run-magpie`** skill.
- **No schema.sql to edit.** The cumulative schema *is* the ordered set of migrations — don't
  look for a single canonical DDL file.
