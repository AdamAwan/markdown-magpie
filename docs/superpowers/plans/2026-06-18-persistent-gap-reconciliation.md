# Persistent Gap Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-request LLM gap clustering with a persistent model: clusters and their proposal lineage live in Postgres, `GET /api/gaps/clusters` is a fast read, and a single scheduled job reconciles gaps → clusters → proposals → open PRs.

**Architecture:** New `gap_clusters` / `gap_cluster_memberships` / `gap_publication_actions` tables plus a single-row `gap_catalog` revision counter. A `GapClusterStore` (Postgres + in-memory) owns them. The existing `gaps-to-pull-requests` scheduled task becomes the one reconciler: it absorbs the former `pull-request-refresh` task, gates all model work on the catalog revision, applies critic-confirmed merges/splits, and drives publication through an idempotent outbox. The Git publisher gains create-or-update so an existing bot-owned branch can be regenerated without a force push.

**Tech Stack:** TypeScript ESM monorepo, Hono HTTP, raw SQL over `pg.Pool`, hand-written numbered migrations, `node:test` + `node:assert/strict`, Testcontainers for Postgres integration tests.

**Spec:** `docs/superpowers/specs/2026-06-18-persistent-gap-reconciliation-design.md`

---

## Execution Progress (updated 2026-06-19)

**Branch:** `worktree-persistent-gap-reconciliation` (worktree at `.claude/worktrees/persistent-gap-reconciliation`, pushed to origin).

**Done (Tasks 1–12), committed, each with passing tests:**
- ✅ Task 1 — migration `0016` (clusters, memberships, `proposals.gap_cluster_id`, `gap_catalog`, `gap_reconciler_state`, `gap_publication_actions`). Verified via `test-db.mjs`.
- ✅ Task 2 — `superseded` status + `PersistedGapCluster` in `@magpie/core`.
- ✅ Task 3 — `GapClusterStore` interface + `InMemoryGapClusterStore` (+ tests).
- ✅ Task 4 — `PostgresGapClusterStore` (+ Testcontainers integration tests).
- ✅ Task 5 — `createGapClusterStore()` factory wired into real + test `AppContext` as `stores.gapClusters`.
- ✅ Task 6 — `getGapCatalogRevision()` on the question-log store; catalog bumps inside gap insert/resolve transactions (`resolveGaps` was wrapped in a transaction).
- ✅ Task 7 — proposals carry `gapClusterId`; `linkCluster()`; Zod enum accepts `superseded`.
- ✅ Task 8 — Git publisher create-or-update (no force push). Added a `test` script + `test-support.ts` to `@magpie/git` (it had none before).
- ✅ Task 9 — pure lineage helpers. **Plan test data bug fixed:** the first split case had two children tied at 3 members (not "3 beats 2"); changed `child-c` to 2 members so "largest wins" is unambiguous. Implementation follows the spec'd tie-break (lowest gap id).
- ✅ Task 10 — `GAP_RECONCILE_PROPOSE` + `GAP_RECONCILE_CRITIC` prompts. **Also updated** `packages/prompts/src/catalog.test.ts` (count 9→11, ids/order) and `apps/api/src/app.test.ts` (prompt count 9→11) — these were not mentioned in the plan but assert the exact catalog.
- ✅ Task 11 — `gap-reconciler.ts`: revision gate, PR-state pass (absorbs `pull-request-refresh`), assign/propose/critic/apply (merge + split), outbox processor. GitHub + publish/supersede are injectable `ReconcilerDeps` so unit tests stay offline. Added `gapIdsForSummary()` to the question-log store (in-memory uses a synthetic `${questionId}::${summary}` id; Postgres uses the real `bigint`).
- ✅ Task 12 — `listClusters` now reads persisted clusters (no model call). Added `gapDetailsForIds()` to the question-log store.

**Done (Tasks 13–16), committed, each with passing tests:**
- ✅ Task 13 — `draftFromCluster` in `features/gaps/service.ts` + `POST /clusters/:id/proposal`. Direct-mode proposals link to the cluster and enqueue a `publish` outbox action; queue-mode links at job completion. Imports `draftFromGaps` from `features/proposals/service.ts` (no circular dependency).
- ✅ Task 14 — registry folded to a single `gaps-to-pull-requests` reconciler at `*/10 * * * *` running `runGapReconciler` → `reconcileGaps`. **Decision taken: inline** (single-instance) handler, matching the plan default and current scheduler behaviour; the claim-lease follow-up is noted in `task-registry.ts`. Removed `pull-request-refresh`, `refreshPullRequests`, `coveredGapSummaries`, `processGapsIntoPullRequests`, and the unused `selectClustersToDraft`/`fetchPullRequestStatus` imports.
- ✅ Task 15 — store-based `backfillGapClusters(ctx)` in `scheduling/gap-backfill.ts` (chose store over SQL, no migration `0017`). Idempotent (no-ops when active clusters already exist), orders active proposals before settled ones so an in-flight proposal wins a shared gap, freezes merged/rejected/superseded clusters. Wired best-effort into `bootstrap()`. In-memory tests cover the shared-gap, frozen-cluster, single-active-membership, and idempotency cases.
- ✅ Task 16 — `docs/api.md` (persisted `PersistedGapCluster` fields + new endpoint) and `docs/architecture.md` (single reconciler task) updated. `clusterGapCandidates`/`requestGapClusters`/`groupByFlow` removed once knip flagged them dead.

**Final verification (all green on this branch):** `npm run lint` (0 errors, 5 pre-existing warnings in `packages/retrieval`), `npm run typecheck` (clean), `npm run deadcode` (knip, clean), `npm run test` (all unit suites pass), `npm run test:db` (209 api integration tests + others pass against a throwaway pgvector container).

---

## File Structure

New files:
- `packages/db/migrations/0016_persistent_gap_clusters.sql` — all new tables + restored `proposals.gap_cluster_id`.
- `apps/api/src/stores/gap-cluster-store.ts` — `GapClusterStore` interface, domain record types, and `InMemoryGapClusterStore`.
- `apps/api/src/stores/postgres-gap-cluster-store.ts` — `PostgresGapClusterStore`.
- `apps/api/src/stores/gap-cluster-store.test.ts` — in-memory unit tests.
- `apps/api/src/stores/postgres-gap-cluster-store.test.ts` — Postgres integration tests (self-skip without `DATABASE_URL`).
- `apps/api/src/scheduling/gap-reconciler.ts` — the single reconciliation job (decision application, lineage, outbox, PR-state pass).
- `apps/api/src/scheduling/gap-reconciler-lineage.ts` — pure lineage/selection helpers.
- `apps/api/src/scheduling/gap-reconciler-lineage.test.ts` — unit tests for the pure helpers.
- `apps/api/src/scheduling/gap-reconciler.test.ts` — reconciler orchestration tests (stubbed chat + in-memory stores).
- `packages/prompts/src/...` — two new prompt constants (`GAP_RECONCILE_PROPOSE`, `GAP_RECONCILE_CRITIC`).

Modified files:
- `packages/core/src/index.ts` — add `"superseded"` to `Proposal["status"]`; add `PersistedGapCluster`.
- `apps/api/src/features/proposals/schema.ts` — add `"superseded"` to the Zod enum.
- `apps/api/src/stores/proposal-store.ts` + `postgres-proposal-store.ts` — read/write `gap_cluster_id`; accept `superseded`.
- `apps/api/src/stores/question-log-store.ts` (interface) + `postgres-question-log-store.ts` + in-memory impl — `getGapCatalogRevision()`; bump the counter inside gap insert/resolve transactions.
- `apps/api/src/platform/stores.ts` — `createGapClusterStore()` factory.
- `apps/api/src/context.ts` + `apps/api/src/test-support/context.ts` — register `stores.gapClusters`.
- `apps/api/src/features/gaps/service.ts` — `listClusters` reads persisted clusters.
- `apps/api/src/features/gaps/routes.ts` — add `POST /clusters/:id/proposal`.
- `apps/api/src/scheduling/task-registry.ts` — fold `pull-request-refresh` into `gaps-to-pull-requests`, change default cron, remove the separate task.
- `docs/api.md` — document the extended response and new endpoint.

**Naming locked for cross-task consistency:**
- Store accessor: `ctx.stores.gapClusters`.
- Store methods: `listActiveClusters`, `getCluster`, `createCluster`, `updateCluster`, `freezeCluster`, `listActiveMemberships`, `listMembershipsForCluster`, `assignGapToCluster`, `deactivateClusterMemberships`, `getProcessedRevision`, `setProcessedRevision`, `enqueuePublicationAction`, `listPendingPublicationActions`, `markPublicationActionDone`, `markPublicationActionFailed`, `reset`.
- Revision accessor lives on the **question-log store**: `getGapCatalogRevision()`.
- Domain types: `GapClusterRecord`, `GapClusterMembershipRecord`, `PublicationActionRecord`.
- IDs are always **strings** at the domain boundary (bigint columns are stringified in `mapRow`), matching how `question_gaps.id` already flows.

---

## Task 1: Migration — persistent gap-cluster schema

**Files:**
- Create: `packages/db/migrations/0016_persistent_gap_clusters.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Persistent gap clusters and their proposal lineage. The dead gap_clusters table
-- and proposals.gap_cluster_id (never written) were dropped in 0015; this builds
-- the model the reconciler actually populates. GET /api/gaps/clusters reads from
-- here instead of clustering on demand.

CREATE TABLE IF NOT EXISTS gap_clusters (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id text,
  title text NOT NULL,
  rationale text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  parent_cluster_id bigint REFERENCES gap_clusters(id) ON DELETE SET NULL,
  reconciliation_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gap_clusters_active_idx ON gap_clusters (flow_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS gap_cluster_memberships (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id bigint NOT NULL REFERENCES gap_clusters(id) ON DELETE CASCADE,
  gap_id bigint NOT NULL REFERENCES question_gaps(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One active membership per gap.
CREATE UNIQUE INDEX IF NOT EXISTS gap_cluster_memberships_one_active_idx
  ON gap_cluster_memberships (gap_id) WHERE active;
CREATE INDEX IF NOT EXISTS gap_cluster_memberships_cluster_idx
  ON gap_cluster_memberships (cluster_id) WHERE active;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS gap_cluster_id bigint REFERENCES gap_clusters(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS proposals_gap_cluster_id_idx
  ON proposals (gap_cluster_id) WHERE gap_cluster_id IS NOT NULL;

-- Monotonic catalog revision, bumped in the same transaction as any change to the
-- unresolved candidate gaps. Single-row table.
CREATE TABLE IF NOT EXISTS gap_catalog (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO gap_catalog (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Reconciler bookkeeping: last catalog revision whose clustering is committed.
CREATE TABLE IF NOT EXISTS gap_reconciler_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  processed_revision bigint NOT NULL DEFAULT 0,
  last_run_at timestamptz
);
INSERT INTO gap_reconciler_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Idempotent publication outbox so crashes between DB commit, Git push, and the
-- GitHub update can be retried without repeating any model work.
CREATE TABLE IF NOT EXISTS gap_publication_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('publish', 'supersede')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gap_publication_actions_pending_idx
  ON gap_publication_actions (created_at) WHERE status = 'pending';
```

- [ ] **Step 2: Apply against a throwaway DB to verify it parses**

