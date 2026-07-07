# Agent Source Map Implementation Plan (#215)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every source-grounded AI job (draft_seed_document, draft_markdown_proposal, verify_document, correct_document, improve_document) a shared, per-source-repository "source map" — persistent navigation hints (topic → paths + one-line description) that agents read at the start of a job and contribute back to at the end, so each job stops re-exploring huge source repos from zero.

**Architecture:** A new `source_map_entries` Postgres table behind a store pair in `apps/api/src/stores/`, unique on (source_id, topic). Read path: the watcher fetches entries through a new watcher-scoped callback `GET /api/source-map?sourceIds=…` when it prepares source workspaces, and renders them into the source-grounded prompt as explicitly-unverified hints. Write path: the five source-grounded job outputs gain an optional `mapUpdates` array; the watcher stamps each update with the checkout HEAD sha it observed, and the API's completion dispatcher upserts them (capped, evicting oldest) as a best-effort side effect that can never fail the job. Map data is internal navigation metadata only — it never enters answer retrieval or user-facing output.

**Tech Stack:** TypeScript, Node ≥22.13, ESM/NodeNext, node:test, Zod, Hono, pg, npm workspaces (`@magpie/core`, `@magpie/jobs`, `@magpie/prompts`, `@magpie/api`, `@magpie/watcher`), custom SQL migrator (`packages/db/migrations` + `scripts/migrate.mjs`).

## Global Constraints

- **ESM/NodeNext:** every relative import needs an explicit `.js` extension, in tests too.
- **Never cast through `unknown` or `any`** to silence types. Narrow with `typeof` / `in` / Zod instead.
- **knip runs STRICT in CI** (`npm run deadcode`): every export must have a consumer outside its own file (tests count). Do not export helpers "for later" — tasks below are shaped so nothing lands unconsumed.
- **Queue-only model:** the watcher has no DB access. Everything it needs flows through the HTTP API (new endpoint) and job payloads (new output field). Never add an inline chat-provider call to the API.
- **Tests:** node:test + `node:assert/strict`, colocated. Run per-workspace via `npm test -w <pkg>` (root-cwd `node --test` resolves `@magpie/*` to stale dist). Postgres-backed store tests follow the existing postgres-store template: self-skip unless `DATABASE_URL` is set, use `makeTestPool`, assert only on ids/keys you created; run them via `npm run test:db` (throwaway pgvector container, migrates from scratch — this is how `RUN_PG_INTEGRATION`-style DB testing is done for stores in this repo).
- **Validate as you go:** after each task run `npm run build && npm test && npm run typecheck && npm run lint && npm run deadcode`; run `npm run test:db` for Task 1 (and any later task if you touch SQL). Commit at the end of every task.
- **Work in this worktree only** (`.worktrees/source-map`, branch `claude/source-map`); run all commands from its root.
- **Explicitly internal (design decision 5):** never wire source-map entries into `packages/retrieval`, the ask/answer path, or any user-facing response. The only consumers are the source-grounded prompt (watcher) and the two source-map API surfaces.
- **UK English** in docs and prompt text.

## File Structure

- `packages/core/src/index.ts`: `SourceMapEntry` (Task 1), `SourceMapUpdate` (Task 4), `mapUpdates?` on five job-output interfaces (Task 4).
- `packages/db/migrations/0046_source_map_entries.sql`: new table (Task 1).
- `apps/api/src/stores/source-map-store.ts` (+ `.test.ts`): interface + in-memory store (Task 1).
- `apps/api/src/stores/postgres-source-map-store.ts` (+ `.test.ts`): Postgres store (Task 1).
- `apps/api/src/platform/config.ts`, `apps/api/src/platform/stores.ts`, `apps/api/src/context.ts`, `apps/api/src/test-support/context.ts`, `apps/api/src/features/config/service.ts`: wiring (Task 1).
- `apps/api/src/features/source-map/routes.ts` (+ `.test.ts`), `apps/api/src/app.ts`: read endpoint (Task 2).
- `apps/watcher/src/http-client.ts`, `apps/watcher/src/source-workspace.ts` (+ `.test.ts`), `apps/watcher/src/job-prompts.ts` (+ `.test.ts`), `apps/watcher/src/runners/cli.ts`, `apps/watcher/src/runners/chat.ts`, `apps/watcher/src/runners/source-agent.ts`, watcher test fakes: read path + rendering (Task 3).
- `packages/jobs/src/schemas.ts` (+ `schemas.test.ts`): `mapUpdates` on five output schemas (Task 4).
- `apps/watcher/src/source-workspace.ts`, `apps/watcher/src/runners/cli.ts`, `apps/watcher/src/runners/chat.ts`: HEAD-sha capture + stamping (Task 5).
- `apps/api/src/features/source-map/service.ts` (+ `.test.ts`), `apps/api/src/features/jobs/service.ts`: write path (Task 6).
- `packages/prompts/src/catalog.ts` (+ `catalog.test.ts`): prompt text (Task 7).
- `docs/ai-jobs.md`, `docs/api.md`, `docs/architecture.md`: docs (Task 8).

> Note on task granularity: the shared `SourceMapEntry` type, the migration, the store pair, and the composition wiring land as ONE task. knip runs STRICT, so a types-only or store-only commit would fail `npm run deadcode` with unconsumed exports; Task 1 is the smallest knip-clean storage unit.

---

### Task 1: Source-map contract type, migration, store pair, and context wiring

**Files:**
- Modify: `packages/core/src/index.ts`
- Create: `packages/db/migrations/0046_source_map_entries.sql`
- Create: `apps/api/src/stores/source-map-store.ts`
- Create: `apps/api/src/stores/source-map-store.test.ts`
- Create: `apps/api/src/stores/postgres-source-map-store.ts`
- Create: `apps/api/src/stores/postgres-source-map-store.test.ts`
- Modify: `apps/api/src/platform/config.ts` (STORE_ENV_NAMES)
- Modify: `apps/api/src/platform/stores.ts`
- Modify: `apps/api/src/context.ts`
- Modify: `apps/api/src/test-support/context.ts`
- Modify: `apps/api/src/features/config/service.ts` (`resetData`)

**Interfaces produced (consumed by every later task):**

```ts
// @magpie/core
export interface SourceMapEntry {
  id: string;
  sourceId: string;
  topic: string;
  paths: string[];
  description: string;
  observedSha?: string;
  createdAt: string;   // ISO-8601
  updatedAt: string;   // ISO-8601
}

// apps/api/src/stores/source-map-store.ts
export interface SourceMapUpsert {
  sourceId: string;
  topic: string;
  paths: string[];
  description: string;
  observedSha?: string;
}
export interface SourceMapStore {
  listBySource(sourceId: string, limit: number): Promise<SourceMapEntry[]>; // most-recently-updated first
  upsert(update: SourceMapUpsert): Promise<SourceMapEntry>;                 // keyed on (sourceId, topic)
  pruneToLimit(sourceId: string, limit: number): Promise<number>;           // deletes oldest-updated beyond limit
  reset(): Promise<void>;
}
export class InMemorySourceMapStore implements SourceMapStore { /* … */ }

// apps/api/src/stores/postgres-source-map-store.ts
export class PostgresSourceMapStore implements SourceMapStore { constructor(pool: pg.Pool) }

// apps/api/src/platform/stores.ts
export function createSourceMapStore(config: AppConfig, pool: pg.Pool): InMemorySourceMapStore | PostgresSourceMapStore;

// apps/api/src/context.ts — AppContext.stores gains:
//   sourceMap: ReturnType<typeof createSourceMapStore>;
```

**Steps:**

- [ ] Add `SourceMapEntry` to `packages/core/src/index.ts` (near the other source-grounded types, around `SourceDescriptor`), exactly as in the Interfaces block above, with this doc comment:

  ```ts
  // One agent-maintained navigation hint for a source repository (#215): where a
  // topic lives, as concrete repo paths plus a one-line description. Internal
  // metadata for source-grounded job prompts — never knowledge-base content, and
  // never part of answer retrieval or user-facing output. observedSha is the
  // checkout HEAD the hint was observed at (stamped by the watcher when known);
  // staleness invalidation against source-change-sync is a follow-up.
  ```

