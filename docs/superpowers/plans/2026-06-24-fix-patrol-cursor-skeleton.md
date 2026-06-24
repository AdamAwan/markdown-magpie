# Fix-patrol Cursor Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the fix-patrol rolling-cursor skeleton — a scheduled maintenance job that, per tick, selects the least-recently-checked KB documents in a flow, records the visit, and writes a run record — with no lenses yet.

**Architecture:** A new `patrol` API feature mirroring `source-sync`: a `maintenance`-capability `fix_patrol` job run by the watcher's `MaintenanceRunner` POSTing `/api/fix-patrol/run`; all store access in the API. A `PatrolStore` holds both the per-doc cursor and the run history. A pure `selectPatrolBatch` does oldest-N + random-sample selection.

**Tech Stack:** TypeScript ESM, npm workspaces (`@magpie/core`, `@magpie/jobs`, `@magpie/api`, `@magpie/watcher`), zod, pg, Hono, Node built-in test runner (`node --import tsx --test`).

## Global Constraints

- knip runs **strict** (no in-file-only export leniency): export only what is consumed cross-file; keep helper types/consts file-local otherwise. Fix unused exports by de-exporting, never by relaxing knip config.
- In-memory and Postgres `PatrolStore` implementations must stay behaviourally identical.
- Local imports use the `.js` suffix; `@magpie/*` imports do not.
- UK English in user-facing copy (the task label/description).
- Run workspace tests from the workspace (`npm test -w @magpie/api`) — running `node --import tsx --test apps/api/...` from the repo root resolves `@magpie/*` to stale `dist`, not `src`.
- Pre-push gates: `npm test` (all workspaces) + `npm run typecheck` + `npm run deadcode` (knip) all green.

---

## File Structure

- Create `apps/api/src/scheduling/patrol-cursor.ts` — pure `selectPatrolBatch`.
- Create `apps/api/src/scheduling/patrol-cursor.test.ts`.
- Create `apps/api/src/stores/patrol-store.ts` — `PatrolStore` + `InMemoryPatrolStore`.
- Create `apps/api/src/stores/patrol-store.test.ts`.
- Create `apps/api/src/stores/postgres-patrol-store.ts`.
- Create `apps/api/src/stores/postgres-patrol-store.test.ts`.
- Create `apps/api/src/features/patrol/service.ts` — `runFixPatrol`, `listRuns`, `getRun`.
- Create `apps/api/src/features/patrol/service.test.ts`.
- Create `apps/api/src/features/patrol/routes.ts` — `fixPatrolRoutes`.
- Create `packages/db/migrations/0027_fix_patrol.sql`.
- Modify `packages/core/src/index.ts` — add `PatrolRun`.
- Modify `packages/jobs/src/types.ts` — add `"fix_patrol"` to `JOB_TYPES`.
- Modify `packages/jobs/src/schemas.ts` — add `fixPatrolInputSchema`, `fixPatrolOutputSchema`.
- Modify `packages/jobs/src/catalog.ts` — register `fix_patrol`.
- Modify `apps/api/src/platform/stores.ts` — `PATROL_STORE` env name + `createPatrolStore`.
- Modify `apps/api/src/context.ts` — wire `patrol` store into `AppContext`.
- Modify `apps/api/src/test-support/context.ts` — `patrol: new InMemoryPatrolStore()`.
- Modify `apps/api/src/features/config/service.ts` — `resetData` resets the patrol store.
- Modify `apps/api/src/app.ts` — mount `/fix-patrol` routes.
- Modify `apps/api/src/scheduling/task-registry.ts` — add the `fix-patrol` template.
- Modify `apps/watcher/src/http-client.ts` — `runFixPatrol` client method.
- Modify `apps/watcher/src/runners/maintenance.ts` — handle `fix_patrol`.

---

## Task 1: `fix_patrol` job type, schemas, catalog

**Files:**
- Modify: `packages/jobs/src/types.ts` (JOB_TYPES tuple)
- Modify: `packages/jobs/src/schemas.ts`
- Modify: `packages/jobs/src/catalog.ts:79`
- Test: `packages/jobs/src/catalog.test.ts`

**Interfaces:**
- Produces: job type `"fix_patrol"`; `fixPatrolInputSchema` (`{ flowId?: string }`), `fixPatrolOutputSchema` (`{ runId: string; selectedCount: number }`).

- [ ] **Step 1: Write the failing test** — append to `packages/jobs/src/catalog.test.ts`:

```ts
test("fix_patrol is a maintenance queue named by its type", () => {
  const definition = jobDefinition("fix_patrol");
  assert.equal(definition.requiredCapability({ flowId: "billing" }), "maintenance");
  assert.equal(queueNameForJob("fix_patrol", { flowId: "billing" }), "fix_patrol");
});

test("fix_patrol input accepts an optional flowId; output carries runId + selectedCount", () => {
  assert.ok(jobDefinition("fix_patrol").inputSchema.safeParse({}).success);
  assert.ok(jobDefinition("fix_patrol").inputSchema.safeParse({ flowId: "billing" }).success);
  assert.ok(jobDefinition("fix_patrol").outputSchema.safeParse({ runId: "r1", selectedCount: 3 }).success);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @magpie/jobs`
Expected: FAIL — `fix_patrol` not in the catalog (jobDefinition throws / undefined).

- [ ] **Step 3: Add the job type** — in `packages/jobs/src/types.ts`, add to the `JOB_TYPES` tuple (after `"source_change_sync"`):

