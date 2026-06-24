# Route source-sync through the reconcile gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the source-sync lens run its changeset through the shared reconcile gate before publishing, so a source-sync change that overlaps an open gap PR is deferred-and-preserved instead of landing a rival change on the same file.

**Architecture:** A one-way guard ("Scope A") at the source-sync completion hook builds a `ChangeIntent` from the derived changeset and calls `decideReconciliation` against the same-flow open proposals. No overlap → publish as today. Overlap (`fold` **or** `defer`) → persist the changeset on a new `deferred` run and publish nothing. A deferred run is re-gated at the top of the next source-sync tick and publishes once its overlap clears.

**Tech Stack:** TypeScript ESM monorepo, npm workspaces, Node built-in test runner (`node --import tsx --test`), zod, pg. The reconcile gate (`apps/api/src/scheduling/reconcile-gate.ts`) and `ChangeIntent` (`apps/api/src/scheduling/intent.ts`) already exist.

**Spec:** [`docs/superpowers/specs/2026-06-24-source-sync-through-gate-design.md`](../specs/2026-06-24-source-sync-through-gate-design.md)

## Global Constraints

- **Scope A only.** Source-sync stays changeset-based; the gate is a one-way guard at its completion hook against open **gap proposals** in the same flow. Scope B (source-sync as a first-class `Proposal`, symmetric gate, real LLM fold) is the documented end-state, NOT built here — call it out in a prominent comment at the gate hook.
- **Overlap ⇒ defer-and-preserve.** Both `fold` and `defer` verdicts collapse to one action for this lens: `deferRun` (persist changeset, publish nothing). No LLM fold is built.
- **Non-lossy.** Source-sync advances its baseline SHA at enqueue, so a deferred run's persisted changeset is the only record of that change — never drop it.
- **Re-gate on the next tick.** Deferred runs are re-evaluated at the top of `triggerSourceSyncRun` for the flow; overlap-cleared → publish, else stay deferred.
- **No DB migration.** `source_sync_runs.status` is `text NOT NULL DEFAULT 'running'` with no `CHECK` (migration `0013`); `changeset` already persists as JSON.
- **knip is STRICT** (`npm run deadcode`): every new export must be used cross-file. Keep `sameFlow` file-local in `flow.ts` (used only within that file); export only `proposalFlowId` and `sameFlowOpenProposals`.
- **ESM:** local imports use a `.js` suffix; `@magpie/*` imports do not.
- **UK English** in comments and docs.
- Pre-push gates: root `npm run typecheck`, root `npm run deadcode`, root `npm test` (all workspaces) must pass. Two tests fail only on local Windows and pass on CI Linux (a watcher "rewrites API-host paths" test and a `cat`-based stdin test) — not regressions.

---

### Task 1: `deferred` run state + store methods

Adds the `deferred` status to the core type and the three store methods that drive it, on both the in-memory and Postgres source-sync stores, with in-memory unit tests.

**Files:**
- Modify: `packages/core/src/index.ts` (the `SourceSyncRunStatus` union, ~line 540)
- Modify: `apps/api/src/stores/source-sync-store.ts` (interface + `InMemorySourceSyncStore`)
- Modify: `apps/api/src/stores/postgres-source-sync-store.ts` (`PostgresSourceSyncStore`)
- Create: `apps/api/src/stores/source-sync-store.test.ts`

**Interfaces:**
- Produces:
  - `SourceSyncStore.deferRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined>` — `running → deferred`, persists plan + changeset, no `completedAt`, no publication. No-op on a non-running run.
  - `SourceSyncStore.listDeferredRuns(flowId: string | undefined): Promise<SourceSyncRun[]>` — deferred runs in the flow (default flow = `undefined`), newest first.
  - `SourceSyncStore.completeDeferredRun(id: string): Promise<SourceSyncRun | undefined>` — `deferred → completed` (plan/changeset already present), sets `completedAt`. No-op on a non-deferred run.

- [ ] **Step 1: Add `"deferred"` to the status union**

In `packages/core/src/index.ts`, replace the `SourceSyncRunStatus` declaration (around line 537-540):

```ts
// "skipped" records a detected source change that needed no KB edit (nothing in
// the KB matched it, or the model returned an empty plan) — kept for the operator
// to see that the change was considered. "deferred" records a change whose target
// file-set overlaps an open PR in the same flow: the changeset is preserved and
// re-gated on a later source-sync tick rather than published as a rival (see
// docs/maintenance-redesign.md §5 and the source-sync gate hook).
export type SourceSyncRunStatus = "running" | "completed" | "failed" | "published" | "skipped" | "deferred";
```