- [ ] Create `packages/db/migrations/0046_source_map_entries.sql` (0045 is the current max on this branch — re-check with `ls packages/db/migrations/ | tail` before creating; if another branch merged a 0046 first, use the next free prefix and update references below):

  ```sql
  -- Source map (#215): persistent, agent-maintained navigation hints per source
  -- repository. Source-grounded jobs read the most-recently-updated entries as
  -- prompt hints and contribute updates back on completion. Internal metadata
  -- only — never enters answer retrieval. One row per (source_id, topic);
  -- observed_sha records the checkout HEAD a hint was observed at (nullable).
  CREATE TABLE IF NOT EXISTS source_map_entries (
    id UUID PRIMARY KEY,
    source_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    paths JSONB NOT NULL,
    description TEXT NOT NULL,
    observed_sha TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT source_map_entries_source_topic_unique UNIQUE (source_id, topic)
  );

  CREATE INDEX IF NOT EXISTS source_map_entries_source_updated_idx
    ON source_map_entries (source_id, updated_at DESC);
  ```

- [ ] Run `node --test scripts/lib/migration-order.test.mjs` — expect pass (naming guard accepts the new file).

- [ ] Write the failing unit test `apps/api/src/stores/source-map-store.test.ts`:

  ```ts
  import assert from "node:assert/strict";
  import { describe, it } from "node:test";
  import { InMemorySourceMapStore } from "./source-map-store.js";

  describe("InMemorySourceMapStore", () => {
    it("round-trips an entry through upsert and listBySource", async () => {
      const store = new InMemorySourceMapStore();
      const created = await store.upsert({
        sourceId: "s1",
        topic: "event system",
        paths: ["src/events/"],
        description: "Event bus and handlers live here",
        observedSha: "abc123"
      });
      assert.ok(created.id);
      assert.equal(created.createdAt, created.updatedAt);

      const entries = await store.listBySource("s1", 10);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].topic, "event system");
      assert.deepEqual(entries[0].paths, ["src/events/"]);
      assert.equal(entries[0].observedSha, "abc123");
    });

    it("replaces the entry for the same (sourceId, topic), keeping id and createdAt", async () => {
      const store = new InMemorySourceMapStore();
      const first = await store.upsert({ sourceId: "s1", topic: "t", paths: ["a/"], description: "old" });
      const second = await store.upsert({ sourceId: "s1", topic: "t", paths: ["b/"], description: "new" });
      assert.equal(second.id, first.id);
      assert.equal(second.createdAt, first.createdAt);
      assert.deepEqual(second.paths, ["b/"]);
      assert.equal(second.description, "new");
      assert.equal((await store.listBySource("s1", 10)).length, 1);
    });

    it("lists only the requested source, most-recently-updated first, capped by limit", async () => {
      const store = new InMemorySourceMapStore();
      await store.upsert({ sourceId: "s1", topic: "older", paths: ["a/"], description: "d" });
      await store.upsert({ sourceId: "s2", topic: "other-source", paths: ["x/"], description: "d" });
      await store.upsert({ sourceId: "s1", topic: "newer", paths: ["b/"], description: "d" });
      await store.upsert({ sourceId: "s1", topic: "older", paths: ["a2/"], description: "touched again" });

      const entries = await store.listBySource("s1", 1);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].topic, "older");
      assert.ok((await store.listBySource("s1", 10)).every((e) => e.sourceId === "s1"));
    });

    it("pruneToLimit evicts the oldest-updated entries beyond the cap", async () => {
      const store = new InMemorySourceMapStore();
      for (const topic of ["a", "b", "c"]) {
        await store.upsert({ sourceId: "s1", topic, paths: ["p/"], description: "d" });
        // Distinct updatedAt per entry so "oldest" is unambiguous.
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const evicted = await store.pruneToLimit("s1", 2);
      assert.equal(evicted, 1);
      const remaining = await store.listBySource("s1", 10);
      assert.deepEqual(remaining.map((e) => e.topic).sort(), ["b", "c"]);
    });

    it("reset removes everything", async () => {
      const store = new InMemorySourceMapStore();
      await store.upsert({ sourceId: "s1", topic: "t", paths: ["p/"], description: "d" });
      await store.reset();
      assert.deepEqual(await store.listBySource("s1", 10), []);
    });
  });
  ```

- [ ] Run `npm test -w @magpie/api` — expect failure: `Cannot find module './source-map-store.js'`.

- [ ] Create `apps/api/src/stores/source-map-store.ts`:

  ```ts
  import { randomUUID } from "node:crypto";
  import type { SourceMapEntry } from "@magpie/core";

  // The write shape for one hint. Keyed on (sourceId, topic): an upsert with an
  // existing key replaces that entry's paths/description/sha (latest observation
  // wins), preserving id and createdAt.
  export interface SourceMapUpsert {
    sourceId: string;
    topic: string;
    paths: string[];
    description: string;
    observedSha?: string;
  }

  // Persistent, agent-maintained navigation hints per source repository (#215).
  // Internal metadata for source-grounded prompts — never answer-retrieval or
  // user-facing content. Entry-level merge semantics (one row per topic) so
  // concurrent jobs never clobber a whole document.
  export interface SourceMapStore {
    // Entries for one source, most-recently-updated first, capped by limit.
    listBySource(sourceId: string, limit: number): Promise<SourceMapEntry[]>;
    // Insert or replace the entry for (sourceId, topic).
    upsert(update: SourceMapUpsert): Promise<SourceMapEntry>;
    // Delete the oldest-updated entries beyond `limit`, returning how many went.
    pruneToLimit(sourceId: string, limit: number): Promise<number>;
    reset(): Promise<void>;
  }

  function entryKey(sourceId: string, topic: string): string {
    return `${sourceId}\0${topic}`;
  }

  export class InMemorySourceMapStore implements SourceMapStore {
    private readonly entries = new Map<string, SourceMapEntry>();

    async listBySource(sourceId: string, limit: number): Promise<SourceMapEntry[]> {
      return [...this.entries.values()]
        .filter((entry) => entry.sourceId === sourceId)
        // Tie-break equal timestamps by topic so ordering (and pruning) is
        // deterministic — matches the Postgres ORDER BY.
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.topic.localeCompare(right.topic)
        )
        .slice(0, limit);
    }

    async upsert(update: SourceMapUpsert): Promise<SourceMapEntry> {
      const now = new Date().toISOString();
      const existing = this.entries.get(entryKey(update.sourceId, update.topic));
      const entry: SourceMapEntry = {
        id: existing?.id ?? randomUUID(),
        sourceId: update.sourceId,
        topic: update.topic,
        paths: [...update.paths],
        description: update.description,
        ...(update.observedSha ? { observedSha: update.observedSha } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      this.entries.set(entryKey(update.sourceId, update.topic), entry);
      return entry;
    }

    async pruneToLimit(sourceId: string, limit: number): Promise<number> {
      const ordered = await this.listBySource(sourceId, Number.MAX_SAFE_INTEGER);
      const evict = ordered.slice(limit);
      for (const entry of evict) {
        this.entries.delete(entryKey(entry.sourceId, entry.topic));
      }
      return evict.length;
    }

    async reset(): Promise<void> {
      this.entries.clear();
    }
  }
  ```

- [ ] Run `npm test -w @magpie/api` — expect the new tests to pass (build `@magpie/core` first if module resolution complains: `npm run build -w @magpie/core`).

- [ ] Create `apps/api/src/stores/postgres-source-map-store.test.ts` (same template as `postgres-source-sync-store.test.ts` — self-skips without `DATABASE_URL`, unique ids per assertion so parallel rows never flake):

  ```ts
  import assert from "node:assert/strict";
  import { randomUUID } from "node:crypto";
  import { describe, it } from "node:test";
  import { PostgresSourceMapStore } from "./postgres-source-map-store.js";
  import { makeTestPool } from "../test-support/db-pool.js";

  const databaseUrl = process.env.DATABASE_URL;

  describe("PostgresSourceMapStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
    const store = new PostgresSourceMapStore(makeTestPool(databaseUrl as string));

    it("round-trips an entry through upsert and listBySource", async () => {
      const sourceId = `src-${randomUUID()}`;
      const created = await store.upsert({
        sourceId,
        topic: "event system",
        paths: ["src/events/", "docs/events.md"],
        description: "Event bus and handlers live here",
        observedSha: "abc123"
      });
      assert.ok(created.id);
      const entries = await store.listBySource(sourceId, 10);
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0].paths, ["src/events/", "docs/events.md"]);
      assert.equal(entries[0].observedSha, "abc123");
    });

    it("upsert replaces on (source_id, topic) and bumps updated_at", async () => {
      const sourceId = `src-${randomUUID()}`;
      const first = await store.upsert({ sourceId, topic: "t", paths: ["a/"], description: "old" });
      const second = await store.upsert({ sourceId, topic: "t", paths: ["b/"], description: "new" });
      assert.equal(second.id, first.id);
      assert.deepEqual(second.paths, ["b/"]);
      assert.ok(second.updatedAt >= first.updatedAt);
      assert.equal((await store.listBySource(sourceId, 10)).length, 1);
    });

    it("an upsert without observedSha clears a previously recorded sha (latest observation wins)", async () => {
      const sourceId = `src-${randomUUID()}`;
      await store.upsert({ sourceId, topic: "t", paths: ["a/"], description: "d", observedSha: "abc123" });
      const updated = await store.upsert({ sourceId, topic: "t", paths: ["a/"], description: "d" });
      assert.equal(updated.observedSha, undefined);
    });

    it("pruneToLimit deletes the oldest-updated entries beyond the cap", async () => {
      const sourceId = `src-${randomUUID()}`;
      for (const topic of ["a", "b", "c"]) {
        await store.upsert({ sourceId, topic, paths: ["p/"], description: "d" });
      }
      const evicted = await store.pruneToLimit(sourceId, 2);
      assert.equal(evicted, 1);
      assert.equal((await store.listBySource(sourceId, 10)).length, 2);
    });
  });
  ```