Run: `node scripts/test-db.mjs node -e "console.log('migrations applied')"`
Expected: each migration prints `Applying NNNN_*.sql`, ends with `Applying 0016_persistent_gap_clusters.sql`, then `migrations applied`. No SQL error.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0016_persistent_gap_clusters.sql
git commit -m "feat(db): persistent gap clusters, memberships, catalog revision, publication outbox"
```

---

## Task 2: Core types — `superseded` status and `PersistedGapCluster`

**Files:**
- Modify: `packages/core/src/index.ts` (the `Proposal` interface ~line 178; add new interface near `SuggestedGapCluster` ~line 173)

- [ ] **Step 1: Add `"superseded"` to the proposal status union**

In `packages/core/src/index.ts`, change the `Proposal.status` line:

```ts
  status: "draft" | "ready" | "branch-pushed" | "pr-opened" | "merged" | "rejected" | "superseded";
```

- [ ] **Step 2: Add the `PersistedGapCluster` API type**

Immediately after the `SuggestedGapCluster` interface, add:

```ts
// What GET /api/gaps/clusters now returns: an active persisted cluster. Keeps
// every field SuggestedGapCluster exposed (so the UI is unchanged) and adds the
// persisted lineage fields. `id` is a stable surrogate that survives membership
// changes — unlike the content-hash id the on-demand clusterer produced.
export interface PersistedGapCluster {
  id: string;
  title: string;
  summaries: string[];
  questionIds: string[];
  count: number;
  rationale?: string;
  flowId?: string;
  status: "active";
  proposalId?: string;
  proposalStatus?: Proposal["status"];
  lastReconciledAt?: string;
}
```

- [ ] **Step 3: Build core to verify the types compile**

Run: `npm run build --workspace packages/core`
Expected: exits 0, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add superseded proposal status and PersistedGapCluster type"
```

---

## Task 3: `GapClusterStore` interface + in-memory implementation

**Files:**
- Create: `apps/api/src/stores/gap-cluster-store.ts`
- Test: `apps/api/src/stores/gap-cluster-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/stores/gap-cluster-store.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryGapClusterStore } from "./gap-cluster-store.js";

describe("InMemoryGapClusterStore", () => {
  it("creates an active cluster and lists it", async () => {
    const store = new InMemoryGapClusterStore();
    const cluster = await store.createCluster({ flowId: "f1", title: "Cheese & cats", rationale: "r", revision: 3 });
    assert.equal(cluster.status, "active");
    assert.equal(cluster.flowId, "f1");
    assert.equal(cluster.reconciliationRevision, 3);

    const active = await store.listActiveClusters();
    assert.deepEqual(active.map((c) => c.id), [cluster.id]);
  });

  it("keeps exactly one active membership per gap", async () => {
    const store = new InMemoryGapClusterStore();
    const a = await store.createCluster({ title: "A", revision: 1 });
    const b = await store.createCluster({ title: "B", revision: 1 });

    await store.assignGapToCluster(a.id, "gap-1", "first");
    await store.assignGapToCluster(b.id, "gap-1", "moved");

    const inA = await store.listMembershipsForCluster(a.id);
    const inB = await store.listMembershipsForCluster(b.id);
    assert.equal(inA.length, 0, "gap moved out of A");
    assert.equal(inB.length, 1, "gap now active in B");
    assert.equal(inB[0].gapId, "gap-1");
  });

  it("freezes a cluster so it no longer lists as active", async () => {
    const store = new InMemoryGapClusterStore();
    const c = await store.createCluster({ title: "A", revision: 1 });
    await store.freezeCluster(c.id);
    assert.deepEqual(await store.listActiveClusters(), []);
    const fetched = await store.getCluster(c.id);
    assert.equal(fetched?.status, "frozen");
  });

  it("tracks the processed revision", async () => {
    const store = new InMemoryGapClusterStore();
    assert.equal(await store.getProcessedRevision(), 0);
    await store.setProcessedRevision(7, "2026-06-18T00:00:00.000Z");
    assert.equal(await store.getProcessedRevision(), 7);
  });

  it("enqueues and drains publication actions", async () => {
    const store = new InMemoryGapClusterStore();
    const action = await store.enqueuePublicationAction("prop-1", "publish");
    assert.equal(action.status, "pending");

    const pending = await store.listPendingPublicationActions();
    assert.equal(pending.length, 1);

    await store.markPublicationActionDone(action.id);
    assert.deepEqual(await store.listPendingPublicationActions(), []);

    const action2 = await store.enqueuePublicationAction("prop-2", "supersede");
    await store.markPublicationActionFailed(action2.id, "push rejected");
    const stillPending = await store.listPendingPublicationActions();
    // Failed actions are retryable: they stay visible to the next run.
    assert.equal(stillPending.length, 1);
    assert.equal(stillPending[0].attempts, 1);
    assert.equal(stillPending[0].lastError, "push rejected");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace apps/api -- --test-name-pattern="InMemoryGapClusterStore"`
Expected: FAIL — `Cannot find module './gap-cluster-store.js'`.

- [ ] **Step 3: Write the interface and in-memory implementation**

```ts
// apps/api/src/stores/gap-cluster-store.ts

export interface GapClusterRecord {
  id: string;
  flowId?: string;
  title: string;
  rationale?: string;
  status: "active" | "frozen";
  parentClusterId?: string;
  reconciliationRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface GapClusterMembershipRecord {
  id: string;
  clusterId: string;
  gapId: string;
  active: boolean;
  rationale?: string;
  createdAt: string;
}

export interface PublicationActionRecord {
  id: string;
  proposalId: string;
  kind: "publish" | "supersede";
  status: "pending" | "done" | "failed";
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateClusterInput {
  flowId?: string;
  title: string;
  rationale?: string;
  parentClusterId?: string;
  revision: number;
}

export interface UpdateClusterInput {
  title?: string;
  rationale?: string;
  revision?: number;
}

export interface GapClusterStore {
  listActiveClusters(): Promise<GapClusterRecord[]>;
  getCluster(id: string): Promise<GapClusterRecord | undefined>;
  createCluster(input: CreateClusterInput): Promise<GapClusterRecord>;
  updateCluster(id: string, patch: UpdateClusterInput): Promise<GapClusterRecord | undefined>;
  freezeCluster(id: string): Promise<void>;

  listActiveMemberships(): Promise<GapClusterMembershipRecord[]>;
  listMembershipsForCluster(clusterId: string): Promise<GapClusterMembershipRecord[]>;
  // Moves a gap to `clusterId`, deactivating any other active membership it had.
  assignGapToCluster(clusterId: string, gapId: string, rationale?: string): Promise<void>;
  deactivateClusterMemberships(clusterId: string): Promise<void>;

  getProcessedRevision(): Promise<number>;
  setProcessedRevision(revision: number, lastRunAt: string): Promise<void>;

  enqueuePublicationAction(proposalId: string, kind: "publish" | "supersede"): Promise<PublicationActionRecord>;
  listPendingPublicationActions(): Promise<PublicationActionRecord[]>;
  markPublicationActionDone(id: string): Promise<void>;
  markPublicationActionFailed(id: string, error: string): Promise<void>;

  reset(): Promise<void>;
}

export class InMemoryGapClusterStore implements GapClusterStore {
  private clusters = new Map<string, GapClusterRecord>();
  private memberships = new Map<string, GapClusterMembershipRecord>();
  private actions = new Map<string, PublicationActionRecord>();
  private processedRevision = 0;
  private processedRunAt: string | undefined;
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private now(): string {
    // Tests run without Date.now restrictions here; ISO string is fine.
    return new Date().toISOString();
  }

  async listActiveClusters(): Promise<GapClusterRecord[]> {
    return [...this.clusters.values()]
      .filter((c) => c.status === "active")
      .sort((l, r) => l.id.localeCompare(r.id));
  }

  async getCluster(id: string): Promise<GapClusterRecord | undefined> {
    return this.clusters.get(id);
  }

  async createCluster(input: CreateClusterInput): Promise<GapClusterRecord> {
    const id = this.nextId("cluster");
    const now = this.now();
    const record: GapClusterRecord = {
      id,
      flowId: input.flowId,
      title: input.title,
      rationale: input.rationale,
      status: "active",
      parentClusterId: input.parentClusterId,
      reconciliationRevision: input.revision,
      createdAt: now,
      updatedAt: now
    };
    this.clusters.set(id, record);
    return record;
  }

  async updateCluster(id: string, patch: UpdateClusterInput): Promise<GapClusterRecord | undefined> {
    const existing = this.clusters.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: GapClusterRecord = {
      ...existing,
      title: patch.title ?? existing.title,
      rationale: patch.rationale ?? existing.rationale,
      reconciliationRevision: patch.revision ?? existing.reconciliationRevision,
      updatedAt: this.now()
    };
    this.clusters.set(id, updated);
    return updated;
  }

  async freezeCluster(id: string): Promise<void> {
    const existing = this.clusters.get(id);
    if (existing) {
      this.clusters.set(id, { ...existing, status: "frozen", updatedAt: this.now() });
    }
  }

  async listActiveMemberships(): Promise<GapClusterMembershipRecord[]> {
    return [...this.memberships.values()].filter((m) => m.active);
  }

  async listMembershipsForCluster(clusterId: string): Promise<GapClusterMembershipRecord[]> {
    return [...this.memberships.values()].filter((m) => m.active && m.clusterId === clusterId);
  }

  async assignGapToCluster(clusterId: string, gapId: string, rationale?: string): Promise<void> {
    for (const [key, m] of this.memberships) {
      if (m.active && m.gapId === gapId) {
        this.memberships.set(key, { ...m, active: false });
      }
    }
    const id = this.nextId("membership");
    this.memberships.set(id, { id, clusterId, gapId, active: true, rationale, createdAt: this.now() });
  }

  async deactivateClusterMemberships(clusterId: string): Promise<void> {
    for (const [key, m] of this.memberships) {
      if (m.active && m.clusterId === clusterId) {
        this.memberships.set(key, { ...m, active: false });
      }
    }
  }

  async getProcessedRevision(): Promise<number> {
    return this.processedRevision;
  }

  async setProcessedRevision(revision: number, lastRunAt: string): Promise<void> {
    this.processedRevision = revision;
    this.processedRunAt = lastRunAt;
  }

  async enqueuePublicationAction(proposalId: string, kind: "publish" | "supersede"): Promise<PublicationActionRecord> {
    const id = this.nextId("action");
    const now = this.now();
    const record: PublicationActionRecord = {
      id,
      proposalId,
      kind,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    this.actions.set(id, record);
    return record;
  }

  async listPendingPublicationActions(): Promise<PublicationActionRecord[]> {
    return [...this.actions.values()]
      .filter((a) => a.status === "pending" || a.status === "failed")
      .sort((l, r) => l.createdAt.localeCompare(r.createdAt));
  }

  async markPublicationActionDone(id: string): Promise<void> {
    const existing = this.actions.get(id);
    if (existing) {
      this.actions.set(id, { ...existing, status: "done", updatedAt: this.now() });
    }
  }

  async markPublicationActionFailed(id: string, error: string): Promise<void> {
    const existing = this.actions.get(id);
    if (existing) {
      this.actions.set(id, {
        ...existing,
        status: "failed",
        attempts: existing.attempts + 1,
        lastError: error,
        updatedAt: this.now()
      });
    }
  }

  async reset(): Promise<void> {
    this.clusters.clear();
    this.memberships.clear();
    this.actions.clear();
    this.processedRevision = 0;
    this.processedRunAt = undefined;
    this.seq = 0;
  }
}
```