- [ ] **Step 2: Write the failing store unit tests**

Create `apps/api/src/stores/source-sync-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangesetChange, CrunchPlan } from "@magpie/core";
import { InMemorySourceSyncStore } from "./source-sync-store.js";

const PLAN: CrunchPlan = { summary: "s", operations: [], rationale: "r" };
const CHANGESET: ChangesetChange[] = [{ path: "guide.md", content: "x" }];

async function runningRun(store: InMemorySourceSyncStore, flowId?: string) {
  return store.createRun({
    flowId,
    sourceId: "src-1",
    trigger: "scheduled",
    status: "running",
    toSha: "head",
    changedFileCount: 1,
    candidateCount: 1
  });
}

test("deferRun moves a running run to deferred and preserves plan + changeset", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store);
  const deferred = await store.deferRun(run.id, PLAN, CHANGESET);
  assert.equal(deferred?.status, "deferred");
  assert.deepEqual(deferred?.changeset, CHANGESET);
  assert.deepEqual(deferred?.plan, PLAN);
  assert.equal(deferred?.completedAt, undefined);
});

test("deferRun is a no-op on a non-running run", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store);
  await store.completeRun(run.id, PLAN, CHANGESET); // now "completed"
  const deferred = await store.deferRun(run.id, PLAN, CHANGESET);
  assert.equal(deferred?.status, "completed");
});

test("completeDeferredRun moves a deferred run to completed and stamps completedAt", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store);
  await store.deferRun(run.id, PLAN, CHANGESET);
  const completed = await store.completeDeferredRun(run.id);
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.changeset, CHANGESET);
  assert.ok(completed?.completedAt, "completedAt stamped");
});

test("completeDeferredRun is a no-op on a non-deferred run", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store); // still "running"
  const result = await store.completeDeferredRun(run.id);
  assert.equal(result?.status, "running");
});

test("listDeferredRuns returns only deferred runs for the given flow", async () => {
  const store = new InMemorySourceSyncStore();
  const a = await runningRun(store);            // default flow
  const b = await runningRun(store, "flow-x");  // other flow
  const c = await runningRun(store);            // default flow, stays running
  await store.deferRun(a.id, PLAN, CHANGESET);
  await store.deferRun(b.id, PLAN, CHANGESET);
  // c stays running
  const defaultFlow = await store.listDeferredRuns(undefined);
  assert.deepEqual(defaultFlow.map((r) => r.id), [a.id]);
  const flowX = await store.listDeferredRuns("flow-x");
  assert.deepEqual(flowX.map((r) => r.id), [b.id]);
  assert.equal(c.status, "running");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test --workspace @magpie/api -- --test-name-pattern="deferRun|completeDeferredRun|listDeferredRuns"`
Expected: FAIL — `deferRun`/`completeDeferredRun`/`listDeferredRuns` are not functions on the store.

- [ ] **Step 4: Add the three methods to the store interface**

In `apps/api/src/stores/source-sync-store.ts`, add to the `SourceSyncStore` interface (after `markSkipped`, before `failRun`):

```ts
  // running → deferred: the run's target file-set overlaps an open PR in the same
  // flow, so its changeset is preserved (never published as a rival) and re-gated
  // on a later tick. Persists plan + changeset; sets no completedAt; enqueues no
  // publication. No-op on a run that is no longer "running".
  deferRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined>;
  // The re-gate worklist: deferred runs for a flow (default flow = undefined).
  listDeferredRuns(flowId: string | undefined): Promise<SourceSyncRun[]>;
  // deferred → completed: the overlap cleared, so the preserved changeset becomes
  // publishable through the normal publish pre-flight. No-op on a non-deferred run.
  completeDeferredRun(id: string): Promise<SourceSyncRun | undefined>;
```

- [ ] **Step 5: Implement the methods on `InMemorySourceSyncStore`**

In the same file, add to `InMemorySourceSyncStore` (after `markSkipped`):