- [ ] Create `apps/api/src/stores/postgres-source-map-store.ts`:

  ```ts
  import { randomUUID } from "node:crypto";
  import pg from "pg";
  import type { SourceMapEntry } from "@magpie/core";
  import type { SourceMapStore, SourceMapUpsert } from "./source-map-store.js";

  export class PostgresSourceMapStore implements SourceMapStore {
    constructor(private readonly pool: pg.Pool) {}

    async listBySource(sourceId: string, limit: number): Promise<SourceMapEntry[]> {
      const result = await this.pool.query<SourceMapEntryRow>(
        "SELECT * FROM source_map_entries WHERE source_id = $1 ORDER BY updated_at DESC, topic ASC LIMIT $2",
        [sourceId, limit]
      );
      return result.rows.map(mapRow);
    }

    async upsert(update: SourceMapUpsert): Promise<SourceMapEntry> {
      // Latest observation wins wholesale, including observed_sha (an update
      // without a sha clears a stale one rather than keeping it).
      const result = await this.pool.query<SourceMapEntryRow>(
        `
          INSERT INTO source_map_entries (id, source_id, topic, paths, description, observed_sha)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (source_id, topic) DO UPDATE
            SET paths = EXCLUDED.paths,
                description = EXCLUDED.description,
                observed_sha = EXCLUDED.observed_sha,
                updated_at = now()
          RETURNING *
        `,
        [
          randomUUID(),
          update.sourceId,
          update.topic,
          JSON.stringify(update.paths),
          update.description,
          update.observedSha ?? null
        ]
      );
      return mapRow(result.rows[0]);
    }

    async pruneToLimit(sourceId: string, limit: number): Promise<number> {
      const result = await this.pool.query(
        `
          DELETE FROM source_map_entries
          WHERE source_id = $1
            AND id NOT IN (
              SELECT id FROM source_map_entries
              WHERE source_id = $1
              ORDER BY updated_at DESC, topic ASC
              LIMIT $2
            )
        `,
        [sourceId, limit]
      );
      return result.rowCount ?? 0;
    }

    async reset(): Promise<void> {
      await this.pool.query("DELETE FROM source_map_entries");
    }
  }

  interface SourceMapEntryRow {
    id: string;
    source_id: string;
    topic: string;
    paths: string[];
    description: string;
    observed_sha: string | null;
    created_at: Date;
    updated_at: Date;
  }

  function mapRow(row: SourceMapEntryRow): SourceMapEntry {
    return {
      id: row.id,
      sourceId: row.source_id,
      topic: row.topic,
      paths: row.paths,
      description: row.description,
      observedSha: row.observed_sha ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }
  ```

- [ ] Wire the store into the composition root:
  - `apps/api/src/platform/config.ts`: add `"SOURCE_MAP_STORE"` to the `STORE_ENV_NAMES` tuple (alphabetical placement not required — append after `"GAP_CLOSURE_VERIFICATION_STORE"`).
  - `apps/api/src/platform/stores.ts`: import both stores and add, following the exact shape of `createSourceSyncStore`:

    ```ts
    export function createSourceMapStore(config: AppConfig, pool: pg.Pool): InMemorySourceMapStore | PostgresSourceMapStore {
      return createStore<InMemorySourceMapStore | PostgresSourceMapStore>(
        config,
        pool,
        "SOURCE_MAP_STORE",
        (pool) => new PostgresSourceMapStore(pool),
        () => new InMemorySourceMapStore()
      );
    }
    ```

  - `apps/api/src/context.ts`: import `createSourceMapStore` from `./platform/stores.js`; add `sourceMap: ReturnType<typeof createSourceMapStore>;` to `AppContext["stores"]` and `sourceMap: createSourceMapStore(config, pool),` to the `stores` literal in `createAppContext`.
  - `apps/api/src/test-support/context.ts`: import `InMemorySourceMapStore` from `../stores/source-map-store.js`; add `sourceMap: new InMemorySourceMapStore(),` to the `stores` literal.
  - `apps/api/src/features/config/service.ts` `resetData`: add `await ctx.stores.sourceMap.reset();` after the `ctx.stores.patrol.reset()` line (no FK ordering concerns — the table references nothing).

- [ ] Run `npm run build && npm test -w @magpie/api && npm run typecheck && npm run lint && npm run deadcode` — expect all pass.

- [ ] Run `npm run test:db` — expect the migration to apply on a clean container and the new Postgres store tests to pass.

- [ ] Commit:

  ```bash
  git add packages/core/src/index.ts packages/db/migrations/0046_source_map_entries.sql apps/api/src/stores/source-map-store.ts apps/api/src/stores/source-map-store.test.ts apps/api/src/stores/postgres-source-map-store.ts apps/api/src/stores/postgres-source-map-store.test.ts apps/api/src/platform/config.ts apps/api/src/platform/stores.ts apps/api/src/context.ts apps/api/src/test-support/context.ts apps/api/src/features/config/service.ts
  git commit -m "feat(source-map): source_map_entries table and store pair (#215)"
  git push
  ```

---

### Task 2: API read endpoint — `GET /api/source-map`