Note: `listPendingPublicationActions` returns both `pending` and `failed` so a failed push retries on the next run (spec: "failed pushes remain pending and retry").

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace apps/api -- --test-name-pattern="InMemoryGapClusterStore"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/stores/gap-cluster-store.ts apps/api/src/stores/gap-cluster-store.test.ts
git commit -m "feat(api): GapClusterStore interface and in-memory implementation"
```

---

## Task 4: `PostgresGapClusterStore`

**Files:**
- Create: `apps/api/src/stores/postgres-gap-cluster-store.ts`
- Test: `apps/api/src/stores/postgres-gap-cluster-store.test.ts`

- [ ] **Step 1: Write the failing integration tests**

```ts
// apps/api/src/stores/postgres-gap-cluster-store.test.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresGapClusterStore } from "./postgres-gap-cluster-store.js";

// Self-skips unless DATABASE_URL points at a migrated database (see
// scripts/migrate.mjs). Run via `npm run test:db`.
const databaseUrl = process.env.DATABASE_URL;

describe("PostgresGapClusterStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresGapClusterStore(databaseUrl as string);

  it("round-trips an active cluster", async () => {
    const title = `cluster-${randomUUID()}`;
    const created = await store.createCluster({ flowId: "flow-a", title, rationale: "why", revision: 2 });
    assert.equal(created.title, title);
    assert.equal(created.status, "active");
    assert.equal(created.reconciliationRevision, 2);

    const fetched = await store.getCluster(created.id);
    assert.equal(fetched?.title, title);

    const active = await store.listActiveClusters();
    assert.ok(active.some((c) => c.id === created.id));
  });

  it("enforces one active membership per gap across clusters", async () => {
    const a = await store.createCluster({ title: `a-${randomUUID()}`, revision: 1 });
    const b = await store.createCluster({ title: `b-${randomUUID()}`, revision: 1 });
    // A real gap row is required by the FK; create one via raw SQL helper.
    const gapId = await insertGap(databaseUrl as string);

    await store.assignGapToCluster(a.id, gapId, "first");
    await store.assignGapToCluster(b.id, gapId, "moved");

    assert.equal((await store.listMembershipsForCluster(a.id)).length, 0);
    const inB = await store.listMembershipsForCluster(b.id);
    assert.equal(inB.length, 1);
    assert.equal(inB[0].gapId, gapId);
  });

  it("freezes clusters", async () => {
    const c = await store.createCluster({ title: `f-${randomUUID()}`, revision: 1 });
    await store.freezeCluster(c.id);
    assert.equal((await store.getCluster(c.id))?.status, "frozen");
    assert.ok(!(await store.listActiveClusters()).some((x) => x.id === c.id));
  });

  it("persists the processed revision", async () => {
    await store.setProcessedRevision(11, new Date(0).toISOString());
    assert.equal(await store.getProcessedRevision(), 11);
    await store.setProcessedRevision(12, new Date(1000).toISOString());
    assert.equal(await store.getProcessedRevision(), 12);
  });

  it("queues and retries publication actions", async () => {
    const proposalId = await insertProposal(databaseUrl as string);
    const action = await store.enqueuePublicationAction(proposalId, "publish");
    assert.equal(action.status, "pending");

    await store.markPublicationActionFailed(action.id, "boom");
    const pending = await store.listPendingPublicationActions();
    const mine = pending.find((a) => a.id === action.id);
    assert.equal(mine?.attempts, 1);
    assert.equal(mine?.lastError, "boom");

    await store.markPublicationActionDone(action.id);
    assert.ok(!(await store.listPendingPublicationActions()).some((a) => a.id === action.id));
  });
});

// Minimal raw-SQL helpers so FK constraints are satisfied without coupling to the
// other stores' APIs.
async function insertGap(databaseUrl: string): Promise<string> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const q = await pool.query<{ id: string }>(
      "INSERT INTO questions (id, question, asked_at) VALUES ($1, 'q', now()) RETURNING id",
      [`q-${randomUUID()}`]
    );
    const g = await pool.query<{ id: string }>(
      "INSERT INTO question_gaps (question_id, summary) VALUES ($1, $2) RETURNING id::text AS id",
      [q.rows[0].id, `gap-${randomUUID()}`]
    );
    return g.rows[0].id;
  } finally {
    await pool.end();
  }
}

async function insertProposal(databaseUrl: string): Promise<string> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const id = `prop-${randomUUID()}`;
  try {
    await pool.query(
      "INSERT INTO proposals (id, title, status, target_path, markdown) VALUES ($1, 't', 'draft', 'p.md', '#')",
      [id]
    );
    return id;
  } finally {
    await pool.end();
  }
}
```

> Before writing the impl, confirm the exact required columns for `questions` and `proposals` inserts by reading `0001_initial.sql` / `0002_question_logging.sql`. Adjust the two helpers' column lists if a NOT NULL column has no default. (The reviewer should run Step 2; a failure naming a missing column tells you exactly what to add.)

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:db -- --workspace apps/api -- --test-name-pattern="PostgresGapClusterStore"`
Expected: FAIL — `Cannot find module './postgres-gap-cluster-store.js'`.

- [ ] **Step 3: Write the Postgres implementation**