```ts
  async deferRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined> {
    // Reuses the running-only guard: deferral is a transition out of "running",
    // like completeRun/markSkipped, but leaves completedAt unset (deferred is a
    // waiting state, not terminal).
    return this.transitionFromRunning(id, { status: "deferred", plan, changeset, error: undefined });
  }

  async listDeferredRuns(flowId: string | undefined): Promise<SourceSyncRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.status === "deferred" && (run.flowId ?? "") === (flowId ?? ""))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async completeDeferredRun(id: string): Promise<SourceSyncRun | undefined> {
    const existing = this.runs.get(id);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "deferred") {
      return existing;
    }
    const updated: SourceSyncRun = { ...existing, status: "completed", completedAt: new Date().toISOString() };
    this.runs.set(id, updated);
    return updated;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test --workspace @magpie/api -- --test-name-pattern="deferRun|completeDeferredRun|listDeferredRuns"`
Expected: PASS (5 tests).

- [ ] **Step 7: Implement the methods on `PostgresSourceSyncStore`**

In `apps/api/src/stores/postgres-source-sync-store.ts`, add to `PostgresSourceSyncStore` (after `markSkipped`):

```ts
  async deferRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined> {
    // running → deferred. No completed_at: deferred is a waiting state. Guarded by
    // status = 'running' so a re-delivered completion never regresses a later state.
    return this.transitionFromRunning(
      "UPDATE source_sync_runs SET status = 'deferred', plan = $2, changeset = $3, error = NULL WHERE id = $1 AND status = 'running' RETURNING *",
      [id, JSON.stringify(plan), JSON.stringify(changeset)],
      id
    );
  }

  async listDeferredRuns(flowId: string | undefined): Promise<SourceSyncRun[]> {
    // The default flow stores flow_id as NULL (see runFlowId), so match it with IS NULL.
    const result =
      flowId === undefined
        ? await this.pool.query<SourceSyncRunRow>(
            "SELECT * FROM source_sync_runs WHERE status = 'deferred' AND flow_id IS NULL ORDER BY created_at DESC"
          )
        : await this.pool.query<SourceSyncRunRow>(
            "SELECT * FROM source_sync_runs WHERE status = 'deferred' AND flow_id = $1 ORDER BY created_at DESC",
            [flowId]
          );
    return result.rows.map(mapRunRow);
  }

  async completeDeferredRun(id: string): Promise<SourceSyncRun | undefined> {
    // deferred → completed. Guarded by status = 'deferred'; on no match fall back to
    // the current row so a re-gate that races itself is an idempotent no-op.
    const result = await this.pool.query<SourceSyncRunRow>(
      "UPDATE source_sync_runs SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'deferred' RETURNING *",
      [id]
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : this.getRun(id);
  }
```

- [ ] **Step 8: Run the full gate set, then commit**

Run: `npm run typecheck` (expect exit 0), `npm test --workspace @magpie/api` (expect 0 failures; 1 postgres-store test skips without `DATABASE_URL`).

```bash
git add packages/core/src/index.ts apps/api/src/stores/source-sync-store.ts apps/api/src/stores/postgres-source-sync-store.ts apps/api/src/stores/source-sync-store.test.ts
git commit -m "feat(source-sync): add deferred run state and store methods"
```

---

### Task 2: Shared flow helper + fold.ts refactor

Extracts the flow-resolution helpers that are currently file-local in `fold.ts` into a shared module so source-sync can reuse them, and refactors `fold.ts` to consume them. Pure refactor — behaviour is unchanged and the existing fold tests are the regression gate.

**Files:**
- Create: `apps/api/src/scheduling/flow.ts`
- Modify: `apps/api/src/scheduling/fold.ts` (remove local `sameFlow` + `proposalFlowId`; gather candidates via the helper)

**Interfaces:**
- Consumes (Task 1): nothing.
- Produces:
  - `proposalFlowId(ctx: AppContext, proposal: Proposal): Promise<string | undefined>`
  - `sameFlowOpenProposals(ctx: AppContext, flowId: string | undefined, excludeId?: string): Promise<Proposal[]>` — open proposals (`list(200)`) in `flowId`, optionally excluding one id.

- [ ] **Step 1: Create the shared flow module**

Create `apps/api/src/scheduling/flow.ts`:

```ts
import type { Proposal } from "@magpie/core";
import type { AppContext } from "../context.js";

// File-local: knip runs strict, and sameFlow is used only within this module.
// Two flow ids are "the same flow" when they are equal, treating undefined (the
// un-routed/default flow) as a single bucket.
function sameFlow(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

// A proposal's owning flow is its cluster's flow; a cluster-less proposal belongs
// to the un-routed/default flow.
export async function proposalFlowId(ctx: AppContext, proposal: Proposal): Promise<string | undefined> {
  if (!proposal.gapClusterId) {
    return undefined;
  }
  const cluster = await ctx.stores.gapClusters.getCluster(proposal.gapClusterId);
  return cluster?.flowId;
}

// The open proposals in one flow — the gate's candidate set. Lists up to 200 open
// proposals (merged excluded by the store's default filter) and keeps those whose
// owning flow matches, optionally excluding one proposal by id (e.g. the rival
// itself in the at-draft fold path).
export async function sameFlowOpenProposals(
  ctx: AppContext,
  flowId: string | undefined,
  excludeId?: string
): Promise<Proposal[]> {
  const out: Proposal[] = [];
  for (const proposal of await ctx.stores.proposals.list(200)) {
    if (excludeId && proposal.id === excludeId) {
      continue;
    }
    if (!sameFlow(await proposalFlowId(ctx, proposal), flowId)) {
      continue;
    }
    out.push(proposal);
  }
  return out;
}
```

- [ ] **Step 2: Refactor `fold.ts` to consume the helper**

In `apps/api/src/scheduling/fold.ts`:

Replace the import block at the top — remove nothing existing except add the new import. After the existing `import { decideReconciliation, openPullRequestSummaries } from "./reconcile-gate.js";` line, add:

```ts
import { proposalFlowId, sameFlowOpenProposals } from "./flow.js";
```

Delete the now-duplicated local helpers (the `sameFlow` function at lines ~9-11 and the `proposalFlowId` function at lines ~15-21).

In `reconcileDraftedProposal`, replace the flow resolution and candidate-gathering block:

```ts
  const flowId = await proposalFlowId(ctx, rival);
  const candidates: Proposal[] = [];
  for (const proposal of await ctx.stores.proposals.list(200)) {
    if (proposal.id === rival.id) {
      continue;
    }
    if (!sameFlow(await proposalFlowId(ctx, proposal), flowId)) {
      continue;
    }
    candidates.push(proposal);
  }
```

with:

```ts
  const flowId = await proposalFlowId(ctx, rival);
  const candidates = await sameFlowOpenProposals(ctx, flowId, rival.id);
```

(The `Proposal` type import in `fold.ts` stays — it is still used in other signatures.)

- [ ] **Step 3: Run the fold + scheduling tests (regression)**

Run: `npm test --workspace @magpie/api -- --test-name-pattern="fold|reconcile|draft"`
Expected: PASS — behaviour is unchanged; the helper produces the same candidate set.

- [ ] **Step 4: Typecheck + deadcode, then commit**

Run: `npm run typecheck` (expect 0), `npm run deadcode` (expect 0 — `proposalFlowId` and `sameFlowOpenProposals` are both used cross-file; `sameFlow` is file-local).

```bash
git add apps/api/src/scheduling/flow.ts apps/api/src/scheduling/fold.ts
git commit -m "refactor(scheduling): extract shared flow helpers for the gate"
```

---

### Task 3: Gate hook at the source-sync completion

Runs the reconcile gate at `attachSourceSyncPlanFromCompletedJob`: no overlap publishes as today; overlap defers-and-preserves.

**Files:**
- Modify: `apps/api/src/features/source-sync/service.ts`
- Modify: `apps/api/src/features/source-sync/orchestration.test.ts` (add overlap tests)

**Interfaces:**
- Consumes: `deferRun` (Task 1); `sameFlowOpenProposals` (Task 2); `decideReconciliation`, `openPullRequestSummaries` (`reconcile-gate.ts`); `ChangeIntent` (`intent.ts`); `normalizeRelativePath` (already imported).
- Produces (used by Task 4): `function sourceSyncIntent(run: SourceSyncRun, changeset: ChangesetChange[], evidence?: string[]): ChangeIntent` in `service.ts`.

- [ ] **Step 1: Add imports to `service.ts`**

In `apps/api/src/features/source-sync/service.ts`, add these imports (the `@magpie/core` and `@magpie/git` import groups already exist — add the scheduling imports):

```ts
import type { ChangeIntent } from "../../scheduling/intent.js";
import { decideReconciliation, openPullRequestSummaries } from "../../scheduling/reconcile-gate.js";
import { sameFlowOpenProposals } from "../../scheduling/flow.js";
```