**Files:**
- Create: `apps/api/src/features/source-map/routes.ts`
- Create: `apps/api/src/features/source-map/routes.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces consumed:** `SourceMapStore.listBySource(sourceId, limit)` and `AppContext.stores.sourceMap` (Task 1); `requireScopes` from `apps/api/src/auth/middleware.js`; `buildApp(ctx)` from `apps/api/src/app.js`; `makeTestContext()` from `apps/api/src/test-support/context.js`.

**Interfaces produced:**

```ts
// apps/api/src/features/source-map/routes.ts
export function sourceMapRoutes(ctx: AppContext): Hono;
// GET /api/source-map?sourceIds=s1,s2   (scope: manage:jobs — the watcher's job-execution scope)
//   200 { entries: SourceMapEntry[] }   — ≤100 most-recently-updated entries per source
//   400 { error: "source_ids_required" }
```

**Steps:**

- [ ] Write the failing test `apps/api/src/features/source-map/routes.test.ts`:

  ```ts
  import assert from "node:assert/strict";
  import { describe, it } from "node:test";
  import { buildApp } from "../../app.js";
  import { makeTestContext } from "../../test-support/context.js";

  describe("GET /api/source-map", () => {
    it("returns the most-recently-updated entries for the requested sources", async () => {
      const ctx = makeTestContext();
      await ctx.stores.sourceMap.upsert({ sourceId: "s1", topic: "events", paths: ["src/events/"], description: "Event bus" });
      await ctx.stores.sourceMap.upsert({ sourceId: "s2", topic: "specs", paths: ["Docs/Specs/"], description: "Specifications" });
      await ctx.stores.sourceMap.upsert({ sourceId: "s3", topic: "unrelated", paths: ["x/"], description: "Not requested" });
      const app = buildApp(ctx);

      const res = await app.request("/api/source-map?sourceIds=s1,s2");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { entries: Array<{ sourceId: string; topic: string }> };
      assert.deepEqual(body.entries.map((e) => e.sourceId).sort(), ["s1", "s2"]);
    });

    it("rejects a request without sourceIds", async () => {
      const app = buildApp(makeTestContext());
      const res = await app.request("/api/source-map");
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "source_ids_required" });
    });
  });
  ```

- [ ] Run `npm test -w @magpie/api` — expect failure (`Cannot find module './routes.js'` under features/source-map, or 404s).

- [ ] Create `apps/api/src/features/source-map/routes.ts`:

  ```ts
  import { Hono } from "hono";
  import type { AppContext } from "../../context.js";
  import { requireScopes } from "../../auth/middleware.js";

  // How many entries per source are injected into a source-grounded prompt: the
  // most-recently-updated 100. The stored cap is higher (see the write path);
  // this read cap keeps the prompt block bounded.
  const PROMPT_ENTRY_LIMIT = 100;

  // Watcher-only scoped-context callback: the source-map hints for the sources a
  // source-grounded job is grounded in. Internal navigation metadata — this data
  // must never be served on the ask/answer path or any user-facing surface.
  export function sourceMapRoutes(ctx: AppContext): Hono {
    const app = new Hono();

    app.get("/", requireScopes("manage:jobs"), async (c) => {
      const raw = c.req.query("sourceIds") ?? "";
      const sourceIds = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
      if (sourceIds.length === 0) {
        return c.json({ error: "source_ids_required" }, 400);
      }
      const lists = await Promise.all(
        sourceIds.map((id) => ctx.stores.sourceMap.listBySource(id, PROMPT_ENTRY_LIMIT))
      );
      return c.json({ entries: lists.flat() });
    });

    return app;
  }
  ```

- [ ] Mount it in `apps/api/src/app.ts`: import `{ sourceMapRoutes } from "./features/source-map/routes.js";` and add `api.route("/source-map", sourceMapRoutes(ctx));` alongside the other `api.route(...)` lines (after `"/source-sync"`).

- [ ] Run `npm test -w @magpie/api` — expect pass. Then `npm run build && npm run typecheck && npm run lint && npm run deadcode`.

- [ ] Commit:

  ```bash
  git add apps/api/src/features/source-map/routes.ts apps/api/src/features/source-map/routes.test.ts apps/api/src/app.ts
  git commit -m "feat(source-map): watcher-scoped GET /api/source-map read endpoint (#215)"
  git push
  ```

---

### Task 3: Watcher — fetch hints and render them into the source-grounded prompt

**Files:**
- Modify: `apps/watcher/src/http-client.ts`
- Modify: `apps/watcher/src/source-workspace.ts` (+ `source-workspace.test.ts`)
- Modify: `apps/watcher/src/job-prompts.ts` (+ `job-prompts.test.ts`)
- Modify: `apps/watcher/src/runners/cli.ts` (incl. its `missingApi` fake)
- Modify: `apps/watcher/src/runners/chat.ts`
- Modify: `apps/watcher/src/runners/source-agent.ts`
- Modify (compile-driven, one line each): `apps/watcher/src/runners/chat.test.ts`, `cli.test.ts`, `maintenance.test.ts`, `refresh-flow-snapshot.test.ts`, `publication.test.ts` — every `WatcherApi` fake base object.

**Interfaces consumed:** `SourceMapEntry` from `@magpie/core` (Task 1); `GET /api/source-map?sourceIds=…` → `{ entries: SourceMapEntry[] }` (Task 2); existing `SourceWorkspace`, `PreparedSources`, `buildSourceGroundedPrompt(job, workspaces, notes, mode)`, `WatcherApi`, and the `HttpWatcherApi.get<T>(path)` helper (same one `proposalExecutionContext` uses).

**Interfaces produced:**

```ts
// apps/watcher/src/http-client.ts — WatcherApi gains:
sourceMapEntries(sourceIds: string[]): Promise<SourceMapEntry[]>;

// apps/watcher/src/source-workspace.ts
export async function fetchSourceMapEntries(
  api: Pick<WatcherApi, "sourceMapEntries"> | undefined,
  workspaces: SourceWorkspace[]
): Promise<SourceMapEntry[]>;   // best-effort: [] on absent api, no workspaces, or any error

// apps/watcher/src/job-prompts.ts — signature change:
export function buildSourceGroundedPrompt(
  job: JobView,
  workspaces: SourceWorkspace[],
  notes: string[],
  mode: "cli" | "tools",
  mapEntries: SourceMapEntry[] = []
): string;

// apps/watcher/src/runners/source-agent.ts — runSourceAgentJob options gain:
mapEntries?: SourceMapEntry[];
```

**Steps:**

- [ ] Write the failing prompt-rendering tests in `apps/watcher/src/job-prompts.test.ts` (inside the existing `describe("buildSourceGroundedPrompt", …)`, reusing its job/workspace fixtures):

  ```ts
  const mapEntry = {
    id: "e1",
    sourceId: "s1",
    topic: "event system",
    paths: ["Products/Common/UserActivity/"],
    description: "User-activity events live here",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z"
  };

  it("renders source map hints after the repository list, framed as unverified", () => {
    const prompt = buildSourceGroundedPrompt(sourceGroundedJob, workspaces, [], "cli", [mapEntry]);
    assert.ok(prompt.includes("Source map hints"));
    assert.ok(prompt.includes("unverified"));
    assert.ok(
      prompt.includes("- [s1] event system: Products/Common/UserActivity/ — User-activity events live here")
    );
    assert.ok(prompt.indexOf("Source map hints") > prompt.indexOf("Source repositories available"));
  });

  it("renders no source map block when there are no hints", () => {
    const prompt = buildSourceGroundedPrompt(sourceGroundedJob, workspaces, [], "cli");
    assert.ok(!prompt.includes("Source map hints"));
  });
  ```

- [ ] Run `npm test -w @magpie/watcher` — expect failure (extra argument / missing block).

- [ ] Implement in `apps/watcher/src/job-prompts.ts`: import `type { SourceMapEntry } from "@magpie/core"`, add the trailing `mapEntries: SourceMapEntry[] = []` parameter, and render the block between `noteBlock` and the instructions:

  ```ts
  // Navigation hints recorded by previous agents. Deliberately framed as
  // unverified: they are starting points for exploration, never facts to cite.
  const mapBlock =
    mapEntries.length > 0
      ? `\nSource map hints — notes from previous agents about where things live. These are unverified: use them as starting points and verify against the repository before relying on them.\n${mapEntries
          .map((entry) => `- [${entry.sourceId}] ${entry.topic}: ${entry.paths.join(", ")} — ${entry.description}`)
          .join("\n")}\n`
      : "";
  return `${access}\n${workspaceLines}\n${noteBlock}${mapBlock}\n${instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`;
  ```

- [ ] Run `npm test -w @magpie/watcher` — expect the two new tests to pass.

- [ ] Write the failing fetch-helper tests in `apps/watcher/src/source-workspace.test.ts`:

  ```ts
  describe("fetchSourceMapEntries", () => {
    const ws = { sourceId: "s1", name: "S1", rootDir: "/tmp/s1" };

    it("returns the api's entries for the workspace source ids", async () => {
      const seen: string[][] = [];
      const api = {
        sourceMapEntries: async (ids: string[]) => {
          seen.push(ids);
          return [];
        }
      };
      await fetchSourceMapEntries(api, [ws]);
      assert.deepEqual(seen, [["s1"]]);
    });

    it("degrades to no hints when the api is absent or the call fails", async () => {
      assert.deepEqual(await fetchSourceMapEntries(undefined, [ws]), []);
      const failing = { sourceMapEntries: async (): Promise<never> => { throw new Error("boom"); } };
      assert.deepEqual(await fetchSourceMapEntries(failing, [ws]), []);
    });
  });
  ```

- [ ] Run `npm test -w @magpie/watcher` — expect failure (`fetchSourceMapEntries` not exported).

- [ ] Implement. In `apps/watcher/src/http-client.ts`: import `type { SourceMapEntry } from "@magpie/core"`; add to the `WatcherApi` interface:

  ```ts
  // The source-map hints for the given sources (GET /api/source-map). Callers
  // treat this as best-effort optional context — see fetchSourceMapEntries.
  sourceMapEntries(sourceIds: string[]): Promise<SourceMapEntry[]>;
  ```

  and to `HttpWatcherApi`:

  ```ts
  async sourceMapEntries(sourceIds: string[]): Promise<SourceMapEntry[]> {
    const { entries } = await this.get<{ entries: SourceMapEntry[] }>(
      `/api/source-map?sourceIds=${encodeURIComponent(sourceIds.join(","))}`
    );
    return entries;
  }
  ```

  In `apps/watcher/src/source-workspace.ts` add (importing `type { SourceMapEntry }` from `@magpie/core` and using the local `logger`):

  ```ts
  // Fetches the source-map hints for the prepared fs workspaces. Best-effort by
  // contract: hints are optional context, so an absent api or any failure
  // degrades to an empty list rather than failing the job.
  export async function fetchSourceMapEntries(
    api: { sourceMapEntries(sourceIds: string[]): Promise<SourceMapEntry[]> } | undefined,
    workspaces: SourceWorkspace[]
  ): Promise<SourceMapEntry[]> {
    if (!api || workspaces.length === 0) {
      return [];
    }
    try {
      return await api.sourceMapEntries(workspaces.map((ws) => ws.sourceId));
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "source map fetch failed; continuing without hints"
      );
      return [];
    }
  }
  ```

- [ ] Thread the entries through both execution tiers:
  - `apps/watcher/src/runners/source-agent.ts`: add `mapEntries?: SourceMapEntry[]` to `runSourceAgentJob`'s options (import the type from `@magpie/core`), destructure `const { job, model, workspaces, notes, mapEntries = [], signal } = options;`, and pass it: `const prompt = buildSourceGroundedPrompt(job, workspaces, notes, "tools", mapEntries);`.
  - `apps/watcher/src/runners/chat.ts`: import `fetchSourceMapEntries` from `../source-workspace.js`; in the fs-sources branch, before `runSourceAgentJob`: `const mapEntries = await fetchSourceMapEntries(this.api, workspaces);` and pass `mapEntries` in the options object.
  - `apps/watcher/src/runners/cli.ts` `runSourceGrounded`: `const mapEntries = await fetchSourceMapEntries(this.api, prepared.workspaces);` then `const prompt = buildSourceGroundedPrompt(job, prepared.workspaces, prepared.notes, "cli", mapEntries);`.
  - Fix the now-failing `WatcherApi` implementations by adding `sourceMapEntries: async () => [],` to `missingApi` in `cli.ts` and to every fake base object the compiler flags (`chat.test.ts`, `cli.test.ts`, `maintenance.test.ts`, `refresh-flow-snapshot.test.ts`, `publication.test.ts`).

- [ ] Run `npm run build && npm test -w @magpie/watcher && npm run typecheck && npm run lint && npm run deadcode` — expect all pass.

- [ ] Commit:

  ```bash
  git add apps/watcher/src
  git commit -m "feat(source-map): watcher fetches map hints and renders them into source-grounded prompts (#215)"
  git push
  ```

---

### Task 4: Job output contract — optional `mapUpdates` on the five source-grounded outputs

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/jobs/src/schemas.ts`
- Modify: `packages/jobs/src/schemas.test.ts`