```ts
// apps/api/src/stores/postgres-gap-cluster-store.ts
import pg from "pg";
import type {
  CreateClusterInput,
  GapClusterMembershipRecord,
  GapClusterRecord,
  GapClusterStore,
  PublicationActionRecord,
  UpdateClusterInput
} from "./gap-cluster-store.js";

const { Pool } = pg;

interface ClusterRow {
  id: string;
  flow_id: string | null;
  title: string;
  rationale: string | null;
  status: "active" | "frozen";
  parent_cluster_id: string | null;
  reconciliation_revision: string;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow {
  id: string;
  cluster_id: string;
  gap_id: string;
  active: boolean;
  rationale: string | null;
  created_at: Date;
}

interface ActionRow {
  id: string;
  proposal_id: string;
  kind: "publish" | "supersede";
  status: "pending" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PostgresGapClusterStore implements GapClusterStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async listActiveClusters(): Promise<GapClusterRecord[]> {
    const result = await this.pool.query<ClusterRow>(
      "SELECT * FROM gap_clusters WHERE status = 'active' ORDER BY id ASC"
    );
    return result.rows.map(mapCluster);
  }

  async getCluster(id: string): Promise<GapClusterRecord | undefined> {
    const result = await this.pool.query<ClusterRow>("SELECT * FROM gap_clusters WHERE id = $1", [id]);
    return result.rows[0] ? mapCluster(result.rows[0]) : undefined;
  }

  async createCluster(input: CreateClusterInput): Promise<GapClusterRecord> {
    const result = await this.pool.query<ClusterRow>(
      `
        INSERT INTO gap_clusters (flow_id, title, rationale, parent_cluster_id, reconciliation_revision)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [input.flowId ?? null, input.title, input.rationale ?? null, input.parentClusterId ?? null, input.revision]
    );
    return mapCluster(result.rows[0]);
  }

  async updateCluster(id: string, patch: UpdateClusterInput): Promise<GapClusterRecord | undefined> {
    const result = await this.pool.query<ClusterRow>(
      `
        UPDATE gap_clusters
        SET title = COALESCE($2, title),
            rationale = COALESCE($3, rationale),
            reconciliation_revision = COALESCE($4, reconciliation_revision),
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [id, patch.title ?? null, patch.rationale ?? null, patch.revision ?? null]
    );
    return result.rows[0] ? mapCluster(result.rows[0]) : undefined;
  }

  async freezeCluster(id: string): Promise<void> {
    await this.pool.query("UPDATE gap_clusters SET status = 'frozen', updated_at = now() WHERE id = $1", [id]);
  }

  async listActiveMemberships(): Promise<GapClusterMembershipRecord[]> {
    const result = await this.pool.query<MembershipRow>(
      "SELECT * FROM gap_cluster_memberships WHERE active ORDER BY id ASC"
    );
    return result.rows.map(mapMembership);
  }

  async listMembershipsForCluster(clusterId: string): Promise<GapClusterMembershipRecord[]> {
    const result = await this.pool.query<MembershipRow>(
      "SELECT * FROM gap_cluster_memberships WHERE active AND cluster_id = $1 ORDER BY id ASC",
      [clusterId]
    );
    return result.rows.map(mapMembership);
  }

  async assignGapToCluster(clusterId: string, gapId: string, rationale?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE gap_cluster_memberships SET active = false WHERE active AND gap_id = $1", [gapId]);
      await client.query(
        "INSERT INTO gap_cluster_memberships (cluster_id, gap_id, rationale) VALUES ($1, $2, $3)",
        [clusterId, gapId, rationale ?? null]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateClusterMemberships(clusterId: string): Promise<void> {
    await this.pool.query("UPDATE gap_cluster_memberships SET active = false WHERE active AND cluster_id = $1", [
      clusterId
    ]);
  }

  async getProcessedRevision(): Promise<number> {
    const result = await this.pool.query<{ processed_revision: string }>(
      "SELECT processed_revision FROM gap_reconciler_state WHERE id = true"
    );
    return result.rows[0] ? Number(result.rows[0].processed_revision) : 0;
  }

  async setProcessedRevision(revision: number, lastRunAt: string): Promise<void> {
    await this.pool.query(
      "UPDATE gap_reconciler_state SET processed_revision = $1, last_run_at = $2 WHERE id = true",
      [revision, lastRunAt]
    );
  }

  async enqueuePublicationAction(
    proposalId: string,
    kind: "publish" | "supersede"
  ): Promise<PublicationActionRecord> {
    const result = await this.pool.query<ActionRow>(
      "INSERT INTO gap_publication_actions (proposal_id, kind) VALUES ($1, $2) RETURNING *",
      [proposalId, kind]
    );
    return mapAction(result.rows[0]);
  }

  async listPendingPublicationActions(): Promise<PublicationActionRecord[]> {
    const result = await this.pool.query<ActionRow>(
      "SELECT * FROM gap_publication_actions WHERE status IN ('pending', 'failed') ORDER BY created_at ASC"
    );
    return result.rows.map(mapAction);
  }

  async markPublicationActionDone(id: string): Promise<void> {
    await this.pool.query("UPDATE gap_publication_actions SET status = 'done', updated_at = now() WHERE id = $1", [
      id
    ]);
  }

  async markPublicationActionFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE gap_publication_actions
        SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = now()
        WHERE id = $1
      `,
      [id, error]
    );
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM gap_publication_actions");
      await client.query("DELETE FROM gap_cluster_memberships");
      await client.query("UPDATE proposals SET gap_cluster_id = NULL WHERE gap_cluster_id IS NOT NULL");
      await client.query("DELETE FROM gap_clusters");
      await client.query("UPDATE gap_reconciler_state SET processed_revision = 0, last_run_at = NULL WHERE id = true");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapCluster(row: ClusterRow): GapClusterRecord {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    title: row.title,
    rationale: row.rationale ?? undefined,
    status: row.status,
    parentClusterId: row.parent_cluster_id ?? undefined,
    reconciliationRevision: Number(row.reconciliation_revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapMembership(row: MembershipRow): GapClusterMembershipRecord {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    gapId: row.gap_id,
    active: row.active,
    rationale: row.rationale ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

function mapAction(row: ActionRow): PublicationActionRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
```

- [ ] **Step 4: Run the integration tests to verify they pass**

Run: `npm run test:db -- --workspace apps/api -- --test-name-pattern="PostgresGapClusterStore"`
Expected: PASS (5 tests). If a helper insert fails on a missing NOT NULL column, add that column to the helper (see the note in Step 1) and re-run.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/stores/postgres-gap-cluster-store.ts apps/api/src/stores/postgres-gap-cluster-store.test.ts
git commit -m "feat(api): Postgres-backed GapClusterStore"
```

---

## Task 5: Register the store on `AppContext`

**Files:**
- Modify: `apps/api/src/platform/stores.ts` (add factory after `createSourceSyncStore`)
- Modify: `apps/api/src/context.ts` (interface `stores` block + `createAppContext` wiring)
- Modify: `apps/api/src/test-support/context.ts` (test `stores` block)

- [ ] **Step 1: Add the factory**

In `apps/api/src/platform/stores.ts`, add the imports and a factory mirroring the others:

```ts
import { InMemoryGapClusterStore } from "../stores/gap-cluster-store.js";
import { PostgresGapClusterStore } from "../stores/postgres-gap-cluster-store.js";

export function createGapClusterStore(): InMemoryGapClusterStore | PostgresGapClusterStore {
  return createStore<InMemoryGapClusterStore | PostgresGapClusterStore>(
    "GAP_CLUSTER_STORE",
    (databaseUrl) => new PostgresGapClusterStore(databaseUrl),
    () => new InMemoryGapClusterStore()
  );
}
```

- [ ] **Step 2: Wire it into the real context**

In `apps/api/src/context.ts`:
- Add to the `stores` interface block: `gapClusters: ReturnType<typeof createGapClusterStore>;`
- Import `createGapClusterStore` alongside the other store factory imports.
- Add to the `stores: { ... }` object in `createAppContext`: `gapClusters: createGapClusterStore(),`

- [ ] **Step 3: Wire it into the test context**

In `apps/api/src/test-support/context.ts`:
- Import `InMemoryGapClusterStore` from `../stores/gap-cluster-store.js`.
- Add to the test `stores` object: `gapClusters: new InMemoryGapClusterStore(),`

- [ ] **Step 4: Typecheck the api app**

Run: `npm run build --workspace apps/api`
Expected: exits 0. (If `tsc` is not the build, run the repo typecheck: `npm run typecheck` from root.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/platform/stores.ts apps/api/src/context.ts apps/api/src/test-support/context.ts
git commit -m "feat(api): register gapClusters store on app context"
```

---

## Task 6: Gap-catalog revision — bump on gap change, expose to reconciler

The revision must increment in the **same transaction** as any insert/resolve of unresolved gaps, so it lives on the question-log store (which owns those writes).

**Files:**
- Modify: `apps/api/src/stores/question-log-store.ts` (interface) — add `getGapCatalogRevision(): Promise<number>`
- Modify: `apps/api/src/stores/postgres-question-log-store.ts` — implement it; bump `gap_catalog.revision` inside the gap insert and `resolveGaps` transactions
- Modify: the in-memory question-log store (same file or its own) — implement an in-memory counter, bump on the same operations
- Test: `apps/api/src/stores/question-log-store.test.ts` (add cases; create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/stores/question-log-store.test.ts (add or create)
import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryQuestionLogStore } from "./question-log-store.js";

test("gap catalog revision advances when a manual gap is recorded and when gaps resolve", async () => {
  const store = new InMemoryQuestionLogStore();
  const start = await store.getGapCatalogRevision();

  const log = await store.record({
    question: "How do I configure X?",
    executionMode: "direct",
    chatProvider: "mock",
    retrievedSectionIds: []
  });
  await store.recordManualGap(log.id, "How to configure X");

  const afterAdd = await store.getGapCatalogRevision();
  assert.ok(afterAdd > start, "recording a gap advances the revision");

  await store.resolveGaps([log.id], ["How to configure X"], "prop-1");
  const afterResolve = await store.getGapCatalogRevision();
  assert.ok(afterResolve > afterAdd, "resolving a gap advances the revision");
});
```

> Confirm the in-memory store class name and the exact `record`/`recordManualGap`/`resolveGaps` signatures by reading `question-log-store.ts` first; adjust the test calls to match (these mirror the usage already in `proposals/service.test.ts`).

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace apps/api -- --test-name-pattern="gap catalog revision"`
Expected: FAIL — `getGapCatalogRevision is not a function`.

- [ ] **Step 3: Implement the in-memory counter**

In the in-memory question-log store, add a private field `private gapCatalogRevision = 0;`, increment it at the end of every method that adds, changes, removes, or resolves an unresolved gap (at minimum: the gap-recording path used by `record` when it stores a gap, `recordManualGap`, and `resolveGaps`), and add:

```ts
async getGapCatalogRevision(): Promise<number> {
  return this.gapCatalogRevision;
}
```

- [ ] **Step 4: Implement the Postgres bump**

In `postgres-question-log-store.ts`:
- Add the read:

```ts
async getGapCatalogRevision(): Promise<number> {
  const result = await this.pool.query<{ revision: string }>("SELECT revision FROM gap_catalog WHERE id = true");
  return result.rows[0] ? Number(result.rows[0].revision) : 0;
}
```

- In each method that inserts a gap row or resolves gaps, ensure the work runs inside a transaction (wrap with `BEGIN`/`COMMIT` if it is currently a single statement) and add, before `COMMIT`:

```ts
await client.query("UPDATE gap_catalog SET revision = revision + 1 WHERE id = true");
```

Apply this to the auto-gap insert path (where `INSERT INTO question_gaps` runs during `record`), `recordManualGap`, and `resolveGaps`.

- Add `getGapCatalogRevision(): Promise<number>;` to the `QuestionLogStore` interface in `question-log-store.ts`.

- [ ] **Step 5: Run unit + integration tests**

Run: `npm run test --workspace apps/api -- --test-name-pattern="gap catalog revision"`
Expected: PASS (in-memory).
Run: `npm run test:db -- --workspace apps/api -- --test-name-pattern="QuestionLog"`
Expected: existing Postgres question-log tests still PASS (revision bump doesn't break them).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/stores/question-log-store.ts apps/api/src/stores/postgres-question-log-store.ts apps/api/src/stores/question-log-store.test.ts
git commit -m "feat(api): gap catalog revision bumps on gap add/resolve"
```

---

## Task 7: Proposal store — `superseded` status and `gap_cluster_id`

**Files:**
- Modify: `apps/api/src/features/proposals/schema.ts`
- Modify: `apps/api/src/stores/proposal-store.ts` (in-memory + `ProposalInput`)
- Modify: `apps/api/src/stores/postgres-proposal-store.ts` (mapRow + create + a `linkCluster`)
- Test: `apps/api/src/stores/postgres-proposal-store.test.ts` (add a case)

- [ ] **Step 1: Add `superseded` to the Zod enum**

In `apps/api/src/features/proposals/schema.ts`:

```ts
export const proposalStatusBodySchema = z.object({
  status: z.enum(["draft", "ready", "branch-pushed", "pr-opened", "merged", "rejected", "superseded"])
});
```

- [ ] **Step 2: Add `gapClusterId` to `ProposalInput` and a `linkCluster` method**

In `apps/api/src/stores/proposal-store.ts`, extend `ProposalInput` with `gapClusterId?: string;`, set it in `InMemoryProposalStore.create` (`gapClusterId: input.gapClusterId`), and add to the `ProposalStore` interface and in-memory impl:

```ts
// interface
linkCluster(id: string, gapClusterId: string): Promise<Proposal | undefined>;
```

```ts
// InMemoryProposalStore
async linkCluster(id: string, gapClusterId: string): Promise<Proposal | undefined> {
  const existing = this.proposals.get(id);
  if (!existing) {
    return undefined;
  }
  const updated: Proposal = { ...existing, gapClusterId };
  this.proposals.set(id, updated);
  return updated;
}
```

- [ ] **Step 3: Restore `gap_cluster_id` in the Postgres store**

In `postgres-proposal-store.ts`:
- Add `gap_cluster_id: string | null;` back to `ProposalRow`.
- In `mapRow`, add `gapClusterId: row.gap_cluster_id ?? undefined,`.
- In `create`, add `gap_cluster_id` to the INSERT column list and `$n` values (cast `::bigint`), passing `input.gapClusterId ?? null`.
- Add `linkCluster`:

```ts
async linkCluster(id: string, gapClusterId: string): Promise<Proposal | undefined> {
  const result = await this.pool.query<ProposalRow>(
    "UPDATE proposals SET gap_cluster_id = $2 WHERE id = $1 RETURNING *",
    [id, gapClusterId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}
```

- [ ] **Step 4: Add a Postgres test asserting the round-trip**

In `postgres-proposal-store.test.ts`, add:

```ts
it("links a proposal to a gap cluster and reads it back", async () => {
  const clusterStore = new PostgresGapClusterStore(databaseUrl as string);
  const cluster = await clusterStore.createCluster({ title: `c-${randomUUID()}`, revision: 1 });

  const proposal = await store.create({
    title: "T",
    targetPath: "t.md",
    markdown: "#",
    rationale: "r",
    evidence: [],
    gapClusterId: cluster.id
  });
  const fetched = await store.get(proposal.id);
  assert.equal(fetched?.gapClusterId, cluster.id);

  const relinked = await store.linkCluster(proposal.id, cluster.id);
  assert.equal(relinked?.gapClusterId, cluster.id);
});
```

(Add `import { PostgresGapClusterStore } from "./postgres-gap-cluster-store.js";` and `import { randomUUID } from "node:crypto";` if not present.)

- [ ] **Step 5: Run the tests**

Run: `npm run test --workspace apps/api -- --test-name-pattern="Proposal"` (in-memory) — PASS.
Run: `npm run test:db -- --workspace apps/api -- --test-name-pattern="gap cluster"` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/features/proposals/schema.ts apps/api/src/stores/proposal-store.ts apps/api/src/stores/postgres-proposal-store.ts apps/api/src/stores/postgres-proposal-store.test.ts
git commit -m "feat(api): proposals carry gap_cluster_id and accept superseded status"
```

---

## Task 8: Git publisher — create-or-update an existing branch

The current `publish` asserts the branch does not exist and always creates it from base. Add an `updateExisting` path that fetches the branch, replaces the file, commits on top, and pushes (no force). Because these branches are bot-owned, the remote tip is always our last push, so a normal push is a fast-forward.

**Files:**
- Modify: `packages/git/src/index.ts` (`LocalGitProposalPublisher`)
- Test: `packages/git/src/index.test.ts` (or the existing publisher test file — confirm its name)

- [ ] **Step 1: Write the failing test (real temp git repos)**

```ts
// packages/git/src/publisher.test.ts (confirm/choose the existing publisher test file name)
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { LocalGitProposalPublisher } from "./index.js";
import { initBareRemoteWithClone } from "./test-support.js"; // see note below

describe("LocalGitProposalPublisher create-or-update", () => {
  it("creates the branch on first publish and updates it on the second without force", async () => {
    const { repository } = await initBareRemoteWithClone();
    const publisher = new LocalGitProposalPublisher();

    const first = await publisher.publish({
      repository,
      branchName: "magpie/topic",
      title: "docs: topic",
      markdown: "# v1\n",
      targetPath: "docs/topic.md"
    });
    assert.ok(first.commitSha);

    const second = await publisher.publish({
      repository,
      branchName: "magpie/topic",
      title: "docs: topic (updated)",
      markdown: "# v2\n",
      targetPath: "docs/topic.md"
    });
    assert.notEqual(second.commitSha, first.commitSha, "a new commit lands on the existing branch");
  });
});
```

> There is no `Date.now`/random restriction in the git package tests, but confirm the existing publisher test file name and whether a `test-support` helper for temp repos already exists. If it does, reuse it; if not, inline the `git init --bare` + clone + initial commit setup in the test (the existing publisher tests already do this — copy that setup).

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace packages/git`
Expected: FAIL — the second `publish` throws `Cannot publish proposal because branch magpie/topic already exists`.

- [ ] **Step 3: Make `publish` create-or-update**

In `LocalGitProposalPublisher.publish`, replace the unconditional `assertBranchDoesNotExist` + `worktree add -B ... baseRef` with branch-existence detection and two paths:

```ts
async publish(request: PublishProposalBranchRequest): Promise<PublishProposalBranchResponse> {
  const root = request.repository.git?.workTreeRoot ?? request.repository.localPath;
  const targetPath = resolveTargetPath(request.repository, request.targetPath);
  const remoteUrl = await ensureRemote(root);
  const authEnv = buildGitAuthEnv(remoteUrl);

  const remoteBranch = await tryGit(root, ["ls-remote", "--heads", "origin", request.branchName], authEnv);
  const branchExists = Boolean(remoteBranch.trim());

  const tempRoot = await mkdtemp(path.join(tmpdir(), "markdown-magpie-worktree-"));
  const worktreePath = path.join(tempRoot, "checkout");

  try {
    if (branchExists) {
      // Update path: base the worktree on the existing remote branch tip so our
      // new commit is a fast-forward — these branches are bot-owned, so the tip
      // is always our last push and no force is ever needed.
      await git(root, ["fetch", "origin", request.branchName], authEnv);
      await git(root, ["worktree", "add", "-B", request.branchName, worktreePath, `origin/${request.branchName}`]);
    } else {
      const baseRef = await resolveBaseRef(root, request.repository);
      await git(root, ["worktree", "add", "-B", request.branchName, worktreePath, baseRef]);
    }

    const absoluteTargetPath = path.resolve(worktreePath, targetPath);
    assertWithinRoot(worktreePath, absoluteTargetPath);
    await mkdir(path.dirname(absoluteTargetPath), { recursive: true });
    await writeFile(absoluteTargetPath, request.markdown, "utf8");
    await git(worktreePath, ["add", "--", targetPath]);

    const status = await git(worktreePath, ["status", "--porcelain", "--", targetPath]);
    if (!status.trim()) {
      // No content change. On the create path this is an error; on the update
      // path it just means the regenerated doc is identical — return the current tip.
      if (!branchExists) {
        throw new Error(`Proposal does not change ${targetPath}`);
      }
      const head = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
      return {
        branchName: request.branchName,
        commitSha: head,
        remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
      };
    }

    const { name: authorName, email: authorEmail } = resolveCommitterIdentity();
    await git(worktreePath, [
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${authorEmail}`,
      "commit",
      "-m",
      request.title
    ]);
    const commitSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    await git(worktreePath, ["push", "-u", "origin", request.branchName], authEnv);

    return {
      branchName: request.branchName,
      commitSha,
      remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
    };
  } finally {
    await cleanupWorktree(root, worktreePath, tempRoot);
  }
}
```

`assertBranchDoesNotExist` becomes unused — delete it and its callers, or leave it if another caller exists (grep first: `grep -rn assertBranchDoesNotExist packages apps`).

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace packages/git`
Expected: PASS, including the existing publisher tests.

- [ ] **Step 5: Commit**

```bash
git add packages/git/src/index.ts packages/git/src/*.test.ts
git commit -m "feat(git): publisher creates or updates a bot-owned branch without force push"
```

---

## Task 9: Lineage helpers (pure functions)

Deterministic rules from the spec: on merge the **oldest** PR survives; on split the **largest** child keeps the original cluster/PR; ties break by stable id ordering. Isolate these as pure functions so they are exhaustively unit-testable without a DB.

**Files:**
- Create: `apps/api/src/scheduling/gap-reconciler-lineage.ts`
- Test: `apps/api/src/scheduling/gap-reconciler-lineage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/scheduling/gap-reconciler-lineage.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectSurvivingClusterOnMerge, selectRetainingChildOnSplit } from "./gap-reconciler-lineage.js";

describe("merge lineage", () => {
  it("keeps the oldest cluster (lowest createdAt; ties by lowest id)", () => {
    const survivor = selectSurvivingClusterOnMerge([
      { id: "10", createdAt: "2026-06-02T00:00:00.000Z" },
      { id: "3", createdAt: "2026-06-01T00:00:00.000Z" },
      { id: "7", createdAt: "2026-06-01T00:00:00.000Z" }
    ]);
    // Two share the oldest createdAt; lowest id wins.
    assert.equal(survivor, "3");
  });
});

describe("split lineage", () => {
  it("keeps the largest child; ties by lowest leading gap id", () => {
    const retaining = selectRetainingChildOnSplit([
      { key: "child-a", gapIds: ["5", "9"] },
      { key: "child-b", gapIds: ["2", "4", "8"] },
      { key: "child-c", gapIds: ["1", "3", "6"] }
    ]);
    assert.equal(retaining, "child-b"); // 3 members beats 2

    const tie = selectRetainingChildOnSplit([
      { key: "child-x", gapIds: ["9", "10"] },
      { key: "child-y", gapIds: ["2", "3"] }
    ]);
    // Equal size: compare the lowest gap id numerically; child-y (2) < child-x (9).
    assert.equal(tie, "child-y");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace apps/api -- --test-name-pattern="lineage"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

```ts
// apps/api/src/scheduling/gap-reconciler-lineage.ts

export interface MergeCandidateCluster {
  id: string;
  createdAt: string; // ISO
}

// The oldest PR survives a merge. "Oldest" = earliest cluster createdAt; ties are
// broken by the lowest numeric id so the choice is fully deterministic.
export function selectSurvivingClusterOnMerge(clusters: MergeCandidateCluster[]): string {
  if (clusters.length === 0) {
    throw new Error("selectSurvivingClusterOnMerge requires at least one cluster");
  }
  return [...clusters].sort((l, r) => {
    if (l.createdAt !== r.createdAt) {
      return l.createdAt < r.createdAt ? -1 : 1;
    }
    return compareNumericIds(l.id, r.id);
  })[0].id;
}

export interface SplitChild {
  key: string;
  gapIds: string[];
}

// The largest child keeps the original cluster/PR. Ties (equal member count) are
// broken by the child whose lowest gap id is smallest, using stable member
// ordering.
export function selectRetainingChildOnSplit(children: SplitChild[]): string {
  if (children.length === 0) {
    throw new Error("selectRetainingChildOnSplit requires at least one child");
  }
  return [...children].sort((l, r) => {
    if (l.gapIds.length !== r.gapIds.length) {
      return r.gapIds.length - l.gapIds.length; // larger first
    }
    return compareNumericIds(lowestId(l.gapIds), lowestId(r.gapIds));
  })[0].key;
}

function lowestId(ids: string[]): string {
  return [...ids].sort(compareNumericIds)[0];
}

function compareNumericIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace apps/api -- --test-name-pattern="lineage"`
Expected: PASS (2 describes).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/gap-reconciler-lineage.ts apps/api/src/scheduling/gap-reconciler-lineage.test.ts
git commit -m "feat(api): deterministic merge/split lineage helpers"
```

---

## Task 10: Reconcile prompts

The reconciler proposes reshapes with one model call and verifies each with a separate critic call. Add the two prompt constants next to the existing `GAP_CLUSTERING` prompt so they live in `@magpie/prompts`.

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (add two `PromptDefinition` objects next to `GAP_CLUSTERING` at ~line 139, and append both to the `promptCatalog` array at ~line 189)

- [ ] **Step 1: Add the prompts as `PromptDefinition` objects**

Prompts in this repo are `PromptDefinition` objects (with `id`, `title`, `description`, `usedBy`, `outputShape`, `instructions`) registered in `promptCatalog`. Add two, modelled exactly on `GAP_CLUSTERING`:

```ts
export const GAP_RECONCILE_PROPOSE: PromptDefinition = {
  id: "gap-reconcile-propose",
  title: "Propose gap-cluster reshapes",
  description: "Proposes merges/splits over the current persisted gap clusters.",
  usedBy: ["api · gap reconciler"],
  outputShape: '{ merges[], splits[] }',
  instructions:
    'You are reorganising knowledge-gap clusters. Propose a MERGE only when one ' +
    'document could fully cover both clusters; propose a SPLIT only when members ' +
    'are independently addressable topics. Return JSON only with this shape: ' +
    '{"merges":[{"clusterIds":["string"],"rationale":"string"}],' +
    '"splits":[{"clusterId":"string","children":[{"gapIds":["string"]}],"rationale":"string"}]}. ' +
    'If nothing materially changes, return {"merges":[],"splits":[]}.'
};

export const GAP_RECONCILE_CRITIC: PromptDefinition = {
  id: "gap-reconcile-critic",
  title: "Critique a proposed gap-cluster reshape",
  description: "Strict reviewer that confirms or rejects a single proposed merge or split.",
  usedBy: ["api · gap reconciler"],
  outputShape: '{ confirmed, rationale }',
  instructions:
    'You are a strict reviewer of a proposed gap-cluster change. Reject unless the ' +
    'change is clearly justified. Return JSON only with this shape: ' +
    '{"confirmed":true|false,"rationale":"string"}. Default to confirmed=false when ' +
    'the evidence is weak.'
};
```

Then append both to the `promptCatalog` array:

```ts
export const promptCatalog: PromptDefinition[] = [
  // ...existing entries...
  GAP_RECONCILE_PROPOSE,
  GAP_RECONCILE_CRITIC
];
```

> The phrase "strict reviewer" in the critic instructions is relied on by the Task 11 test stub to distinguish the critic call from the propose call — keep it.

- [ ] **Step 2: Build prompts**

Run: `npm run build --workspace packages/prompts`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/prompts/src
git commit -m "feat(prompts): reconcile propose + critic prompts"
```

---

## Task 11: The reconciler job

This is the orchestration. It is split into testable units: (a) the **revision gate**, (b) the **PR-state pass** (folds in `pull-request-refresh`), (c) the **decision** (model propose + critic, applied via the lineage helpers), and (d) the **outbox processor**. Tests drive each via the in-memory stores and a stubbed chat provider; live GitHub is exercised only through injected functions so unit tests stay offline.

**Files:**
- Create: `apps/api/src/scheduling/gap-reconciler.ts`
- Test: `apps/api/src/scheduling/gap-reconciler.test.ts`

- [ ] **Step 1: Write failing tests for the revision gate and PR-state pass**

```ts
// apps/api/src/scheduling/gap-reconciler.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";

describe("reconcileGaps revision gate", () => {
  it("does no model work when the catalog revision is unchanged and no actions pending", async () => {
    const ctx = makeTestContext();
    let chatCalls = 0;
    ctx.providers.chat = () => ({
      // stub: counts calls
      complete: async () => {
        chatCalls += 1;
        return { content: "{}" };
      }
    }) as never;

    // processed revision already equals the catalog revision (both 0), no actions.
    await reconcileGaps(ctx, { fetchPullRequestStatus: async () => undefined });
    assert.equal(chatCalls, 0, "no model calls when nothing changed");
  });

  it("still runs the PR-state pass even when model work is skipped", async () => {
    const ctx = makeTestContext();
    // A proposal awaiting its PR.
    const proposal = await ctx.stores.proposals.create({
      title: "T",
      targetPath: "t.md",
      markdown: "#",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });
    await ctx.stores.proposals.recordPublication(proposal.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "sha",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });

    let lookups = 0;
    await reconcileGaps(ctx, {
      fetchPullRequestStatus: async () => {
        lookups += 1;
        return { merged: true, state: "closed" };
      }
    });
    assert.equal(lookups, 1, "open PRs are checked even with no gap changes");
    const after = await ctx.stores.proposals.get(proposal.id);
    assert.equal(after?.status, "merged", "merge detected and applied");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace apps/api -- --test-name-pattern="reconcileGaps"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reconciler skeleton with injectable GitHub deps**

```ts
// apps/api/src/scheduling/gap-reconciler.ts
import { fetchPullRequestStatus as defaultFetchPullRequestStatus } from "@magpie/git";
import type { Proposal } from "@magpie/core";
import type { AppContext } from "../context.js";
import * as proposalsService from "../features/proposals/service.js";

export interface ReconcilerDeps {
  // Injected so unit tests stay offline. Defaults to the real GitHub lookup.
  fetchPullRequestStatus: typeof defaultFetchPullRequestStatus;
}

const DEFAULT_DEPS: ReconcilerDeps = {
  fetchPullRequestStatus: defaultFetchPullRequestStatus
};

// The single reconciliation job. Always runs the PR-state pass and drains the
// publication outbox; only does model clustering work when the gap catalog
// revision has advanced past what was last processed.
export async function reconcileGaps(ctx: AppContext, deps: ReconcilerDeps = DEFAULT_DEPS): Promise<void> {
  // (b) PR-state pass — folds in the former pull-request-refresh task.
  await refreshOpenPullRequests(ctx, deps);

  const catalogRevision = await ctx.stores.questionLogs.getGapCatalogRevision();
  const processed = await ctx.stores.gapClusters.getProcessedRevision();
  const pending = await ctx.stores.gapClusters.listPendingPublicationActions();

  // (a) Revision gate.
  if (catalogRevision === processed && pending.length === 0) {
    return;
  }

  if (catalogRevision !== processed) {
    await reconcileClusters(ctx); // (c) — implemented in Step 5
    await ctx.stores.gapClusters.setProcessedRevision(catalogRevision, new Date().toISOString());
  }

  // (d) Outbox: retry pending/failed publication actions without re-running models.
  await drainPublicationOutbox(ctx, deps);
}

async function refreshOpenPullRequests(ctx: AppContext, deps: ReconcilerDeps): Promise<void> {
  const open = await ctx.stores.proposals.list(200, { status: "pr-opened" });
  for (const proposal of open) {
    const pullRequestUrl = proposal.publication?.pullRequestUrl;
    if (!pullRequestUrl) {
      continue;
    }
    let status;
    try {
      status = await deps.fetchPullRequestStatus(pullRequestUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "pull request lookup failed";
      console.warn(`PR status check failed for proposal ${proposal.id}: ${message}`);
      continue;
    }
    if (!status) {
      continue;
    }
    if (status.merged) {
      const merged = await ctx.stores.proposals.updateStatus(proposal.id, "merged");
      if (merged) {
        await proposalsService.runMergeCascade(ctx, merged);
        await freezeClusterForProposal(ctx, merged);
      }
    } else if (status.state === "closed") {
      const rejected = await ctx.stores.proposals.updateStatus(proposal.id, "rejected");
      if (rejected) {
        await freezeClusterForProposal(ctx, rejected);
      }
    }
  }
}

async function freezeClusterForProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.gapClusterId) {
    await ctx.stores.gapClusters.freezeCluster(proposal.gapClusterId);
  }
}

// Implemented in Step 5.
async function reconcileClusters(_ctx: AppContext): Promise<void> {
  // no-op until Step 5
}

// Implemented in Step 7.
async function drainPublicationOutbox(_ctx: AppContext, _deps: ReconcilerDeps): Promise<void> {
  // no-op until Step 7
}
```

- [ ] **Step 4: Run to verify the gate + PR-state tests pass**

Run: `npm run test --workspace apps/api -- --test-name-pattern="reconcileGaps"`
Expected: PASS (2 tests). The "merge detected" test confirms the cascade runs and the cluster (none linked here) freeze is a no-op.

- [ ] **Step 5: Add the assign/merge/split decision with a stubbed model**

Write a failing test first:

```ts
// add to gap-reconciler.test.ts
describe("reconcileGaps clustering", () => {
  it("assigns a brand-new gap to its own cluster when the catalog advances", async () => {
    const ctx = makeTestContext();
    const log = await ctx.stores.questionLogs.record({
      question: "How do I configure X?",
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");

    // No merges/splits proposed.
    ctx.providers.chat = () => ({ complete: async () => ({ content: '{"merges":[],"splits":[]}' }) }) as never;

    await reconcileGaps(ctx, { fetchPullRequestStatus: async () => undefined });

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 1, "the new gap created one cluster");
    const memberships = await ctx.stores.gapClusters.listActiveMemberships();
    assert.equal(memberships.length, 1);
  });

  it("does not reshape when the critic rejects the proposed merge", async () => {
    const ctx = makeTestContext();
    // Seed two clusters each with a gap (helper inserts gaps + clusters + memberships).
    await seedTwoClustersWithGaps(ctx);

    let proposeCalls = 0;
    let criticCalls = 0;
    ctx.providers.chat = () => ({
      complete: async (req: { system?: string }) => {
        // The system prompt distinguishes the critic call from the propose call.
        if ((req.system ?? "").includes("strict reviewer")) {
          criticCalls += 1;
          return { content: '{"confirmed":false,"rationale":"weak"}' };
        }
        proposeCalls += 1;
        const [a, b] = (await ctx.stores.gapClusters.listActiveClusters()).map((c) => c.id);
        return { content: `{"merges":[{"clusterIds":["${a}","${b}"],"rationale":"x"}],"splits":[]}` };
      }
    }) as never;

    const before = await ctx.stores.gapClusters.listActiveClusters();
    await reconcileGaps(ctx, { fetchPullRequestStatus: async () => undefined });
    const after = await ctx.stores.gapClusters.listActiveClusters();

    assert.ok(proposeCalls >= 1 && criticCalls >= 1, "propose then critic were called");
    assert.equal(after.length, before.length, "rejected merge left clusters unchanged");
  });
});
```

> Write `seedTwoClustersWithGaps(ctx)` as a local test helper: record two questions, `recordManualGap` on each, then `createCluster` twice and `assignGapToCluster` each gap; set the processed revision behind the catalog so the gate opens (or just leave processed at 0 since recording the gaps advanced the catalog).

Run: `npm run test --workspace apps/api -- --test-name-pattern="reconcileGaps clustering"`
Expected: FAIL (clustering is still a no-op).

- [ ] **Step 6: Implement `reconcileClusters` (assign, propose, critic, apply)**

Replace the Step-3 stub with the real logic. Implement these sub-steps in `reconcileClusters`:

```ts
import { GAP_RECONCILE_PROPOSE, GAP_RECONCILE_CRITIC } from "@magpie/prompts";
import { selectSurvivingClusterOnMerge, selectRetainingChildOnSplit } from "./gap-reconciler-lineage.js";

interface ProposedMerge { clusterIds: string[]; rationale: string }
interface ProposedSplit { clusterId: string; children: Array<{ gapIds: string[] }>; rationale: string }
interface ReshapeProposal { merges: ProposedMerge[]; splits: ProposedSplit[] }

async function reconcileClusters(ctx: AppContext): Promise<void> {
  // 1) Assign unassigned gaps to their own new cluster (per flow).
  const candidates = await ctx.stores.questionLogs.listGapCandidates(200);
  const activeMemberships = await ctx.stores.gapClusters.listActiveMemberships();
  const assignedGapIds = new Set(activeMemberships.map((m) => m.gapId));

  // listGapCandidates groups by summary, not gap row. Resolve each candidate's
  // gap rows to ids via a new store read (see note) — for the first cut, create a
  // singleton cluster per unassigned candidate keyed by its representative gap id.
  for (const candidate of candidates) {
    const gapIds = await ctx.stores.questionLogs.gapIdsForSummary(candidate.summary, candidate.flowId);
    const unassigned = gapIds.filter((id) => !assignedGapIds.has(id));
    if (unassigned.length === 0) {
      continue;
    }
    const revision = await ctx.stores.questionLogs.getGapCatalogRevision();
    const cluster = await ctx.stores.gapClusters.createCluster({
      flowId: candidate.flowId,
      title: candidate.summary.slice(0, 80),
      revision
    });
    for (const gapId of unassigned) {
      await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId, "initial assignment");
      assignedGapIds.add(gapId);
    }
  }

  // 2) Propose merges/splits over the full active set.
  const active = await ctx.stores.gapClusters.listActiveClusters();
  if (active.length < 2) {
    return; // nothing to merge; single clusters can still split but keep first cut simple
  }
  const proposal = await proposeReshape(ctx, active);

  // 3) Critic-confirm and apply each change individually.
  for (const merge of proposal.merges) {
    if (merge.clusterIds.length < 2) {
      continue;
    }
    const confirmed = await criticConfirm(ctx, "merge", merge.rationale);
    if (!confirmed) {
      continue;
    }
    await applyMerge(ctx, merge);
  }
  for (const split of proposal.splits) {
    if (split.children.length < 2) {
      continue;
    }
    const confirmed = await criticConfirm(ctx, "split", split.rationale);
    if (!confirmed) {
      continue;
    }
    await applySplit(ctx, split);
  }
}

async function proposeReshape(ctx: AppContext, active: Awaited<ReturnType<AppContext["stores"]["gapClusters"]["listActiveClusters"]>>): Promise<ReshapeProposal> {
  const summary = active
    .map((c) => `cluster ${c.id} (flow ${c.flowId ?? "none"}): ${c.title}`)
    .join("\n");
  const response = await ctx.providers.chat(ctx.config.get().aiProvider).complete({
    system: GAP_RECONCILE_PROPOSE.instructions,
    messages: [{ role: "user", content: summary }]
  });
  return parseReshape(response.content);
}

async function criticConfirm(ctx: AppContext, kind: "merge" | "split", rationale: string): Promise<boolean> {
  const response = await ctx.providers.chat(ctx.config.get().aiProvider).complete({
    system: GAP_RECONCILE_CRITIC.instructions,
    messages: [{ role: "user", content: `Proposed ${kind}. Rationale: ${rationale}` }]
  });
  try {
    const parsed = JSON.parse(response.content) as { confirmed?: boolean };
    return parsed.confirmed === true;
  } catch {
    return false; // unparseable critic = not confirmed
  }
}

function parseReshape(content: string): ReshapeProposal {
  try {
    const parsed = JSON.parse(content) as Partial<ReshapeProposal>;
    return { merges: parsed.merges ?? [], splits: parsed.splits ?? [] };
  } catch {
    return { merges: [], splits: [] };
  }
}

async function applyMerge(ctx: AppContext, merge: ProposedMerge): Promise<void> {
  const clusters = (await Promise.all(merge.clusterIds.map((id) => ctx.stores.gapClusters.getCluster(id)))).filter(
    (c): c is NonNullable<typeof c> => Boolean(c) && c.status === "active"
  );
  if (clusters.length < 2) {
    return;
  }
  const survivorId = selectSurvivingClusterOnMerge(clusters.map((c) => ({ id: c.id, createdAt: c.createdAt })));
  const revision = await ctx.stores.questionLogs.getGapCatalogRevision();
  for (const cluster of clusters) {
    if (cluster.id === survivorId) {
      continue;
    }
    const members = await ctx.stores.gapClusters.listMembershipsForCluster(cluster.id);
    for (const member of members) {
      await ctx.stores.gapClusters.assignGapToCluster(survivorId, member.gapId, "merged");
    }
    await ctx.stores.gapClusters.freezeCluster(cluster.id);
    // Supersede the merged-away cluster's open proposal, if any.
    const proposal = await proposalForCluster(ctx, cluster.id);
    if (proposal && isOpenProposal(proposal)) {
      await ctx.stores.proposals.updateStatus(proposal.id, "superseded");
      await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "supersede");
    }
  }
  await ctx.stores.gapClusters.updateCluster(survivorId, { revision });
  const survivorProposal = await proposalForCluster(ctx, survivorId);
  if (survivorProposal) {
    await ctx.stores.gapClusters.enqueuePublicationAction(survivorProposal.id, "publish");
  }
}

async function applySplit(ctx: AppContext, split: ProposedSplit): Promise<void> {
  const original = await ctx.stores.gapClusters.getCluster(split.clusterId);
  if (!original || original.status !== "active") {
    return;
  }
  const revision = await ctx.stores.questionLogs.getGapCatalogRevision();
  const children = split.children.map((child, index) => ({ key: `child-${index}`, gapIds: child.gapIds }));
  const retainingKey = selectRetainingChildOnSplit(children);

  for (const child of children) {
    if (child.key === retainingKey) {
      // The largest child keeps the original cluster: drop any members not in it.
      const members = await ctx.stores.gapClusters.listMembershipsForCluster(original.id);
      const keep = new Set(child.gapIds);
      // Members not kept will be reassigned to new clusters below; nothing to do here
      // because assignGapToCluster moves them out when a new child claims them.
      void members;
      void keep;
      continue;
    }
    const newCluster = await ctx.stores.gapClusters.createCluster({
      flowId: original.flowId,
      title: original.title,
      parentClusterId: original.id,
      revision
    });
    for (const gapId of child.gapIds) {
      await ctx.stores.gapClusters.assignGapToCluster(newCluster.id, gapId, "split");
    }
    // New child clusters need a fresh proposal — enqueue once a proposal exists
    // (manual or auto draft). For the first cut, enqueue a publish only if a
    // proposal is later linked; the draft path is handled in Task 12/registry.
  }
  await ctx.stores.gapClusters.updateCluster(original.id, { revision });
  const retainedProposal = await proposalForCluster(ctx, original.id);
  if (retainedProposal) {
    await ctx.stores.gapClusters.enqueuePublicationAction(retainedProposal.id, "publish");
  }
}

function isOpenProposal(proposal: Proposal): boolean {
  return (
    proposal.status === "draft" ||
    proposal.status === "ready" ||
    proposal.status === "branch-pushed" ||
    proposal.status === "pr-opened"
  );
}

async function proposalForCluster(ctx: AppContext, clusterId: string): Promise<Proposal | undefined> {
  const all = await ctx.stores.proposals.list(500);
  return all.find((p) => p.gapClusterId === clusterId);
}
```

> This introduces one new question-log store read, `gapIdsForSummary(summary, flowId?)`. Add it to the interface + both impls: Postgres `SELECT id::text FROM question_gaps qg JOIN questions q ON q.id = qg.question_id WHERE qg.resolved_at IS NULL AND qg.summary = $1 AND coalesce(q.flow_id,'') = coalesce($2,'')`; in-memory the analogous filter. Add a small unit test for it in `question-log-store.test.ts`. Commit it within this task.

Run: `npm run test --workspace apps/api -- --test-name-pattern="reconcileGaps clustering"`
Expected: PASS.

- [ ] **Step 7: Implement the outbox processor**

Write the failing test:

```ts
// add to gap-reconciler.test.ts
describe("reconcileGaps outbox", () => {
  it("retries a failed publish without any model call", async () => {
    const ctx = makeTestContext();
    const proposal = await ctx.stores.proposals.create({
      title: "T", targetPath: "t.md", markdown: "#", rationale: "r", evidence: [], triggeringQuestionIds: []
    });
    await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");

    let chatCalls = 0;
    ctx.providers.chat = () => ({ complete: async () => { chatCalls += 1; return { content: "{}" }; } }) as never;

    let publishCalls = 0;
    await reconcileGaps(ctx, {
      fetchPullRequestStatus: async () => undefined,
      publishProposal: async () => { publishCalls += 1; },
      supersedeProposal: async () => {}
    } as never);

    assert.equal(chatCalls, 0, "outbox retry makes no model call");
    assert.equal(publishCalls, 1, "the pending publish action ran");
    assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
  });
});
```

Extend `ReconcilerDeps` with injectable publication functions and implement `drainPublicationOutbox`:

```ts
export interface ReconcilerDeps {
  fetchPullRequestStatus: typeof defaultFetchPullRequestStatus;
  publishProposal?: (ctx: AppContext, proposal: Proposal) => Promise<void>;
  supersedeProposal?: (ctx: AppContext, proposal: Proposal) => Promise<void>;
}
```

```ts
async function drainPublicationOutbox(ctx: AppContext, deps: ReconcilerDeps): Promise<void> {
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  for (const action of actions) {
    const proposal = await ctx.stores.proposals.get(action.proposalId);
    if (!proposal) {
      await ctx.stores.gapClusters.markPublicationActionDone(action.id);
      continue;
    }
    try {
      if (action.kind === "publish") {
        await (deps.publishProposal ?? defaultPublish)(ctx, proposal);
      } else {
        await (deps.supersedeProposal ?? defaultSupersede)(ctx, proposal);
      }
      await ctx.stores.gapClusters.markPublicationActionDone(action.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "publication failed";
      await ctx.stores.gapClusters.markPublicationActionFailed(action.id, message);
      console.warn(`Publication action ${action.id} failed: ${message}`);
    }
  }
}

async function defaultPublish(ctx: AppContext, proposal: Proposal): Promise<void> {
  // Re-fetch live PR state immediately before mutating (spec: defend against a
  // state change between reconciliation and publication).
  const result = await proposalsService.publishReadyProposal(ctx, proposal);
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.message}`);
  }
}

async function defaultSupersede(_ctx: AppContext, _proposal: Proposal): Promise<void> {
  // Closing the PR on GitHub is host-specific; implemented when closePullRequest
  // lands in @magpie/git. Until then, the DB status is already 'superseded' and
  // this is a no-op that completes the action.
}
```

Run: `npm run test --workspace apps/api -- --test-name-pattern="reconcileGaps outbox"`
Expected: PASS.

- [ ] **Step 8: Run the whole reconciler test file + full api suite**

Run: `npm run test --workspace apps/api -- --test-name-pattern="reconcileGaps"`
Expected: PASS (all describes).
Run: `npm run test --workspace apps/api`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/scheduling/gap-reconciler.ts apps/api/src/scheduling/gap-reconciler.test.ts apps/api/src/stores/question-log-store.ts apps/api/src/stores/postgres-question-log-store.ts
git commit -m "feat(api): gap reconciler — revision gate, PR-state pass, critic-confirmed reshapes, outbox"
```

---

## Task 12: Read path — `GET /api/gaps/clusters` from the store

**Files:**
- Modify: `apps/api/src/features/gaps/service.ts` (`listClusters`)
- Test: `apps/api/src/features/gaps/service.test.ts` (add/confirm)

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/features/gaps/service.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestContext } from "../../test-support/context.js";
import * as gaps from "./service.js";