Ensure `ChangesetChange` and `SourceSyncRun` are in the existing `import type { ... } from "@magpie/core";` group (both already are).

- [ ] **Step 2: Write the failing overlap tests**

In `apps/api/src/features/source-sync/orchestration.test.ts`, add these two tests at the end of the file (they reuse the existing `seed`, `baselineAtParent`, `PLAN`, `FakeJobBroker`, and `completeJob`):

```ts
test("a source-sync change that overlaps a touchable open PR is deferred, not published", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const jobId = run.jobId!;

    // An open (draft = touchable) gap proposal already targets the same file the
    // source-sync changeset will write (guide.md), in the default flow.
    await ctx.stores.proposals.create({
      title: "Guide", targetPath: "guide.md", markdown: "# Guide", rationale: "r",
      evidence: [], triggeringQuestionIds: []
    });

    const outcome = await completeJob(ctx, jobId, PLAN);
    assert.equal(outcome.ok, true);

    const after = await ctx.stores.sourceSync.getRun(run.id);
    assert.equal(after?.status, "deferred");
    assert.equal(after?.changeset?.length, 1, "changeset preserved on the deferred run");
    assert.equal(after?.changeset?.[0].path, "guide.md");

    // No rival published.
    assert.equal((await ctx.jobs.list({})).jobs.filter((j) => j.type === "publish_source_sync").length, 0);
  } finally {
    await cleanup();
  }
});

test("a source-sync change that overlaps an approved PR is also deferred", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const jobId = run.jobId!;

    const proposal = await ctx.stores.proposals.create({
      title: "Guide", targetPath: "guide.md", markdown: "# Guide", rationale: "r",
      evidence: [], triggeringQuestionIds: []
    });
    await ctx.stores.proposals.updateReviewDecision(proposal.id, "approved");

    const outcome = await completeJob(ctx, jobId, PLAN);
    assert.equal(outcome.ok, true);

    const after = await ctx.stores.sourceSync.getRun(run.id);
    assert.equal(after?.status, "deferred");
    assert.equal((await ctx.jobs.list({})).jobs.filter((j) => j.type === "publish_source_sync").length, 0);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npm test --workspace @magpie/api -- --test-name-pattern="overlaps a touchable|overlaps an approved"`
Expected: FAIL — the run completes and a `publish_source_sync` job is enqueued (current behaviour), so `status` is `"completed"`, not `"deferred"`.

- [ ] **Step 4: Add the intent helper and the gate block**

In `apps/api/src/features/source-sync/service.ts`, add the intent helper near the other pure helpers (above `buildRetrievalQuery`):

```ts
// Builds the source-sync change intent for the gate. decideReconciliation consumes
// only `targets`; `evidence` and `rationale` are populated best-effort for logging
// and the future Scope B fold. Targets are normalised to match how Proposal.targetPath
// is stored, since the gate compares file-sets by exact string match.
function sourceSyncIntent(run: SourceSyncRun, changeset: ChangesetChange[], evidence: string[] = []): ChangeIntent {
  return {
    lens: "source-sync",
    flowId: run.flowId,
    targets: changeset.map((change) => normalizeRelativePath(change.path)),
    evidence,
    rationale: `source-sync ${run.sourceId} ${run.fromSha ?? "?"}..${run.toSha}`
  };
}

// The source files that changed, read back from the plan job input for the intent's
// evidence. Best-effort: the input was validated at enqueue, so a parse failure is
// not expected; degrade to an empty list rather than throwing in the completion path.
function readChangedSourcePaths(input: unknown): string[] {
  const parsed = syncSourceChangesGeneratePlanInputSchema.safeParse(input);
  return parsed.success ? parsed.data.changes.map((change) => change.path) : [];
}
```

Then, in `attachSourceSyncPlanFromCompletedJob`, replace the publication tail:

```ts
  await ctx.stores.sourceSync.completeRun(run.id, parsed.data, changeset);
  // Git now leaves the API: enqueue publication (fire-and-forget) after the
  // repository pre-flight, mirroring publish_crunch. The watcher executes git.
  await enqueuePublication(ctx, run.id);
}
```

with the gate decision:

```ts
  // SCOPE A — one-way reconcile guard. Before publishing, check the changeset's
  // file-set against the same-flow open gap proposals. With no overlap we publish
  // as before; on ANY overlap (the gate's fold OR defer verdict) we defer-and-
  // preserve: the changeset is kept on the run and re-gated on a later tick, never
  // published as a rival. Source-sync's baseline already advanced at enqueue, so the
  // deferred changeset is the sole record of this change — dropping it would lose it.
  //
  // We collapse fold→defer deliberately: a real fold would merge this changeset into
  // the overlapping PR, but source-sync is not (yet) a Proposal, so there is nothing
  // for the LLM proposal-fold to merge into. GOAL — SCOPE B: make a source-sync
  // change a first-class Proposal so the gate is symmetric (gap and source-sync each
  // see the other's PRs) and fold becomes a real LLM changeset merge. See
  // docs/maintenance-redesign.md §6 and the spec at
  // docs/superpowers/specs/2026-06-24-source-sync-through-gate-design.md.
  const proposals = await sameFlowOpenProposals(ctx, run.flowId);
  const intent = sourceSyncIntent(run, changeset, readChangedSourcePaths(job.input));
  const decision = decideReconciliation(intent, openPullRequestSummaries(proposals));

  if (decision.kind === "open-new") {
    await ctx.stores.sourceSync.completeRun(run.id, parsed.data, changeset);
    // Git now leaves the API: enqueue publication (fire-and-forget) after the
    // repository pre-flight, mirroring publish_crunch. The watcher executes git.
    await enqueuePublication(ctx, run.id);
    return;
  }

  await ctx.stores.sourceSync.deferRun(run.id, parsed.data, changeset);
  console.log(
    `Source-sync run ${run.id}: changeset overlaps an open PR in flow ${run.flowId ?? "default"} ` +
      `(${decision.kind}); deferred and preserved for re-gate.`
  );
}
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npm test --workspace @magpie/api -- --test-name-pattern="overlaps a touchable|overlaps an approved"`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full source-sync test file (no-overlap regression)**

Run: `npm test --workspace @magpie/api -- --test-name-pattern="source"`
Expected: PASS — the existing "completing the plan job … enqueues publication" test still passes (no proposal ⇒ no overlap ⇒ open-new ⇒ publish).

- [ ] **Step 7: Typecheck + deadcode, then commit**

Run: `npm run typecheck` (expect 0), `npm run deadcode` (expect 0).

```bash
git add apps/api/src/features/source-sync/service.ts apps/api/src/features/source-sync/orchestration.test.ts
git commit -m "feat(source-sync): defer a changeset that overlaps an open PR (gate guard)"
```

---

### Task 4: Re-gate deferred runs on the source-sync tick

Re-evaluates deferred runs at the top of `triggerSourceSyncRun`; publishes those whose overlap has cleared.

**Files:**
- Modify: `apps/api/src/features/source-sync/service.ts`
- Modify: `apps/api/src/features/source-sync/orchestration.test.ts` (re-gate tests)

**Interfaces:**
- Consumes: `listDeferredRuns`, `completeDeferredRun` (Task 1); `sameFlowOpenProposals` (Task 2); `sourceSyncIntent`, `decideReconciliation`, `openPullRequestSummaries`, `enqueuePublication` (Task 3 / existing).

- [ ] **Step 1: Write the failing re-gate tests**

In `apps/api/src/features/source-sync/orchestration.test.ts`, add at the end:

```ts
test("re-gate completes a deferred run once its overlapping PR is gone", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const proposal = await ctx.stores.proposals.create({
      title: "Guide", targetPath: "guide.md", markdown: "# Guide", rationale: "r",
      evidence: [], triggeringQuestionIds: []
    });
    await completeJob(ctx, run.jobId!, PLAN);
    assert.equal((await ctx.stores.sourceSync.getRun(run.id))?.status, "deferred");

    // The overlapping PR merges (list() excludes merged ⇒ overlap clears).
    await ctx.stores.proposals.updateStatus(proposal.id, "merged");

    // Next tick: the source HEAD is unchanged (baseline already advanced), so no new
    // run is created; only the re-gate acts.
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });

    const after = await ctx.stores.sourceSync.getRun(run.id);
    assert.equal(after?.status, "completed");
    const publish = (await ctx.jobs.list({})).jobs.find((j) => j.type === "publish_source_sync");
    assert.ok(publish, "publication enqueued once the overlap cleared");
    assert.deepEqual(publish.input, { runId: run.id });
  } finally {
    await cleanup();
  }
});

test("re-gate leaves a deferred run deferred while the overlap persists", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    await ctx.stores.proposals.create({
      title: "Guide", targetPath: "guide.md", markdown: "# Guide", rationale: "r",
      evidence: [], triggeringQuestionIds: []
    });
    await completeJob(ctx, run.jobId!, PLAN);
    assert.equal((await ctx.stores.sourceSync.getRun(run.id))?.status, "deferred");

    // Overlap still open: re-gate must not publish.
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });

    assert.equal((await ctx.stores.sourceSync.getRun(run.id))?.status, "deferred");
    assert.equal((await ctx.jobs.list({})).jobs.filter((j) => j.type === "publish_source_sync").length, 0);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test --workspace @magpie/api -- --test-name-pattern="re-gate"`