**Interfaces consumed:** the five core output interfaces (`DraftSeedDocumentJobOutput`, `DraftMarkdownProposalJobOutput`, `VerifyDocumentJobOutput`, `CorrectDocumentJobOutput`, `ImproveDocumentJobOutput`) and their `satisfies z.ZodType<…>` schemas in `packages/jobs/src/schemas.ts`.

**Interfaces produced:**

```ts
// @magpie/core
export interface SourceMapUpdate {
  sourceId: string;
  topic: string;
  paths: string[];
  description: string;
  observedSha?: string;
}
// …and each of the five output interfaces gains:  mapUpdates?: SourceMapUpdate[];
```

The Zod output schemas accept the same optional field (`observedSha` optional — the watcher stamps it in Task 5; the API never trusts a model-supplied value because the watcher overwrites or removes it before posting).

**Steps:**

- [ ] Write the failing schema tests in `packages/jobs/src/schemas.test.ts`:

  ```ts
  describe("source map updates on source-grounded outputs", () => {
    const update = {
      sourceId: "s1",
      topic: "event system",
      paths: ["src/events/"],
      description: "Event bus and handlers",
      observedSha: "abc123"
    };

    it("accepts outputs carrying mapUpdates on all five source-grounded jobs", () => {
      assert.equal(verifyDocumentOutputSchema.safeParse({ verdict: "healthy", claims: [], mapUpdates: [update] }).success, true);
      assert.equal(correctDocumentOutputSchema.safeParse({ markdown: "# d", rationale: "r", mapUpdates: [update] }).success, true);
      assert.equal(draftSeedDocumentOutputSchema.safeParse({ title: "t", targetPath: "p.md", markdown: "# d", rationale: "r", mapUpdates: [update] }).success, true);
      assert.equal(draftMarkdownProposalOutputSchema.safeParse({ title: "t", targetPath: "p.md", markdown: "# d", rationale: "r", mapUpdates: [update] }).success, true);
      assert.equal(improveDocumentOutputSchema.safeParse({ improved: false, rationale: "r", mapUpdates: [update] }).success, true);
      assert.equal(improveDocumentOutputSchema.safeParse({ improved: true, markdown: "# d", rationale: "r", mapUpdates: [update] }).success, true);
    });

    it("still accepts outputs without mapUpdates", () => {
      assert.equal(verifyDocumentOutputSchema.safeParse({ verdict: "healthy", claims: [] }).success, true);
    });

    it("rejects a mapUpdate missing its topic", () => {
      const { topic: _omitted, ...broken } = update;
      assert.equal(
        verifyDocumentOutputSchema.safeParse({ verdict: "healthy", claims: [], mapUpdates: [broken] }).success,
        false
      );
    });
  });
  ```

  (Import the five output schemas from `./schemas.js` at the top of the file if not already imported.)

- [ ] Run `npm test -w @magpie/jobs` — expect the "accepts" test to FAIL (Zod objects strip unknown keys, so `mapUpdates` is silently dropped — the "rejects" case fails too since nothing validates it).

  Note: because stripping is silent, the strongest failing signal is the "rejects a mapUpdate missing its topic" case — it fails until the field exists on the schema.

- [ ] Implement. In `packages/core/src/index.ts`, next to `SourceMapEntry`:

  ```ts
  // One agent-contributed source-map hint, carried optionally on source-grounded
  // job outputs. observedSha is stamped by the WATCHER from the checkout it
  // actually explored — a model-supplied value is always overwritten or removed.
  export interface SourceMapUpdate {
    sourceId: string;
    topic: string;
    paths: string[];
    description: string;
    observedSha?: string;
  }
  ```

  Add `mapUpdates?: SourceMapUpdate[];` to `DraftSeedDocumentJobOutput`, `DraftMarkdownProposalJobOutput`, `VerifyDocumentJobOutput`, `CorrectDocumentJobOutput`, and `ImproveDocumentJobOutput`.

  In `packages/jobs/src/schemas.ts`: add `SourceMapUpdate` to the `@magpie/core` type imports, then (near `sourceDescriptorSchema`):

  ```ts
  // Mirrors @magpie/core SourceMapUpdate — an optional, agent-contributed
  // source-map hint on source-grounded outputs. Must be on the schema or the
  // broker strips it from the completed output before the API can apply it.
  const sourceMapUpdateSchema = z.object({
    sourceId: z.string(),
    topic: z.string(),
    paths: z.array(z.string()),
    description: z.string(),
    observedSha: z.string().optional()
  }) satisfies z.ZodType<SourceMapUpdate>;
  const mapUpdatesField = z.array(sourceMapUpdateSchema).optional();
  ```

  Add `mapUpdates: mapUpdatesField` to: `draftSeedDocumentOutputSchema`, `draftMarkdownProposalOutputSchema`, `verifyDocumentOutputSchema`, `correctDocumentOutputSchema`, and BOTH branches of the `improveDocumentOutputSchema` union.

- [ ] Run `npm run build && npm test -w @magpie/jobs && npm run typecheck && npm run lint && npm run deadcode` — expect all pass.

- [ ] Commit:

  ```bash
  git add packages/core/src/index.ts packages/jobs/src/schemas.ts packages/jobs/src/schemas.test.ts
  git commit -m "feat(jobs): optional mapUpdates on source-grounded job outputs (#215)"
  git push
  ```

---

### Task 5: Watcher — capture the checkout HEAD sha and stamp it onto mapUpdates

**Files:**
- Modify: `apps/watcher/src/source-workspace.ts` (+ `source-workspace.test.ts`)
- Modify: `apps/watcher/src/runners/cli.ts`
- Modify: `apps/watcher/src/runners/chat.ts`