test("listClusters reads persisted active clusters and makes no model call", async () => {
  const ctx = makeTestContext();
  let chatCalls = 0;
  ctx.providers.chat = () => ({ complete: async () => { chatCalls += 1; return { content: "{}" }; } }) as never;

  const cluster = await ctx.stores.gapClusters.createCluster({ flowId: "f", title: "Cheese", rationale: "r", revision: 1 });

  const result = await gaps.listClusters(ctx, 50);
  assert.equal(chatCalls, 0, "no clustering model call on read");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, cluster.id);
  assert.equal(result[0].status, "active");
  assert.equal(result[0].title, "Cheese");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace apps/api -- --test-name-pattern="listClusters reads persisted"`
Expected: FAIL — current `listClusters` calls the model and returns `SuggestedGapCluster[]`.

- [ ] **Step 3: Rewrite `listClusters` to read the store**

```ts
import type { PersistedGapCluster } from "@magpie/core";

export async function listClusters(ctx: AppContext, limit: number): Promise<PersistedGapCluster[]> {
  const clusters = await ctx.stores.gapClusters.listActiveClusters();
  const proposals = await ctx.stores.proposals.list(500);
  const proposalByCluster = new Map(proposals.filter((p) => p.gapClusterId).map((p) => [p.gapClusterId as string, p]));

  const result: PersistedGapCluster[] = [];
  for (const cluster of clusters.slice(0, limit)) {
    const memberships = await ctx.stores.gapClusters.listMembershipsForCluster(cluster.id);
    const gapIds = memberships.map((m) => m.gapId);
    const { summaries, questionIds } = await ctx.stores.questionLogs.gapDetailsForIds(gapIds);
    const proposal = proposalByCluster.get(cluster.id);
    result.push({
      id: cluster.id,
      title: cluster.title,
      summaries,
      questionIds,
      count: questionIds.length,
      rationale: cluster.rationale,
      flowId: cluster.flowId,
      status: "active",
      proposalId: proposal?.id,
      proposalStatus: proposal?.status,
      lastReconciledAt: cluster.updatedAt
    });
  }
  return result;
}
```

> Add `gapDetailsForIds(gapIds: string[]): Promise<{ summaries: string[]; questionIds: string[] }>` to the question-log store interface + both impls. Postgres: `SELECT summary, question_id FROM question_gaps WHERE id = ANY($1::bigint[])`. In-memory: filter the gap map. Add a unit test for it. The existing `clusterGapCandidates` / `requestGapClusters` functions are now only used by tests — leave them or delete if `knip` flags them (run `npm run lint`).

- [ ] **Step 4: Run the tests**

Run: `npm run test --workspace apps/api -- --test-name-pattern="listClusters"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/gaps/service.ts apps/api/src/features/gaps/service.test.ts apps/api/src/stores/question-log-store.ts apps/api/src/stores/postgres-question-log-store.ts
git commit -m "feat(api): GET /gaps/clusters reads persisted clusters with no model call"
```

---

## Task 13: Manual cluster→proposal endpoint

**Files:**
- Modify: `apps/api/src/features/gaps/routes.ts`
- Modify: `apps/api/src/features/gaps/service.ts` (add `draftFromCluster`)
- Test: `apps/api/src/features/gaps/service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("draftFromCluster creates a proposal, links the cluster, and enqueues a publish action", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const gapIds = await ctx.stores.questionLogs.gapIdsForSummary("How to configure X");
  const cluster = await ctx.stores.gapClusters.createCluster({ title: "Configure X", revision: 1 });
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapIds[0]);

  const outcome = await gaps.draftFromCluster(ctx, cluster.id, {});
  assert.equal(outcome.ok, true);

  const proposals = await ctx.stores.proposals.list(50);
  const linked = proposals.find((p) => p.gapClusterId === cluster.id);
  assert.ok(linked, "a proposal is linked to the cluster");

  const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.equal(pending.some((a) => a.proposalId === linked!.id && a.kind === "publish"), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace apps/api -- --test-name-pattern="draftFromCluster"`
Expected: FAIL — `draftFromCluster` not exported.

- [ ] **Step 3: Implement `draftFromCluster`**

```ts
export async function draftFromCluster(
  ctx: AppContext,
  clusterId: string,
  overrides: { targetPath?: string; destinationId?: string }
) {
  const cluster = await ctx.stores.gapClusters.getCluster(clusterId);
  if (!cluster || cluster.status !== "active") {
    return { ok: false as const, code: "cluster_not_found" };
  }
  const memberships = await ctx.stores.gapClusters.listMembershipsForCluster(clusterId);
  const { summaries } = await ctx.stores.questionLogs.gapDetailsForIds(memberships.map((m) => m.gapId));
  const outcome = await draftFromGaps(ctx, summaries, {
    flowId: cluster.flowId,
    targetPath: overrides.targetPath,
    destinationId: overrides.destinationId
  });
  if (!outcome.ok) {
    return outcome;
  }
  // Link and enqueue only the direct-mode proposal; queue-mode proposals link when
  // the job completes (handle in createProposalFromCompletedJob if needed).
  if (outcome.mode === "direct") {
    await ctx.stores.proposals.linkCluster(outcome.proposal.id, clusterId);
    await ctx.stores.gapClusters.enqueuePublicationAction(outcome.proposal.id, "publish");
  }
  return outcome;
}
```

Add the route to `gaps/routes.ts`:

```ts
app.post("/clusters/:id/proposal", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const outcome = await gapsService.draftFromCluster(ctx, id, {
    targetPath: typeof body.targetPath === "string" ? body.targetPath : undefined,
    destinationId: typeof body.destinationId === "string" ? body.destinationId : undefined
  });
  if (!outcome.ok) {
    return c.json({ error: outcome.code }, 404);
  }
  return c.json(outcome);
});
```

> `draftFromGaps` is already exported from `gaps`/`proposals` service — confirm the import path (it lives in `features/proposals/service.ts`; re-export or import it into `gaps/service.ts`).

- [ ] **Step 4: Run the tests**

Run: `npm run test --workspace apps/api -- --test-name-pattern="draftFromCluster"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/gaps/service.ts apps/api/src/features/gaps/routes.ts apps/api/src/features/gaps/service.test.ts
git commit -m "feat(api): manual cluster-to-proposal endpoint enqueues a publish action"
```

---

## Task 14: Task registry — one reconciler, fold in pull-request-refresh

**Files:**
- Modify: `apps/api/src/scheduling/task-registry.ts`
- Test: `apps/api/src/scheduling/task-registry.test.ts` (confirm/create)

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/scheduling/task-registry.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduledTaskDefinitions, findScheduledTask } from "./task-registry.js";

test("the registry has a single gaps-to-pull-requests reconciler at 10-minute cadence", () => {
  assert.equal(findScheduledTask("pull-request-refresh"), undefined, "separate refresh task is removed");
  const reconciler = findScheduledTask("gaps-to-pull-requests");
  assert.ok(reconciler);
  assert.equal(reconciler!.defaultCron, "*/10 * * * *");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace apps/api -- --test-name-pattern="single gaps-to-pull-requests"`
Expected: FAIL — `pull-request-refresh` still exists; cron is `0 * * * *`.

- [ ] **Step 3: Update the registry**

- Remove the `pull-request-refresh` entry from `scheduledTaskDefinitions` and delete the now-unused `refreshPullRequests` function (its logic now lives in `gap-reconciler.ts`).
- Change the `gaps-to-pull-requests` entry: `defaultCron: "*/10 * * * *"`, rewrite its `description` to "Reconciles knowledge gaps into clusters and proposals, detects merged/closed pull requests, and publishes open proposals. Requires GITHUB_TOKEN for PR operations.", and set `run: runGapReconciler`.
- Replace `processGapsIntoPullRequests` with a thin wrapper that calls the reconciler:

```ts
import { reconcileGaps } from "./gap-reconciler.js";

async function runGapReconciler(ctx: AppContext): Promise<void> {
  await reconcileGaps(ctx);
}
```

- Delete `coveredGapSummaries`, `processGapsIntoPullRequests`, and the now-unused imports (`selectClustersToDraft`, `fetchPullRequestStatus`) from `task-registry.ts` — the reconciler owns these concerns now. Run `npm run lint` to catch leftovers.

> Cross-instance single-run: the spec calls for the reconciler to run as a single claimed job via the existing AI-job claim-lease. The current scheduler runs task handlers in-process. If multi-instance deployment is in scope now, the registry handler should `enqueue` a reconciler job (a new `AiJobType`) and let the watcher claim it, rather than running inline. If deployment is single-instance today, running inline is correct and the claim-lease migration is deferred — **decide with the team before implementing**; default to inline (single handler) to match current behavior and note the follow-up.

- [ ] **Step 4: Run the tests + full suite**

Run: `npm run test --workspace apps/api -- --test-name-pattern="single gaps-to-pull-requests"`
Expected: PASS.
Run: `npm run test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/task-registry.ts apps/api/src/scheduling/task-registry.test.ts
git commit -m "feat(api): single gap reconciler task absorbs pull-request-refresh, 10-min cadence"
```

---

## Task 15: Backfill migration — one cluster per existing proposal

**Files:**
- Create: `packages/db/migrations/0017_backfill_gap_clusters.sql`

- [ ] **Step 1: Write the backfill**

```sql
-- Backfill one active cluster per existing proposal from its gap summaries and
-- triggering question ids, linking proposals.gap_cluster_id. Merged/rejected
-- proposals' clusters are frozen; others stay active. A gap claimed by more than
-- one proposal goes to the active proposal first, then the lowest proposal id —
-- enforced by the unique active-membership index plus ordered insertion.

-- One cluster per proposal (active proposals first so they win the gap claim).
INSERT INTO gap_clusters (flow_id, title, rationale, status, reconciliation_revision)
SELECT
  q.flow_id,
  left(coalesce(p.title, 'Knowledge Gap'), 80),
  p.rationale,
  CASE WHEN p.status IN ('merged', 'rejected', 'superseded') THEN 'frozen' ELSE 'active' END,
  0
FROM proposals p
LEFT JOIN LATERAL (
  SELECT q.flow_id
  FROM unnest(p.triggering_question_ids) AS tq(id)
  JOIN questions q ON q.id = tq.id
  LIMIT 1
) q ON true;
```

> The above inserts clusters but does not yet link proposals or memberships, because mapping needs the new cluster ids. Implement the link + memberships as a follow-up DO block or, preferably, as a one-shot backfill function run at startup. **Recommended:** instead of doing the membership mapping in SQL, add an idempotent `backfillGapClusters()` to the gap-cluster store called once on boot when `listActiveClusters()` is empty but proposals exist — it can use the store APIs (createCluster → assignGapToCluster via `gapIdsForSummary` → linkCluster) with the active-proposal-first ordering, which is far easier to test than SQL. Write that function test-first (in-memory) before wiring it into `bootstrap()`.

- [ ] **Step 2: Decide SQL-only vs store backfill, implement the chosen path test-first**

If store-based backfill is chosen (recommended): delete this SQL file, add `backfillGapClusters(ctx)` with a unit test asserting: active proposal claims a shared gap; merged proposal's cluster is frozen; every gap lands in exactly one active cluster.

- [ ] **Step 3: Verify on a throwaway DB**

Run: `npm run test:db -- --workspace apps/api -- --test-name-pattern="backfill"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db/migrations apps/api/src
git commit -m "feat(api): backfill one cluster per existing proposal"
```

---

## Task 16: Docs + full verification

**Files:**
- Modify: `docs/api.md`

- [ ] **Step 1: Document the API changes**

In `docs/api.md`, update the `GET /api/gaps/clusters` entry to describe the `PersistedGapCluster` fields (`status`, `proposalId`, `proposalStatus`, `lastReconciledAt`) and add `POST /api/gaps/clusters/:id/proposal` (body `{ targetPath?, destinationId? }`; creates and links a proposal, returns the draft outcome).

- [ ] **Step 2: Run the full verification suite**

Run:
```bash
npm run lint
npm run typecheck
npm run test
npm run test:db
```
Expected: all exit 0. Fix any `knip` dead-code findings from removed functions (e.g. `requestGapClusters`, `assertBranchDoesNotExist`).

- [ ] **Step 3: Commit**

```bash
git add docs/api.md
git commit -m "docs(api): persisted gap clusters response and manual cluster-to-proposal endpoint"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** persistent model (Tasks 1,3,4,7,15); revision gate (Tasks 6,11); single reconciler absorbing pull-request-refresh (Tasks 11,14); critic-confirmed reshape with lineage (Tasks 9,10,11); create-or-update publisher (Task 8); outbox idempotency (Tasks 3,11); superseded status (Tasks 2,7); read path + API (Tasks 12,13); reset FK order (Task 4 `reset`). 
- **Known design seam to confirm with the team (Task 14):** whether the reconciler runs inline in the scheduler (single-instance, current behavior) or is enqueued as a claimed AI job (multi-instance). The spec assumes the claim-lease; default here is inline with a noted follow-up so the plan ships working software either way.
- **New question-log store methods introduced across tasks** (add to interface + both impls, each with a test): `getGapCatalogRevision`, `gapIdsForSummary`, `gapDetailsForIds`. Keep their names exactly as written — they are referenced by Tasks 11, 12, 13.
- **Chat provider call shape (confirmed against `gaps/service.ts:65`):** `ctx.providers.chat(provider).complete({ system: PROMPT.instructions, messages: [{ role: "user", content }] })` returning `{ content }`. The system prompt is the `system:` field — NOT a `role: "system"` message — so test stubs distinguish prompts by inspecting `req.system`.