```ts
  "source_change_sync",
  "fix_patrol",
```

- [ ] **Step 4: Add the schemas** — in `packages/jobs/src/schemas.ts`, after `sourceChangeSyncOutputSchema` (near line 276):

```ts
export const fixPatrolInputSchema = z.object({ flowId: z.string().optional() });
// Per tick the patrol records exactly one run; the output reports its id and how
// many documents it checked (0 when the flow has no indexed documents yet).
export const fixPatrolOutputSchema = z.object({
  runId: z.string(),
  selectedCount: z.number().int()
});
```

- [ ] **Step 5: Register in the catalog** — in `packages/jobs/src/catalog.ts`, after the `source_change_sync` line (79):

```ts
  fix_patrol: define("fix_patrol", "maintenance", schemas.fixPatrolInputSchema, schemas.fixPatrolOutputSchema, 60 * 60),
```

- [ ] **Step 6: Run to verify pass**

Run: `npm test -w @magpie/jobs`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add packages/jobs/src/types.ts packages/jobs/src/schemas.ts packages/jobs/src/catalog.ts packages/jobs/src/catalog.test.ts
git commit -m "feat(jobs): register the fix_patrol maintenance job type"
```

---

## Task 2: `PatrolRun` core type

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `PatrolRun { id: string; flowId?: string; trigger: "scheduled" | "manual"; universeCount: number; selectedCount: number; selected: string[]; createdAt: string }`.

- [ ] **Step 1: Add the type** — in `packages/core/src/index.ts`, after the source-sync types (search for `SourceSyncRun`), add:

```ts
// One fix-patrol tick: which documents in a flow were checked and when. `selected`
// is the batch the cursor chose this run; `universeCount` is how many documents the
// flow had to choose from. No status field — a patrol tick is atomic (select →
// stamp → record), never pending.
export interface PatrolRun {
  id: string;
  flowId?: string;
  trigger: "scheduled" | "manual";
  universeCount: number;
  selectedCount: number;
  selected: string[];
  createdAt: string;
}
```

- [ ] **Step 2: Verify the package builds**

Run: `npm run typecheck`
Expected: exit 0 (no consumers yet; this just confirms the type compiles).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add the PatrolRun type"
```

> Note: `PatrolRun` is unused cross-file until Task 4 imports it. If running knip between tasks, expect it to flag `PatrolRun` until then; do not de-export it — Task 4 consumes it.

---

## Task 3: `selectPatrolBatch` selection algorithm

**Files:**
- Create: `apps/api/src/scheduling/patrol-cursor.ts`
- Test: `apps/api/src/scheduling/patrol-cursor.test.ts`

**Interfaces:**
- Produces: `selectPatrolBatch(universe: string[], checkedAt: Map<string,string>, options: { batchSize: number; randomCount: number; rng?: () => number }): string[]`.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/scheduling/patrol-cursor.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPatrolBatch } from "./patrol-cursor.js";

// A deterministic rng that walks a fixed sequence of [0,1) values, so the random
// (explore) share is reproducible in tests.
function seededRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

test("returns the whole universe when it is no larger than the batch", () => {
  const selected = selectPatrolBatch(["a.md", "b.md"], new Map(), { batchSize: 10, randomCount: 2 });
  assert.deepEqual([...selected].sort(), ["a.md", "b.md"]);
});

test("never-checked documents are selected before checked ones, ties by path", () => {
  const universe = ["c.md", "a.md", "b.md", "d.md"];
  const checkedAt = new Map([["a.md", "2026-06-24T10:00:00.000Z"], ["b.md", "2026-06-24T09:00:00.000Z"]]);
  // batchSize 2, randomCount 0 → pure oldest: the two never-checked (c,d) first, by path.
  const selected = selectPatrolBatch(universe, checkedAt, { batchSize: 2, randomCount: 0 });
  assert.deepEqual(selected, ["c.md", "d.md"]);
});

test("older checked timestamps sort before newer ones", () => {
  const universe = ["a.md", "b.md", "c.md"];
  const checkedAt = new Map([
    ["a.md", "2026-06-24T12:00:00.000Z"],
    ["b.md", "2026-06-24T08:00:00.000Z"],
    ["c.md", "2026-06-24T10:00:00.000Z"]
  ]);
  const selected = selectPatrolBatch(universe, checkedAt, { batchSize: 2, randomCount: 0 });
  assert.deepEqual(selected, ["b.md", "c.md"]); // 08:00 then 10:00
});

test("the random share is drawn from the non-exploit remainder", () => {
  const universe = ["a.md", "b.md", "c.md", "d.md", "e.md"]; // all never-checked → sorted by path
  // batchSize 3, randomCount 1 → exploit = a,b; explore picks 1 from [c,d,e].
  // rng 0 → first remaining element = c.md.
  const selected = selectPatrolBatch(universe, new Map(), {
    batchSize: 3,
    randomCount: 1,
    rng: seededRng([0])
  });
  assert.deepEqual(selected, ["a.md", "b.md", "c.md"]);
});