**Interfaces consumed:** `getHeadSha(localPath: string): Promise<string | undefined>` (already exported from `@magpie/git`); `ensureGitCheckout` returns `{ localPath, remoteUrl }` — it does NOT return a sha, which is why this task reads HEAD explicitly after checkout; `parseJobOutput` / `runSourceAgentJob` results (an `unknown` parsed output).

**Interfaces produced:**

```ts
// apps/watcher/src/source-workspace.ts
export interface SourceWorkspace {
  sourceId: string;
  name: string;
  rootDir: string;
  headSha?: string;   // NEW — HEAD of the resolved checkout, when it is a git repo
}
// prepareSourceWorkspaces options gain an optional test seam:
//   { checkoutRoot: string; checkout?: typeof ensureGitCheckout; headSha?: (localPath: string) => Promise<string | undefined> }

export function stampSourceMapUpdates(output: unknown, workspaces: SourceWorkspace[]): unknown;
// Overwrites/removes observedSha on every mapUpdate using the workspaces' headSha;
// pass-through for outputs without a mapUpdates array.
```

**Steps:**

- [ ] Write the failing tests in `apps/watcher/src/source-workspace.test.ts` (reuse the existing `git()` fixture and fake-checkout pattern already in the file):

  ```ts
  it("captures the checkout head sha on the workspace", async () => {
    const prepared = await prepareSourceWorkspaces([git()], {
      checkoutRoot,
      checkout,
      headSha: async () => "abc123"
    });
    assert.equal(prepared.workspaces[0]?.headSha, "abc123");
  });

  describe("stampSourceMapUpdates", () => {
    const workspaces = [{ sourceId: "s1", name: "S1", rootDir: "/tmp/s1", headSha: "real-sha" }];
    const update = { sourceId: "s1", topic: "t", paths: ["p/"], description: "d" };

    it("overwrites a model-supplied observedSha with the workspace sha", () => {
      const stamped = stampSourceMapUpdates(
        { verdict: "healthy", claims: [], mapUpdates: [{ ...update, observedSha: "model-lie" }] },
        workspaces
      );
      assert.deepEqual(stamped, {
        verdict: "healthy",
        claims: [],
        mapUpdates: [{ ...update, observedSha: "real-sha" }]
      });
    });

    it("removes observedSha when the workspace sha is unknown", () => {
      const stamped = stampSourceMapUpdates(
        { verdict: "healthy", claims: [], mapUpdates: [{ ...update, observedSha: "model-lie" }] },
        [{ sourceId: "s1", name: "S1", rootDir: "/tmp/s1" }]
      );
      assert.deepEqual(stamped, { verdict: "healthy", claims: [], mapUpdates: [update] });
    });

    it("passes through outputs without mapUpdates", () => {
      const output = { verdict: "healthy", claims: [] };
      assert.equal(stampSourceMapUpdates(output, workspaces), output);
    });
  });
  ```

- [ ] Run `npm test -w @magpie/watcher` — expect failure (`headSha` option rejected / `stampSourceMapUpdates` not exported).

- [ ] Implement in `apps/watcher/src/source-workspace.ts`:
  - Import `getHeadSha` alongside `ensureGitCheckout` from `@magpie/git`; add `headSha?: string` to `SourceWorkspace`; extend the options type with `headSha?: (localPath: string) => Promise<string | undefined>`.
  - In the git/local resolution branch, capture the repo root before applying the subpath and read HEAD from it (a hint applies to the checkout, not the subtree):

    ```ts
    const readHeadSha = options.headSha ?? getHeadSha;
    // …inside the try, replacing the current rootDir expression:
    const repoRoot =
      descriptor.kind === "git"
        ? (await checkout({ id: descriptor.id, url: descriptor.url, checkoutRoot: options.checkoutRoot })).localPath
        : descriptor.path;
    const rootDir = withSubpath(repoRoot, descriptor.subpath);
    if (!existsSync(rootDir)) {
      throw new Error(`resolved root does not exist: ${rootDir}`);
    }
    // Best-effort: a local-kind source need not be a git repo, and a sha is only
    // a staleness stamp for map hints — never fail workspace preparation for it.
    let headSha: string | undefined;
    try {
      headSha = await readHeadSha(repoRoot);
    } catch {
      headSha = undefined;
    }
    workspaces.push({ sourceId: descriptor.id, name: descriptor.name, rootDir, ...(headSha ? { headSha } : {}) });
    ```

  - Add the stamping helper (no casts — `in` narrowing plus `Object.entries`):

    ```ts
    // Stamps the watcher-observed checkout sha onto every mapUpdate in a parsed
    // source-grounded output, overwriting anything the model put there: the sha
    // is an infrastructure fact, never trusted from the model. Outputs without a
    // mapUpdates array pass through untouched.
    export function stampSourceMapUpdates(output: unknown, workspaces: SourceWorkspace[]): unknown {
      if (typeof output !== "object" || output === null || !("mapUpdates" in output) || !Array.isArray(output.mapUpdates)) {
        return output;
      }
      const shaBySource = new Map(
        workspaces.flatMap((ws) => (ws.headSha ? [[ws.sourceId, ws.headSha] as const] : []))
      );
      const mapUpdates = output.mapUpdates.map((update: unknown) => {
        if (typeof update !== "object" || update === null || !("sourceId" in update) || typeof update.sourceId !== "string") {
          return update;
        }
        const stripped = Object.fromEntries(Object.entries(update).filter(([key]) => key !== "observedSha"));
        const sha = shaBySource.get(update.sourceId);
        return sha ? { ...stripped, observedSha: sha } : stripped;
      });
      return { ...output, mapUpdates };
    }
    ```

- [ ] Wire it into both execution tiers:
  - `apps/watcher/src/runners/cli.ts` `runSourceGrounded`: change the final line to `return stampSourceMapUpdates(parseJobOutput(job, content), prepared.workspaces);` (import from `../source-workspace.js`).
  - `apps/watcher/src/runners/chat.ts`: change the agent-model branch to `return stampSourceMapUpdates(await runSourceAgentJob({ job, model: this.agentModel, workspaces, notes, mapEntries, signal }), workspaces);` (extend the existing import from `../source-workspace.js`).

- [ ] Run `npm run build && npm test -w @magpie/watcher && npm run typecheck && npm run lint && npm run deadcode` — expect all pass.

- [ ] Commit:

  ```bash
  git add apps/watcher/src/source-workspace.ts apps/watcher/src/source-workspace.test.ts apps/watcher/src/runners/cli.ts apps/watcher/src/runners/chat.ts
  git commit -m "feat(source-map): watcher stamps checkout HEAD sha onto mapUpdates (#215)"
  git push
  ```

---

### Task 6: API write path — upsert mapUpdates from the completion dispatcher

**Files:**
- Create: `apps/api/src/features/source-map/service.ts`
- Create: `apps/api/src/features/source-map/service.test.ts`
- Modify: `apps/api/src/features/jobs/service.ts` (`completeJob` fan-out)

**Interfaces consumed:** `SourceMapStore.upsert` / `pruneToLimit` via `ctx.stores.sourceMap` (Task 1); `completeJob(ctx, jobId, output)` and `createJob(ctx, type, input)` from `apps/api/src/features/jobs/service.js`; the `mapUpdates`-bearing output schemas (Task 4); `JobView`/`JobType` from `@magpie/jobs`; `logger` from `apps/api/src/logger.js`.

**Interfaces produced:**

```ts
// apps/api/src/features/source-map/service.ts
export async function applySourceMapUpdatesFromCompletedJob(
  ctx: AppContext,
  job: JobView,
  output: unknown
): Promise<void>;
// No-op for non-source-grounded job types and outputs without mapUpdates.
// NEVER throws: malformed/oversized/unknown-source updates and store failures are
// logged (logger.warn, structured fields) and dropped. Caps: 20 updates per job,
// topic ≤120 chars, 1–8 paths of ≤260 chars, description ≤240 chars, 200 stored
// entries per source (oldest-updated evicted beyond the cap).
```

**Steps:**