Expected: FAIL — the deferred run stays `"deferred"` after the overlap clears (no re-gate logic yet), so the first test's `"completed"` assertion fails.

- [ ] **Step 3: Add the re-gate pass**

In `apps/api/src/features/source-sync/service.ts`, add this function (near `triggerSourceSyncRun`):

```ts
// Re-gate the flow's deferred runs at the top of each tick: a run deferred because
// its changeset overlapped an open PR is re-checked, and published once the overlap
// has cleared (the blocking PR merged/closed). Still-overlapping runs stay deferred.
// Bounded by the deferred-run count; runs on the existing scheduled cadence.
async function regateDeferredRuns(ctx: AppContext, flowId: string | undefined): Promise<void> {
  for (const run of await ctx.stores.sourceSync.listDeferredRuns(flowId)) {
    if (!run.changeset || run.changeset.length === 0) {
      continue;
    }
    const proposals = await sameFlowOpenProposals(ctx, run.flowId);
    const decision = decideReconciliation(sourceSyncIntent(run, run.changeset), openPullRequestSummaries(proposals));
    if (decision.kind !== "open-new") {
      continue; // still overlapping — leave it deferred for a later tick
    }
    await ctx.stores.sourceSync.completeDeferredRun(run.id);
    await enqueuePublication(ctx, run.id);
    console.log(`Source-sync re-gate: deferred run ${run.id} overlap cleared; enqueued publication.`);
  }
}
```

Then call it at the top of `triggerSourceSyncRun`, after `flowId` is resolved and before the per-source loop. The current opening of the function is:

```ts
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, options.flowId);
  const flowId = flow?.id ?? options.flowId;
  const destinationId = flow?.destinationId ?? defaultDestinationId(deps);
```

Add immediately after that line:

```ts
  // Re-gate any runs deferred on a previous tick before reacting to new commits, so
  // a change held behind a now-closed PR is published promptly.
  await regateDeferredRuns(ctx, flowId);
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npm test --workspace @magpie/api -- --test-name-pattern="re-gate"`
Expected: PASS (2 tests).

- [ ] **Step 5: Full gate run, then commit**

Run: `npm run typecheck` (expect 0), `npm run deadcode` (expect 0), `npm test` (all workspaces; expect 0 failures besides the two known Windows-only failures if running locally on Windows).

```bash
git add apps/api/src/features/source-sync/service.ts apps/api/src/features/source-sync/orchestration.test.ts
git commit -m "feat(source-sync): re-gate deferred runs on each tick"
```

---

## Plan Self-Review

- **Spec coverage:** §3.1 deferred state → Task 1; §3.2 store methods → Task 1; §3.3 gate hook → Task 3; §3.4 re-gate → Task 4; §3.5 shared helper → Task 2; §3.6 path normalisation → Task 3 (`sourceSyncIntent` normalises targets); §5 limitations → documented in the Task 3 comment; §6 tests → Tasks 1/3/4. No migration (Global Constraints) — confirmed, no migration task.
- **Type consistency:** `deferRun(id, plan, changeset)`, `listDeferredRuns(flowId)`, `completeDeferredRun(id)`, `sameFlowOpenProposals(ctx, flowId, excludeId?)`, `proposalFlowId(ctx, proposal)`, `sourceSyncIntent(run, changeset, evidence?)` are named identically wherever referenced across tasks.
- **knip:** `sameFlow` stays file-local in `flow.ts`; `proposalFlowId` (used by `fold.ts`) and `sameFlowOpenProposals` (used by `fold.ts` + source-sync) are exported and used cross-file.
- **No placeholders:** every code step carries complete code and exact commands.