test("returns an empty batch for an empty universe or non-positive batch size", () => {
  assert.deepEqual(selectPatrolBatch([], new Map(), { batchSize: 5, randomCount: 1 }), []);
  assert.deepEqual(selectPatrolBatch(["a.md"], new Map(), { batchSize: 0, randomCount: 0 }), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="patrol batch|never-checked|random share|whole universe|older checked"` (or just `npm test -w @magpie/api`)
Expected: FAIL — `patrol-cursor.js` does not exist.

- [ ] **Step 3: Implement** — create `apps/api/src/scheduling/patrol-cursor.ts`:

```ts
// Pure rolling-cursor selection: pick the documents a patrol tick should check.
// Oldest-checked first (a never-checked doc counts as oldest) for the exploit
// share, plus a small random sample of the remainder for the explore share — so
// the patrol clears the staleness backlog while no document starves and load
// never synchronises into waves. See docs/maintenance-redesign.md (Decisions).

export interface PatrolBatchOptions {
  batchSize: number;
  randomCount: number;
  rng?: () => number;
}

export function selectPatrolBatch(
  universe: string[],
  checkedAt: Map<string, string>,
  options: PatrolBatchOptions
): string[] {
  const { batchSize, randomCount, rng = Math.random } = options;
  if (batchSize <= 0 || universe.length === 0) {
    return [];
  }
  if (universe.length <= batchSize) {
    return [...universe];
  }

  // Oldest first. An absent entry ("never checked") is the empty string, which
  // sorts before any ISO timestamp; ties (incl. all never-checked) break by path,
  // so the order is fully deterministic.
  const byStaleness = [...universe].sort((a, b) => {
    const ca = checkedAt.get(a) ?? "";
    const cb = checkedAt.get(b) ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const exploitCount = Math.max(0, Math.min(batchSize - randomCount, byStaleness.length));
  const exploit = byStaleness.slice(0, exploitCount);

  const remainder = byStaleness.slice(exploitCount);
  const exploreCount = Math.min(randomCount, remainder.length, batchSize - exploit.length);
  const explore = sampleWithoutReplacement(remainder, exploreCount, rng);

  return [...exploit, ...explore];
}

function sampleWithoutReplacement<T>(items: T[], count: number, rng: () => number): T[] {
  if (count <= 0) {
    return [];
  }
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    out.push(pool.splice(index, 1)[0]!);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/api`
Expected: PASS (the five new patrol-cursor tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/patrol-cursor.ts apps/api/src/scheduling/patrol-cursor.test.ts
git commit -m "feat(patrol): oldest-N + random-sample cursor selection"
```

---

## Task 4: `PatrolStore` + in-memory implementation

**Files:**
- Create: `apps/api/src/stores/patrol-store.ts`
- Test: `apps/api/src/stores/patrol-store.test.ts`

**Interfaces:**
- Consumes: `PatrolRun` (Task 2).
- Produces: `PatrolStore`, `InMemoryPatrolStore`, `PatrolRunInput`, `PatrolCursorEntry`.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/stores/patrol-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPatrolStore } from "./patrol-store.js";

test("stampChecked upserts last-checked timestamps the cursor reads back", async () => {
  const store = new InMemoryPatrolStore();
  await store.stampChecked(undefined, ["a.md", "b.md"]);
  const cursor = await store.listCursor(undefined);
  assert.deepEqual(cursor.map((entry) => entry.docPath).sort(), ["a.md", "b.md"]);
  assert.ok(cursor.every((entry) => typeof entry.lastCheckedAt === "string"));

  const first = (await store.listCursor(undefined)).find((entry) => entry.docPath === "a.md")!.lastCheckedAt;
  await store.stampChecked(undefined, ["a.md"]);
  const second = (await store.listCursor(undefined)).find((entry) => entry.docPath === "a.md")!.lastCheckedAt;
  assert.ok(second >= first, "re-stamping advances (or holds) the timestamp, never duplicates the row");
  assert.equal((await store.listCursor(undefined)).filter((entry) => entry.docPath === "a.md").length, 1);
});

test("the cursor is scoped per flow; the default flow is its own set", async () => {
  const store = new InMemoryPatrolStore();
  await store.stampChecked(undefined, ["a.md"]);
  await store.stampChecked("billing", ["b.md"]);
  assert.deepEqual((await store.listCursor(undefined)).map((e) => e.docPath), ["a.md"]);
  assert.deepEqual((await store.listCursor("billing")).map((e) => e.docPath), ["b.md"]);
});

test("createRun + listRuns returns newest first; getRun fetches by id", async () => {
  const store = new InMemoryPatrolStore();
  const first = await store.createRun({ trigger: "scheduled", universeCount: 5, selectedCount: 2, selected: ["a.md", "b.md"] });
  const second = await store.createRun({ flowId: "billing", trigger: "manual", universeCount: 1, selectedCount: 1, selected: ["c.md"] });
  const runs = await store.listRuns(10);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, second.id, "newest first");
  assert.deepEqual(runs[1].selected, ["a.md", "b.md"]);
  assert.equal((await store.getRun(first.id))?.selectedCount, 2);
  assert.equal(await store.getRun("missing"), undefined);
});

test("reset clears both the cursor and the run history", async () => {
  const store = new InMemoryPatrolStore();
  await store.stampChecked(undefined, ["a.md"]);
  await store.createRun({ trigger: "scheduled", universeCount: 1, selectedCount: 1, selected: ["a.md"] });
  await store.reset();
  assert.deepEqual(await store.listCursor(undefined), []);
  assert.deepEqual(await store.listRuns(10), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @magpie/api`
Expected: FAIL — `patrol-store.js` does not exist.

- [ ] **Step 3: Implement** — create `apps/api/src/stores/patrol-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { PatrolRun } from "@magpie/core";

export interface PatrolRunInput {
  flowId?: string;
  trigger: PatrolRun["trigger"];
  universeCount: number;
  selectedCount: number;
  selected: string[];
}

export interface PatrolCursorEntry {
  docPath: string;
  lastCheckedAt: string;
}

// The fix-patrol state for a flow: a per-document "last checked" cursor plus a
// history of patrol runs. Holds both concerns in one store, like SourceSyncStore.
export interface PatrolStore {
  // The cursor for a flow (default flow = undefined): when each doc was last checked.
  listCursor(flowId: string | undefined): Promise<PatrolCursorEntry[]>;
  // Upsert last_checked_at = now() for each doc in one batch.
  stampChecked(flowId: string | undefined, docPaths: string[]): Promise<void>;
  createRun(input: PatrolRunInput): Promise<PatrolRun>;
  listRuns(limit: number): Promise<PatrolRun[]>;
  getRun(id: string): Promise<PatrolRun | undefined>;
  reset(): Promise<void>;
}

// A stable key for the (optional flow id, doc path) pair so the default flow
// (undefined) gets exactly one cursor row per document.
function cursorKey(flowId: string | undefined, docPath: string): string {
  return `${flowId ?? ""} ${docPath}`;
}

export class InMemoryPatrolStore implements PatrolStore {
  private readonly cursor = new Map<string, { flowId: string | undefined; docPath: string; lastCheckedAt: string }>();
  private readonly runs = new Map<string, PatrolRun>();

  async listCursor(flowId: string | undefined): Promise<PatrolCursorEntry[]> {
    return [...this.cursor.values()]
      .filter((entry) => (entry.flowId ?? "") === (flowId ?? ""))
      .map((entry) => ({ docPath: entry.docPath, lastCheckedAt: entry.lastCheckedAt }));
  }

  async stampChecked(flowId: string | undefined, docPaths: string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const docPath of docPaths) {
      this.cursor.set(cursorKey(flowId, docPath), { flowId, docPath, lastCheckedAt: now });
    }
  }

  async createRun(input: PatrolRunInput): Promise<PatrolRun> {
    const run: PatrolRun = {
      id: randomUUID(),
      flowId: input.flowId,
      trigger: input.trigger,
      universeCount: input.universeCount,
      selectedCount: input.selectedCount,
      selected: input.selected,
      createdAt: new Date().toISOString()
    };
    this.runs.set(run.id, run);
    return run;
  }

  async listRuns(limit: number): Promise<PatrolRun[]> {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async getRun(id: string): Promise<PatrolRun | undefined> {
    return this.runs.get(id);
  }

  async reset(): Promise<void> {
    this.cursor.clear();
    this.runs.clear();
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/api`
Expected: PASS (the four new store tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/stores/patrol-store.ts apps/api/src/stores/patrol-store.test.ts
git commit -m "feat(patrol): PatrolStore interface + in-memory implementation"
```

---

## Task 5: Postgres `PatrolStore` + migration

**Files:**
- Create: `packages/db/migrations/0027_fix_patrol.sql`
- Create: `apps/api/src/stores/postgres-patrol-store.ts`
- Test: `apps/api/src/stores/postgres-patrol-store.test.ts`

**Interfaces:**
- Consumes: `PatrolStore`, `PatrolRunInput`, `PatrolCursorEntry` (Task 4), `PatrolRun` (Task 2).
- Produces: `PostgresPatrolStore`.

- [ ] **Step 1: Write the migration** — create `packages/db/migrations/0027_fix_patrol.sql`:

```sql
-- Fix-patrol: a rolling cursor over each flow's knowledge-base documents. The
-- cursor records when each document was last checked; runs record each tick for
-- the operator. (The correctness lenses that act on checked docs come later.)

-- One row per (flow, document). The default flow is stored as '' (not NULL) so the
-- composite primary key dedupes the default-flow row.
CREATE TABLE IF NOT EXISTS patrol_cursor (
  flow_id text NOT NULL DEFAULT '',
  doc_path text NOT NULL,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, doc_path)
);

CREATE TABLE IF NOT EXISTS patrol_runs (
  id uuid PRIMARY KEY,
  flow_id text,
  trigger text NOT NULL,
  universe_count integer NOT NULL DEFAULT 0,
  selected_count integer NOT NULL DEFAULT 0,
  selected jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS patrol_runs_created_at_idx ON patrol_runs (created_at DESC);
```

- [ ] **Step 2: Write the failing test** — create `apps/api/src/stores/postgres-patrol-store.test.ts`, mirroring the skip-without-DB pattern other PG store tests use:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresPatrolStore } from "./postgres-patrol-store.js";

const databaseUrl = process.env.DATABASE_URL;

test("PostgresPatrolStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, async () => {
  const store = new PostgresPatrolStore(databaseUrl!);
  await store.reset();

  await store.stampChecked("billing", ["a.md", "b.md"]);
  const cursor = await store.listCursor("billing");
  assert.deepEqual(cursor.map((entry) => entry.docPath).sort(), ["a.md", "b.md"]);
  assert.deepEqual(await store.listCursor(undefined), [], "billing rows do not leak to the default flow");

  // Re-stamping a doc keeps one row (upsert), not two.
  await store.stampChecked("billing", ["a.md"]);
  assert.equal((await store.listCursor("billing")).filter((e) => e.docPath === "a.md").length, 1);

  const run = await store.createRun({ flowId: "billing", trigger: "scheduled", universeCount: 5, selectedCount: 2, selected: ["a.md", "b.md"] });
  assert.deepEqual((await store.getRun(run.id))?.selected, ["a.md", "b.md"]);
  assert.equal((await store.listRuns(10))[0].id, run.id);

  await store.reset();
  assert.deepEqual(await store.listCursor("billing"), []);
  assert.deepEqual(await store.listRuns(10), []);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -w @magpie/api`
Expected: FAIL — `postgres-patrol-store.js` does not exist (the test imports it; without DB the body skips but the import must resolve).

- [ ] **Step 4: Implement** — create `apps/api/src/stores/postgres-patrol-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PatrolRun } from "@magpie/core";
import type { PatrolCursorEntry, PatrolRunInput, PatrolStore } from "./patrol-store.js";

const { Pool } = pg;

// patrol_cursor.flow_id is NOT NULL with a "" default so the composite primary key
// dedupes the default-flow row (a NULL would not be deduped by ON CONFLICT).
function cursorFlowId(flowId: string | undefined): string {
  return flowId ?? "";
}

// patrol_runs.flow_id is nullable (the default flow stores NULL).
function runFlowId(flowId: string | undefined): string | null {
  return flowId ?? null;
}

export class PostgresPatrolStore implements PatrolStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async listCursor(flowId: string | undefined): Promise<PatrolCursorEntry[]> {
    const result = await this.pool.query<{ doc_path: string; last_checked_at: Date }>(
      "SELECT doc_path, last_checked_at FROM patrol_cursor WHERE flow_id = $1",
      [cursorFlowId(flowId)]
    );
    return result.rows.map((row) => ({ docPath: row.doc_path, lastCheckedAt: row.last_checked_at.toISOString() }));
  }

  async stampChecked(flowId: string | undefined, docPaths: string[]): Promise<void> {
    if (docPaths.length === 0) {
      return;
    }
    // One statement: upsert every selected doc to now(). unnest expands the path
    // array into rows; ON CONFLICT advances the existing row's timestamp.
    await this.pool.query(
      `
        INSERT INTO patrol_cursor (flow_id, doc_path, last_checked_at)
        SELECT $1, doc_path, now() FROM unnest($2::text[]) AS doc_path
        ON CONFLICT (flow_id, doc_path) DO UPDATE SET last_checked_at = EXCLUDED.last_checked_at
      `,
      [cursorFlowId(flowId), docPaths]
    );
  }

  async createRun(input: PatrolRunInput): Promise<PatrolRun> {
    const id = randomUUID();
    const result = await this.pool.query<PatrolRunRow>(
      `
        INSERT INTO patrol_runs (id, flow_id, trigger, universe_count, selected_count, selected)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [id, runFlowId(input.flowId), input.trigger, input.universeCount, input.selectedCount, JSON.stringify(input.selected)]
    );
    return mapRunRow(result.rows[0]);
  }

  async listRuns(limit: number): Promise<PatrolRun[]> {
    const result = await this.pool.query<PatrolRunRow>(
      "SELECT * FROM patrol_runs ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRunRow);
  }

  async getRun(id: string): Promise<PatrolRun | undefined> {
    const result = await this.pool.query<PatrolRunRow>("SELECT * FROM patrol_runs WHERE id = $1", [id]);
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM patrol_runs");
      await client.query("DELETE FROM patrol_cursor");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface PatrolRunRow {
  id: string;
  flow_id: string | null;
  trigger: PatrolRun["trigger"];
  universe_count: number;
  selected_count: number;
  selected: string[];
  created_at: Date;
}

function mapRunRow(row: PatrolRunRow): PatrolRun {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    trigger: row.trigger,
    universeCount: row.universe_count,
    selectedCount: row.selected_count,
    selected: row.selected,
    createdAt: row.created_at.toISOString()
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -w @magpie/api`
Expected: PASS — `PostgresPatrolStore # SKIP DATABASE_URL not set` (import resolves; body skipped).

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0027_fix_patrol.sql apps/api/src/stores/postgres-patrol-store.ts apps/api/src/stores/postgres-patrol-store.test.ts
git commit -m "feat(patrol): Postgres PatrolStore + migration"
```

---

## Task 6: `runFixPatrol` service, routes, and store wiring

**Files:**
- Create: `apps/api/src/features/patrol/service.ts`
- Create: `apps/api/src/features/patrol/routes.ts`
- Test: `apps/api/src/features/patrol/service.test.ts`
- Modify: `apps/api/src/platform/stores.ts` (StoreEnvName + createPatrolStore)
- Modify: `apps/api/src/context.ts` (AppContext.stores + assembly)
- Modify: `apps/api/src/test-support/context.ts`
- Modify: `apps/api/src/features/config/service.ts:150` (resetData)
- Modify: `apps/api/src/app.ts:14,62`

**Interfaces:**
- Consumes: `selectPatrolBatch` (Task 3); `PatrolStore`/`InMemoryPatrolStore` (Task 4); `PostgresPatrolStore` (Task 5); `selectFlow` from `platform/repositories.js`; `ctx.stores.knowledgeIndex.listDocuments()`.
- Produces: `runFixPatrol(ctx, { flowId?, trigger })`, `listRuns(ctx, limit)`, `getRun(ctx, id)`; `fixPatrolRoutes(ctx)`; `ctx.stores.patrol`.

- [ ] **Step 1: Wire the store first (so the test context has it).** In `apps/api/src/platform/stores.ts`: add `"PATROL_STORE"` to the `StoreEnvName` union (after `"SOURCE_SYNC_STORE"`), add the imports, and add the factory:

```ts
// imports (with the other store imports)
import { PostgresPatrolStore } from "../stores/postgres-patrol-store.js";
import { InMemoryPatrolStore } from "../stores/patrol-store.js";

// factory (after createSourceSyncStore)
export function createPatrolStore(): InMemoryPatrolStore | PostgresPatrolStore {
  return createStore<InMemoryPatrolStore | PostgresPatrolStore>(
    "PATROL_STORE",
    (databaseUrl) => new PostgresPatrolStore(databaseUrl),
    () => new InMemoryPatrolStore()
  );
}
```

In `apps/api/src/context.ts`: import `createPatrolStore`, add `patrol: ReturnType<typeof createPatrolStore>;` to the `stores` interface (after `sourceSync`), and `patrol: createPatrolStore(),` to the assembly (after `sourceSync:`).

In `apps/api/src/test-support/context.ts`: import `InMemoryPatrolStore` and add `patrol: new InMemoryPatrolStore(),` to the stores object (after `sourceSync:`).

In `apps/api/src/features/config/service.ts`, in `resetData` after `await ctx.stores.sourceSync.reset();`:

```ts
  await ctx.stores.patrol.reset();
```

- [ ] **Step 2: Write the failing test** — create `apps/api/src/features/patrol/service.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import * as patrol from "./service.js";

async function indexDocs(ctx: ReturnType<typeof makeTestContext>, paths: string[]): Promise<void> {
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: paths.map((path) => ({ path, content: `# ${path}` }))
  });
}

test("runFixPatrol checks a batch, stamps the cursor, and records a run", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md", "c.md"]);

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.run.universeCount, 3);
  assert.equal(outcome.run.selectedCount, outcome.run.selected.length);
  assert.ok(outcome.run.selectedCount > 0 && outcome.run.selectedCount <= 3);

  // The selected docs are now stamped in the cursor.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.deepEqual(cursor.map((e) => e.docPath).sort(), [...outcome.run.selected].sort());

  // It is the most recent run.
  assert.equal((await patrol.listRuns(ctx, 10))[0].id, outcome.run.id);
  assert.equal((await patrol.getRun(ctx, outcome.run.id))?.id, outcome.run.id);
});

test("a second tick rotates to the not-yet-checked documents", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md", "c.md", "d.md", "e.md"]);

  // Batch size is 10 by default, so to force rotation use a universe larger than a
  // batch is unnecessary here; instead assert that re-checked docs are not re-picked
  // before never-checked ones by running two ticks and checking the union grows.
  const first = await patrol.runFixPatrol(ctx, { trigger: "scheduled" });
  const second = await patrol.runFixPatrol(ctx, { trigger: "scheduled" });
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  // With a universe of 5 and batch 10, both ticks select all 5 (universe <= batch),
  // so the cursor covers every doc after the first tick.
  assert.equal((await ctx.stores.patrol.listCursor(undefined)).length, 5);
});

test("an unknown flow is rejected without recording a run", async () => {
  const ctx = makeTestContext();
  const outcome = await patrol.runFixPatrol(ctx, { flowId: "ghost", trigger: "scheduled" });
  assert.deepEqual(outcome, { ok: false, code: "unknown_flow" });
  assert.deepEqual(await patrol.listRuns(ctx, 10), []);
});

test("an empty universe records a zero-selected run", async () => {
  const ctx = makeTestContext();
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.run.universeCount, 0);
  assert.equal(outcome.run.selectedCount, 0);
});
```

> Note: `makeTestContext` has no configured flows, so the default-flow path (`flowId` undefined → unscoped) selects across every indexed repo. The `unknown_flow` test relies on `selectFlow` returning undefined for an id with no configured flow — confirm that during implementation; if a default flow resolves, adjust the test to configure flows via `RuntimeConfigHolder`/knowledge config as the retrieve tests do.

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -w @magpie/api`
Expected: FAIL — `features/patrol/service.js` does not exist.

- [ ] **Step 4: Implement the service** — create `apps/api/src/features/patrol/service.ts`:

```ts
import type { AppContext } from "../../context.js";
import type { PatrolRun } from "@magpie/core";
import { selectFlow } from "../../platform/repositories.js";
import { selectPatrolBatch } from "../../scheduling/patrol-cursor.js";

// Cursor knobs (tunable). batchSize bounds per-tick cost; randomCount is the
// explore share (~20%); the remainder is the oldest/most-stale exploit share.
// See docs/maintenance-redesign.md (Decisions: cursor fairness).
const PATROL_BATCH_SIZE = 10;
const PATROL_RANDOM_COUNT = 2;

export type FixPatrolOutcome = { ok: true; run: PatrolRun } | { ok: false; code: "unknown_flow" };

// Resolve a flow to the repository ids whose documents the cursor rotates over.
// Mirrors the retrieve service: a flow scopes to its destination repo; the default
// flow (undefined) is unscoped (every indexed repository).
function resolveRepositoryIds(
  ctx: AppContext,
  flowId: string | undefined
): { ok: true; repositoryIds: string[] | undefined } | { ok: false; code: "unknown_flow" } {
  if (!flowId) {
    return { ok: true, repositoryIds: undefined };
  }
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  if (!flow) {
    return { ok: false, code: "unknown_flow" };
  }
  return { ok: true, repositoryIds: flow.destinationId ? [flow.destinationId] : undefined };
}

export async function runFixPatrol(
  ctx: AppContext,
  options: { flowId?: string; trigger: PatrolRun["trigger"] }
): Promise<FixPatrolOutcome> {
  const scope = resolveRepositoryIds(ctx, options.flowId);
  if (!scope.ok) {
    return scope;
  }

  const universe = ctx.stores.knowledgeIndex
    .listDocuments()
    .filter((doc) => !scope.repositoryIds || scope.repositoryIds.includes(doc.repositoryId))
    .map((doc) => doc.path);

  const cursor = await ctx.stores.patrol.listCursor(options.flowId);
  const checkedAt = new Map(cursor.map((entry) => [entry.docPath, entry.lastCheckedAt]));

  const selected = selectPatrolBatch(universe, checkedAt, {
    batchSize: PATROL_BATCH_SIZE,
    randomCount: PATROL_RANDOM_COUNT
  });

  // No-op lens slot: later increments run the verify/dedupe/split lenses over
  // `selected` here and emit ChangeIntents through the reconcile gate. The
  // skeleton only advances the cursor and records the visit.
  await ctx.stores.patrol.stampChecked(options.flowId, selected);

  const run = await ctx.stores.patrol.createRun({
    flowId: options.flowId,
    trigger: options.trigger,
    universeCount: universe.length,
    selectedCount: selected.length,
    selected
  });
  console.log(
    `Fix-patrol (${options.trigger}) flow=${options.flowId ?? "(default)"}: ` +
      `checked ${selected.length}/${universe.length} document(s); run ${run.id}.`
  );
  return { ok: true, run };
}

export async function listRuns(ctx: AppContext, limit: number): Promise<PatrolRun[]> {
  return ctx.stores.patrol.listRuns(limit);
}

export async function getRun(ctx: AppContext, id: string): Promise<PatrolRun | undefined> {
  return ctx.stores.patrol.getRun(id);
}
```

- [ ] **Step 5: Implement the routes** — create `apps/api/src/features/patrol/routes.ts`:

```ts
import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as patrolService from "./service.js";

export function fixPatrolRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/runs", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 20);
    return c.json({ runs: await patrolService.listRuns(ctx, limit) });
  });

  // Thin orchestration endpoint the maintenance watcher's fix_patrol runner POSTs.
  // Selects the next batch of documents to patrol and advances the cursor; no lens
  // runs yet. Body optional; an absent flowId patrols the default (unscoped) flow.
  app.post("/run", requireScopes("manage:jobs"), async (c) => {
    const payload = await readJsonBody<{ flowId?: string }>(c);
    const outcome = await patrolService.runFixPatrol(ctx, {
      flowId: payload.flowId?.trim() || undefined,
      trigger: "scheduled"
    });
    if (!outcome.ok) {
      throw new HttpError(400, outcome.code);
    }
    return c.json({ runId: outcome.run.id, selectedCount: outcome.run.selectedCount });
  });

  app.get("/runs/:id", requireScopes("read:knowledge"), async (c) => {
    const run = await patrolService.getRun(ctx, c.req.param("id"));
    if (!run) {
      throw new HttpError(404, "patrol_run_not_found");
    }
    return c.json({ run });
  });

  return app;
}
```

- [ ] **Step 6: Mount the routes** — in `apps/api/src/app.ts`, add the import after the source-sync one (line 14) and the route after line 62:

```ts
import { fixPatrolRoutes } from "./features/patrol/routes.js";
// ...
  api.route("/fix-patrol", fixPatrolRoutes(ctx));
```

- [ ] **Step 7: Run to verify pass**

Run: `npm test -w @magpie/api`
Expected: PASS (the four service tests; whole suite green).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/features/patrol apps/api/src/platform/stores.ts apps/api/src/context.ts apps/api/src/test-support/context.ts apps/api/src/features/config/service.ts apps/api/src/app.ts
git commit -m "feat(patrol): runFixPatrol service, routes, and store wiring"
```

---

## Task 7: Schedule it & run it from the watcher

**Files:**
- Modify: `apps/api/src/scheduling/task-registry.ts:48-81` (templates array)
- Test: `apps/api/src/scheduling/task-registry.test.ts`
- Modify: `apps/watcher/src/http-client.ts` (WatcherApi interface + impl)
- Modify: `apps/watcher/src/runners/maintenance.ts`
- Test: `apps/watcher/src/runners/maintenance.test.ts`

**Interfaces:**
- Consumes: job type `"fix_patrol"` and `fixPatrolOutputSchema` (Task 1); the `/api/fix-patrol/run` route (Task 6).
- Produces: a `fix-patrol` scheduled-task template; `WatcherApi.runFixPatrol`.

- [ ] **Step 1: Write the failing registry test** — append to `apps/api/src/scheduling/task-registry.test.ts`:

```ts
test("the fix-patrol task expands per flow and queues the fix_patrol job", () => {
  const ctx = makeTestContext();
  const tasks = listScheduledTasks(ctx);
  const patrol = tasks.find((task) => task.baseKey === "fix-patrol");
  assert.ok(patrol, "a fix-patrol task is registered");
  assert.equal(patrol!.jobType, "fix_patrol");
  assert.deepEqual(patrol!.input, { flowId: undefined });
});
```

> Confirm `listScheduledTasks` and `makeTestContext` import names match the existing test file header; reuse them as-is.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @magpie/api`
Expected: FAIL — no `fix-patrol` base task.

- [ ] **Step 3: Add the template** — in `apps/api/src/scheduling/task-registry.ts`, append to `flowTaskTemplates` (after the `snapshot-refresh` entry):

```ts
  ,{
    baseKey: "fix-patrol",
    typeLabel: "Fix patrol · rolling knowledge-base check",
    description:
      "Rolls a cursor across this flow's knowledge-base documents, checking the least-recently-visited " +
      "ones each run so the whole knowledge base is revisited over time at a bounded cost per run. " +
      "Correctness lenses that propose fixes are added in a later step.",
    defaultCron: "0 * * * *",
    jobType: "fix_patrol",
    input: (flowId) => ({ flowId })
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/api`
Expected: PASS.

- [ ] **Step 5: Write the failing watcher test** — append to `apps/watcher/src/runners/maintenance.test.ts` a case asserting `fix_patrol` is supported and routes to `api.runFixPatrol`. Match the file's existing fake-api style; the assertion shape:

```ts
test("runs fix_patrol by calling the API and returns the parsed output", async () => {
  const calls: Array<string | undefined> = [];
  const api = fakeApi({
    runFixPatrol: async (flowId: string | undefined) => {
      calls.push(flowId);
      return { runId: "run-1", selectedCount: 3 };
    }
  });
  const runner = new MaintenanceRunner(api);
  assert.equal(runner.supports("fix_patrol"), true);
  const output = await runner.run(
    { id: "j1", type: "fix_patrol", input: { flowId: "billing" } } as unknown as JobView,
    new AbortController().signal
  );
  assert.deepEqual(output, { runId: "run-1", selectedCount: 3 });
  assert.deepEqual(calls, ["billing"]);
});
```

> Adapt `fakeApi(...)` to however `maintenance.test.ts` already builds its `WatcherApi` stub (the existing tests for `source_change_sync` show the exact pattern — reuse it; add `runFixPatrol` to that stub).

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -w @magpie/watcher`
Expected: FAIL — `supports("fix_patrol")` is false / `api.runFixPatrol` missing.

- [ ] **Step 7: Add the client method** — in `apps/watcher/src/http-client.ts`, add to the `WatcherApi` interface (after `runSourceSync`):

```ts
  // Drives a fix-patrol tick in the API (select the next batch of documents to
  // check + advance the cursor), returning the run id and how many were checked.
  // An absent flowId patrols the default flow.
  runFixPatrol(flowId: string | undefined, signal?: AbortSignal): Promise<{ runId: string; selectedCount: number }>;
```

and the implementation (after the `runSourceSync` method):

```ts
  async runFixPatrol(flowId: string | undefined, signal?: AbortSignal): Promise<{ runId: string; selectedCount: number }> {
    return this.post<{ runId: string; selectedCount: number }>(
      "/api/fix-patrol/run",
      { ...(flowId ? { flowId } : {}) },
      signal
    );
  }
```

- [ ] **Step 8: Handle the job** — in `apps/watcher/src/runners/maintenance.ts`: import `fixPatrolOutputSchema`, add `"fix_patrol"` to `MAINTENANCE_JOB_TYPES`, add a branch in `run`, and the method:

```ts
// import
import { fixPatrolOutputSchema, ... } from "@magpie/jobs";

// in MAINTENANCE_JOB_TYPES set
  "source_change_sync",
  "fix_patrol",

// in run()
    if (job.type === "fix_patrol") {
      return this.runFixPatrol(job, signal);
    }

// new method
  private async runFixPatrol(job: JobView, signal: AbortSignal): Promise<unknown> {
    const flowId = readFlowId(job.input);
    console.log(`fix_patrol[${job.id}]: patrolling flow ${flowId ?? "(default)"}`);
    const { runId, selectedCount } = await this.api.runFixPatrol(flowId, signal);
    console.log(`fix_patrol[${job.id}]: checked ${selectedCount} document(s) (run ${runId})`);
    return fixPatrolOutputSchema.parse({ runId, selectedCount });
  }
```

- [ ] **Step 9: Run to verify pass**

Run: `npm test -w @magpie/watcher`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/scheduling/task-registry.ts apps/api/src/scheduling/task-registry.test.ts apps/watcher/src/http-client.ts apps/watcher/src/runners/maintenance.ts apps/watcher/src/runners/maintenance.test.ts
git commit -m "feat(patrol): schedule fix-patrol per flow and run it from the watcher"
```

---

## Final verification

- [ ] `npm run typecheck` → exit 0
- [ ] `npm run deadcode` → exit 0 (knip strict; if `PatrolRun`/`MaintenanceLens`-style in-file-only exports are flagged, de-export — do not relax knip)
- [ ] `npm test` (all workspaces) → 0 failures (Postgres store tests show `# SKIP` without `DATABASE_URL`)
- [ ] Open a PR.

## Notes / expected gotchas

- **Workspace test resolution:** always `npm test -w @magpie/api` (not root-cwd `node --test`), or `@magpie/*` resolves to stale `dist`.
- **knip strict:** `PatrolBatchOptions`, `PatrolCursorEntry`, `PatrolRunInput` are consumed cross-file (store impls / service), so they stay exported. Anything used only in its own file must not be exported.
- **`selectFlow` default-flow behaviour:** verify it returns undefined for an unconfigured flow id (drives the `unknown_flow` test). The retrieve service uses the same call, so its tests are the reference.
- **`HttpError` arity:** `new HttpError(status, code)` and `new HttpError(status, code, message)` are both valid (mirrors source-sync routes).