- [ ] Write the failing tests `apps/api/src/features/source-map/service.test.ts` — exercised through the real completion dispatcher so the hook itself is covered:

  ```ts
  import assert from "node:assert/strict";
  import { describe, it } from "node:test";
  import { makeTestContext } from "../../test-support/context.js";
  import { completeJob, createJob } from "../jobs/service.js";

  const gitSource = { id: "s1", name: "Source One", kind: "git" as const, url: "https://example.com/repo.git" };

  async function completedVerifyJob(ctx: ReturnType<typeof makeTestContext>, mapUpdates: unknown[]) {
    const job = await createJob(ctx, "verify_document", {
      provider: "codex",
      path: "doc.md",
      content: "# Doc",
      sources: [gitSource]
    });
    return completeJob(ctx, job.id, { verdict: "healthy", claims: [], mapUpdates });
  }

  describe("applySourceMapUpdatesFromCompletedJob (via completeJob)", () => {
    it("upserts valid mapUpdates from a completed source-grounded job", async () => {
      const ctx = makeTestContext();
      const result = await completedVerifyJob(ctx, [
        { sourceId: "s1", topic: "event system", paths: ["src/events/"], description: "Event bus lives here", observedSha: "abc123" }
      ]);
      assert.equal(result.ok, true);
      const entries = await ctx.stores.sourceMap.listBySource("s1", 10);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].topic, "event system");
      assert.equal(entries[0].observedSha, "abc123");
    });

    it("drops updates for sources the job was not grounded in", async () => {
      const ctx = makeTestContext();
      const result = await completedVerifyJob(ctx, [
        { sourceId: "somebody-else", topic: "t", paths: ["p/"], description: "d" }
      ]);
      assert.equal(result.ok, true);
      assert.deepEqual(await ctx.stores.sourceMap.listBySource("somebody-else", 10), []);
    });

    it("drops oversized updates without failing the completion", async () => {
      const ctx = makeTestContext();
      const result = await completedVerifyJob(ctx, [
        { sourceId: "s1", topic: "t", paths: ["p/"], description: "x".repeat(500) }
      ]);
      assert.equal(result.ok, true);
      assert.deepEqual(await ctx.stores.sourceMap.listBySource("s1", 10), []);
    });

    it("evicts oldest entries beyond the 200-per-source cap after applying updates", async () => {
      const ctx = makeTestContext();
      for (let i = 0; i < 200; i++) {
        await ctx.stores.sourceMap.upsert({ sourceId: "s1", topic: `seeded-${i}`, paths: ["p/"], description: "d" });
      }
      const result = await completedVerifyJob(ctx, [
        { sourceId: "s1", topic: "fresh", paths: ["q/"], description: "newest" }
      ]);
      assert.equal(result.ok, true);
      const entries = await ctx.stores.sourceMap.listBySource("s1", 500);
      assert.equal(entries.length, 200);
      assert.ok(entries.some((e) => e.topic === "fresh"));
    });

    it("ignores non-source-grounded job types", async () => {
      const ctx = makeTestContext();
      const job = await createJob(ctx, "summarize_gap", {
        provider: "codex",
        questions: ["q"],
        citedSections: [],
        expectedOutput: "gap_summary"
      });
      const result = await completeJob(ctx, job.id, { summary: "s", priority: 1, rationale: "r" });
      assert.equal(result.ok, true);
      assert.deepEqual(await ctx.stores.sourceMap.listBySource("s1", 10), []);
    });
  });
  ```

- [ ] Run `npm test -w @magpie/api` — expect the upsert/eviction assertions to fail (entries never land — nothing consumes `mapUpdates` yet).

- [ ] Create `apps/api/src/features/source-map/service.ts`:

  ```ts
  import { z } from "zod";
  import type { JobType, JobView } from "@magpie/jobs";
  import type { AppContext } from "../../context.js";
  import { logger } from "../../logger.js";

  // Size discipline (#215): the map is an index, not a mirror of the repo.
  // Anything outside these caps is dropped with a warning — never a job failure.
  const MAX_UPDATES_PER_JOB = 20;
  const MAX_TOPIC_LENGTH = 120;
  const MAX_PATHS = 8;
  const MAX_PATH_LENGTH = 260;
  const MAX_DESCRIPTION_LENGTH = 240;
  const MAX_ENTRIES_PER_SOURCE = 200;

  // The five job types whose inputs carry `sources` and whose outputs may carry
  // `mapUpdates`. Anything else is a no-op here.
  const SOURCE_GROUNDED_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
    "draft_seed_document",
    "draft_markdown_proposal",
    "verify_document",
    "correct_document",
    "improve_document"
  ]);

  // Just the slice of the output this service consumes — the full output was
  // already validated against the job contract by the completion dispatcher.
  const mapUpdatesEnvelopeSchema = z.object({
    mapUpdates: z
      .array(
        z.object({
          sourceId: z.string(),
          topic: z.string(),
          paths: z.array(z.string()),
          description: z.string(),
          observedSha: z.string().optional()
        })
      )
      .optional()
  });
  type ParsedUpdate = NonNullable<z.infer<typeof mapUpdatesEnvelopeSchema>["mapUpdates"]>[number];

  // Just the source ids off the job input, so updates can only touch sources the
  // job was actually grounded in.
  const sourcesEnvelopeSchema = z.object({ sources: z.array(z.object({ id: z.string() })) });

  // Applies a completed source-grounded job's mapUpdates to the source map:
  // upsert by (sourceId, topic), then evict the oldest-updated entries beyond the
  // per-source cap. Best-effort throughout — this runs inside the completion
  // side-effect fan-out and must NEVER throw (a map problem is never worth a
  // job's paid-for output). Idempotent, so completion replays are safe.
  export async function applySourceMapUpdatesFromCompletedJob(
    ctx: AppContext,
    job: JobView,
    output: unknown
  ): Promise<void> {
    if (!SOURCE_GROUNDED_JOB_TYPES.has(job.type)) {
      return;
    }
    const envelope = mapUpdatesEnvelopeSchema.safeParse(output);
    const updates = envelope.success ? (envelope.data.mapUpdates ?? []) : [];
    if (updates.length === 0) {
      return;
    }
    const parsedInput = sourcesEnvelopeSchema.safeParse(job.input);
    const allowedSourceIds = new Set(parsedInput.success ? parsedInput.data.sources.map((s) => s.id) : []);

    if (updates.length > MAX_UPDATES_PER_JOB) {
      logger.warn(
        { jobId: job.id, jobType: job.type, dropped: updates.length - MAX_UPDATES_PER_JOB },
        "source map: dropping updates beyond the per-job cap"
      );
    }
    const touchedSources = new Set<string>();
    for (const update of updates.slice(0, MAX_UPDATES_PER_JOB)) {
      const reason = rejectReason(update, allowedSourceIds);
      if (reason) {
        logger.warn(
          { jobId: job.id, jobType: job.type, sourceId: update.sourceId, topic: update.topic.slice(0, MAX_TOPIC_LENGTH), reason },
          "source map: dropping malformed update"
        );
        continue;
      }
      try {
        await ctx.stores.sourceMap.upsert({
          sourceId: update.sourceId,
          topic: update.topic.trim(),
          paths: update.paths.map((path) => path.trim()),
          description: update.description.trim(),
          ...(update.observedSha ? { observedSha: update.observedSha } : {})
        });
        touchedSources.add(update.sourceId);
      } catch (error) {
        logger.warn(
          { jobId: job.id, sourceId: update.sourceId, err: error instanceof Error ? error.message : String(error) },
          "source map: upsert failed"
        );
      }
    }
    for (const sourceId of touchedSources) {
      try {
        const evicted = await ctx.stores.sourceMap.pruneToLimit(sourceId, MAX_ENTRIES_PER_SOURCE);
        if (evicted > 0) {
          logger.info({ sourceId, evicted }, "source map: evicted oldest entries beyond the per-source cap");
        }
      } catch (error) {
        logger.warn(
          { sourceId, err: error instanceof Error ? error.message : String(error) },
          "source map: eviction failed"
        );
      }
    }
  }

  function rejectReason(update: ParsedUpdate, allowedSourceIds: Set<string>): string | undefined {
    if (!allowedSourceIds.has(update.sourceId)) {
      return "unknown_source";
    }
    const topic = update.topic.trim();
    if (topic.length === 0 || topic.length > MAX_TOPIC_LENGTH) {
      return "topic_out_of_bounds";
    }
    const paths = update.paths.map((path) => path.trim()).filter(Boolean);
    if (paths.length === 0 || paths.length > MAX_PATHS || paths.some((path) => path.length > MAX_PATH_LENGTH)) {
      return "paths_out_of_bounds";
    }
    const description = update.description.trim();
    if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
      return "description_out_of_bounds";
    }
    return undefined;
  }
  ```

- [ ] Hook it into the completion dispatcher, `apps/api/src/features/jobs/service.ts`: add `import * as sourceMapService from "../source-map/service.js";` and, inside `completeJob`'s side-effect `try` block, after the `sourceSyncService.attachSourceSyncPlanFromCompletedJob(...)` line:

  ```ts
  // Source-map contributions ride source-grounded outputs; applying them is
  // internally best-effort (the service never throws) and idempotent on replay.
  await sourceMapService.applySourceMapUpdatesFromCompletedJob(ctx, existingJob, resultData);
  ```

- [ ] Run `npm test -w @magpie/api` — expect the new tests to pass. Then `npm run build && npm run typecheck && npm run lint && npm run deadcode`.

- [ ] Commit:

  ```bash
  git add apps/api/src/features/source-map/service.ts apps/api/src/features/source-map/service.test.ts apps/api/src/features/jobs/service.ts
  git commit -m "feat(source-map): apply mapUpdates from completed source-grounded jobs (#215)"
  git push
  ```

---

### Task 7: Prompt catalog — hints framing and contribution instructions

**Files:**
- Modify: `packages/prompts/src/catalog.ts`
- Modify: `packages/prompts/src/catalog.test.ts`

**Interfaces consumed:** the five `PromptDefinition` consts `DRAFT_MARKDOWN_PROPOSAL`, `DRAFT_SEED_DOCUMENT`, `VERIFY_DOCUMENT`, `CORRECT_DOCUMENT`, `IMPROVE_DOCUMENT` (their `instructions`, `outputShape`, and `Return JSON` blocks). No signature changes; the catalog count stays 19.

**Steps:**

- [ ] Write the failing test in `packages/prompts/src/catalog.test.ts`:

  ```ts
  test("source-grounded prompts describe source-map hints and contributions", () => {
    for (const id of ["draft-markdown-proposal", "draft-seed-document", "verify-document", "correct-document", "improve-document"]) {
      const prompt = getPrompt(id);
      assert.ok(prompt?.instructions.includes("Source map hints"), `${id} explains the hint block`);
      assert.ok(prompt?.instructions.includes("mapUpdates"), `${id} instructs mapUpdates contributions`);
      assert.ok(prompt?.outputShape.includes("mapUpdates"), `${id} outputShape mentions mapUpdates`);
    }
  });
  ```

- [ ] Run `npm test -w @magpie/prompts` — expect failure on all five ids.

- [ ] Implement in `packages/prompts/src/catalog.ts`. Define one shared block above the five definitions (module-level const, not exported — knip-safe):

  ```ts
  // Shared source-map contract for the five source-grounded prompts: consult the
  // hint block first (but verify), and contribute terse updates back.
  const SOURCE_MAP_CONTRACT = `Source map:
  - The prompt may include "Source map hints": navigation notes recorded by previous agents about where things live in the sources. They are UNVERIFIED — use them as starting points for your exploration, and verify against the repository before relying on them. Never cite a hint as evidence.
  - Contribute back via "mapUpdates" (optional array in your JSON output): record durable, non-obvious findings about WHERE things live — e.g. which directory owns a feature, where the specs sit — and corrections to hints you found to be wrong (same sourceId and topic, corrected paths/description).
  - Keep each update terse: a short topic, the concrete repository paths, and a ONE-LINE description. This is an index, not documentation — do not dump prose, file contents, or anything you only needed for this one job. Omit "mapUpdates" when you learned nothing worth recording.
  - Never set "observedSha" — it is stamped automatically.`;
  ```

  Then, in EACH of the five definitions:
  1. Append `\n\n${SOURCE_MAP_CONTRACT}` to `instructions`, inserted after the existing `Grounding:` section (before `Rules:`).
  2. Extend the `Return JSON` example with the optional field, e.g. for `VERIFY_DOCUMENT`:

     ```
     {
       "verdict": "healthy | unprovable",
       "claims": [
         { "claim": "string", "reason": "string" }
       ],
       "mapUpdates": [
         { "sourceId": "string", "topic": "string", "paths": ["string"], "description": "string" }
       ]
     }
     ```

     and equivalently for the other four (add the `"mapUpdates": [...]` line to each Return JSON block).
  3. Update `outputShape` to append `, mapUpdates?` — e.g. `'{ verdict, claims[], mapUpdates? }'`, `"{ title, targetPath, markdown, rationale, mapUpdates? }"`, `"{ markdown, rationale, mapUpdates? }"`, `"{ improved, markdown?, rationale, mapUpdates? }"`.

- [ ] Run `npm test -w @magpie/prompts` — expect pass (including the pre-existing "instructions never end with a trailing newline" test — make sure the appended block doesn't add one).

- [ ] Run `npm run build && npm test && npm run typecheck && npm run lint && npm run deadcode` — the full-suite run matters here because the watcher's `job-prompts` tests consume these instructions.

- [ ] Commit:

  ```bash
  git add packages/prompts/src/catalog.ts packages/prompts/src/catalog.test.ts
  git commit -m "feat(prompts): source-map hint framing and mapUpdates contributions in source-grounded prompts (#215)"
  git push
  ```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/ai-jobs.md`
- Modify: `docs/api.md`
- Modify: `docs/architecture.md`

**Interfaces consumed:** everything shipped in Tasks 1–7 (describe, don't change).

**Steps:**

- [ ] `docs/ai-jobs.md`:
  - Under **“Watcher-only endpoints”**, add `GET /api/source-map?sourceIds=…` — watcher-scoped (`manage:jobs`), returns `{ entries }`, the ≤100 most-recently-updated hints per requested source.
  - Add a new subsection **“Source map (agent navigation hints)”** near the source-grounded/patrol material covering: what the map is (per-source topic → paths + one-line description, unique on (source_id, topic)); the read path (watcher fetches at workspace preparation, renders after the repo list, framed as unverified); the write path (optional `mapUpdates` on the five source-grounded outputs — `draft_seed_document`, `draft_markdown_proposal`, `verify_document`, `correct_document`, `improve_document` — applied best-effort by the completion dispatcher, capped at 20/job and 200/source with oldest-updated eviction, malformed updates dropped with a log warning); `observed_sha` (stamped by the watcher from the checkout HEAD, never trusted from the model); and the two explicit boundaries — the map never enters answer retrieval or user-facing output, and staleness invalidation via source-change-sync is a follow-up (#215 notes it; only `observed_sha` is recorded today).
  - Mention the `SOURCE_MAP_STORE` backend override alongside wherever the other `*_STORE` overrides are listed (the Storage section).
- [ ] `docs/api.md`: document `GET /api/source-map` next to the other watcher-called endpoints (scope, query param, response shape, 400 case).
- [ ] `docs/architecture.md`: in the source-grounded jobs description, add one or two sentences: source-grounded prompts now begin with per-source “source map” hints maintained by the agents themselves, stored in Postgres and flowing through the watcher's scoped-context API — internal metadata, never retrieval content.
- [ ] Run `npm run format:check` (docs are prettier-checked) — fix if needed.
- [ ] Commit:

  ```bash
  git add docs/ai-jobs.md docs/api.md docs/architecture.md
  git commit -m "docs(source-map): document the agent source map read/write paths (#215)"
  git push
  ```

---

## Design-decision coverage (self-review map)

| Fixed decision | Where |
| --- | --- |
| 1. Postgres table + store pair (interface / in-memory / Postgres), unique (source_id, topic), migration numbered per migrator rules (0046 on this branch) | Task 1 |
| 2. Read path returns capped entries (100 most-recently-updated per source); watcher renders them after the repo list as unverified hints | Tasks 2–3 |
| 3. Optional `mapUpdates` on the five source-grounded outputs; upsert by (source_id, topic); observed_sha stamped (watcher-captured HEAD — see note); 200/source cap with oldest-updated eviction; malformed/oversized dropped with structured warning, never failing the job | Tasks 4–6 |
| 4. Five prompt definitions: consult-and-verify hints, contribute terse mapUpdates incl. corrections | Task 7 (framing also in Task 3's rendered block) |
| 5. Explicitly internal — never in retrieval or user-facing output | Global Constraints + comments in Tasks 1–2 + Task 8 docs |
| 6. Docs updated | Task 8 |

**observed_sha note:** the workspace payload did NOT know the checkout sha (`ensureGitCheckout` returns only `{ localPath, remoteUrl }`), but `@magpie/git` already exports `getHeadSha(localPath)`. Rather than leaving observed_sha permanently null, Task 5 captures HEAD on `SourceWorkspace.headSha` at workspace preparation and stamps it onto mapUpdates watcher-side (model-supplied values are always overwritten or removed). Entries observed through a non-git local source keep observed_sha null.
