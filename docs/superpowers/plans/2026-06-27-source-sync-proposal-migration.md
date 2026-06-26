# Source-Sync Proposal Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-migrate source-sync from bespoke `SourceSyncRun` history/publication onto generic `MaintenanceRun` audit rows and first-class changeset `Proposal`s.

**Architecture:** Keep source-sync baseline state, but remove source-sync run history. A source tick records source-specific `MaintenanceRun`s; a completed non-empty source-sync plan creates one changeset `Proposal` and routes it through the existing multi-file reconcile/fold/publication path. `publish_source_sync` and source-sync run APIs disappear.

**Tech Stack:** TypeScript ESM monorepo, Node built-in test runner with `tsx`, Zod job contracts, Hono API routes, React/Next web console, Postgres migrations.

---

## File Map

- `packages/core/src/index.ts`: add `"source_change_sync"` to `MaintenanceTaskType`; remove `SourceSyncRun`, `SourceSyncRunStatus`, `SourceSyncRunTrigger`, and run-only fields. Keep `SourceSyncState`.
- `packages/jobs/src/schemas.ts`, `packages/jobs/src/types.ts`, `packages/jobs/src/catalog.ts`, `packages/jobs/src/catalog.test.ts`: change `source_change_sync` output to `{ maintenanceRunIds, proposalIds }`; remove `publish_source_sync`.
- `packages/db/migrations/0033_source_sync_proposals.sql`: drop `source_sync_runs`; leave `source_sync_state`.
- `apps/api/src/stores/source-sync-store.ts`: make the interface state-only (`getState`, `setState`, `reset`) and remove all run methods.
- `apps/api/src/stores/postgres-source-sync-store.ts`: same state-only Postgres implementation.
- `apps/api/src/stores/postgres-source-sync-store.test.ts`: keep state tests only.
- `apps/api/src/features/source-sync/service.ts`: trigger source-sync, enqueue plan jobs, record maintenance runs, create source-sync proposals, and remove execution-context/publication run paths.
- `apps/api/src/features/source-sync/routes.ts`: keep `POST /run`; remove run list/get/execution-context routes.
- `apps/api/src/features/source-sync/orchestration.test.ts`: update source-sync integration tests for maintenance runs and proposals.
- `apps/api/src/scheduling/fold.ts`: add `reconcileSourceSyncProposal`, same model as dedupe/split.
- `apps/api/src/features/jobs/service.ts`: dispatch source-sync proposal creation/gating on plan job completion; remove `publish_source_sync` completion handling.
- `apps/watcher/src/http-client.ts`, `apps/watcher/src/runners/publication.ts`, `apps/watcher/src/runners/publication.test.ts`: remove source-sync execution-context client and publication runner path.
- `apps/watcher/src/runners/maintenance.ts`, `apps/watcher/src/runners/maintenance.test.ts`: update `source_change_sync` output shape.
- `apps/web/src/components/ProposalsPanel.tsx`: show changeset files for multi-file proposals.
- `apps/web/src/components/dataflow/flows.ts`, tests/docs as needed: remove stale source-sync branch-only references.

## Task 1: Core and Job Contracts

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/jobs/src/schemas.ts`
- Modify: `packages/jobs/src/types.ts`
- Modify: `packages/jobs/src/catalog.ts`
- Modify: `packages/jobs/src/catalog.test.ts`

- [ ] **Step 1: Write/update failing jobs tests**

In `packages/jobs/src/catalog.test.ts`, update the source-sync output test and remove publish-source-sync expectations:

```ts
test("source_change_sync output reports maintenance runs and proposals", () => {
  const schema = jobDefinition("source_change_sync").outputSchema;
  assert.deepEqual(schema.parse({ maintenanceRunIds: ["run-1"], proposalIds: ["proposal-1"] }), {
    maintenanceRunIds: ["run-1"],
    proposalIds: ["proposal-1"]
  });
});

test("publish_source_sync is not a job type", () => {
  assert.equal(isJobType("publish_source_sync"), false);
});
```

Remove `"publish_source_sync"` from any expected job type arrays, queue arrays, and expiration maps.

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
npm test -w @magpie/jobs -- --test-name-pattern="source_change_sync|publish_source_sync"
```

Expected: FAIL because the old output schema and job type still exist.

- [ ] **Step 3: Update core maintenance task type and remove run type**

In `packages/core/src/index.ts`:

```ts
export interface SourceSyncState {
  flowId?: string;
  sourceId: string;
  lastSha: string;
  lastCheckedAt: string;
}
```

Remove the exported `SourceSyncRunTrigger`, `SourceSyncRunStatus`, and `SourceSyncRun` definitions. Change:

```ts
export type MaintenanceTaskType =
  | "fix_patrol"
  | "improve_patrol"
  | "process_gaps_to_pull_requests"
  | "source_change_sync";
```

- [ ] **Step 4: Update job schemas and catalog**

In `packages/jobs/src/schemas.ts`:

```ts
export const sourceChangeSyncOutputSchema = z.object({
  maintenanceRunIds: z.array(z.string()),
  proposalIds: z.array(z.string())
});
```

Delete `publishSourceSyncInputSchema` and `publishSourceSyncOutputSchema`.

In `packages/jobs/src/types.ts`, remove `"publish_source_sync"` from `JOB_TYPES`.

In `packages/jobs/src/catalog.ts`, remove the `publish_source_sync` definition.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -w @magpie/jobs
npm run build -w @magpie/core
npm run typecheck
```

Expected: jobs tests pass; typecheck may still fail in API/watcher until later tasks remove old imports. If typecheck fails only on old source-sync run references, continue.

Commit:

```bash
git add packages/core/src/index.ts packages/jobs/src/schemas.ts packages/jobs/src/types.ts packages/jobs/src/catalog.ts packages/jobs/src/catalog.test.ts
git commit -m "feat(source-sync): switch job contract to maintenance audit output"
```

## Task 2: State-Only Source-Sync Store and Migration

**Files:**
- Modify: `apps/api/src/stores/source-sync-store.ts`
- Modify: `apps/api/src/stores/postgres-source-sync-store.ts`
- Modify: `apps/api/src/stores/postgres-source-sync-store.test.ts`
- Create: `packages/db/migrations/0033_source_sync_proposals.sql`

- [ ] **Step 1: Write/update store tests**

In `apps/api/src/stores/source-sync-store.test.ts`, keep only state behaviour:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySourceSyncStore } from "./source-sync-store.js";

test("source-sync state records last processed sha per flow and source", async () => {
  const store = new InMemorySourceSyncStore();
  await store.setState(undefined, "src-1", "aaa");
  await store.setState("flow-a", "src-1", "bbb");

  assert.equal((await store.getState(undefined, "src-1"))?.lastSha, "aaa");
  assert.equal((await store.getState("flow-a", "src-1"))?.lastSha, "bbb");
});

test("source-sync state reset clears baselines", async () => {
  const store = new InMemorySourceSyncStore();
  await store.setState(undefined, "src-1", "aaa");
  await store.reset();
  assert.equal(await store.getState(undefined, "src-1"), undefined);
});
```

- [ ] **Step 2: Run focused failing tests**

Run:

```bash
node --import tsx --test apps/api/src/stores/source-sync-store.test.ts
```

Expected: FAIL if old run tests still exist or interface references removed core run types.

- [ ] **Step 3: Make the in-memory store state-only**

`apps/api/src/stores/source-sync-store.ts` becomes:

```ts
import type { SourceSyncState } from "@magpie/core";

export interface SourceSyncStore {
  getState(flowId: string | undefined, sourceId: string): Promise<SourceSyncState | undefined>;
  setState(flowId: string | undefined, sourceId: string, lastSha: string): Promise<SourceSyncState>;
  reset(): Promise<void>;
}

function stateKey(flowId: string | undefined, sourceId: string): string {
  return `${flowId ?? ""}\0${sourceId}`;
}

export class InMemorySourceSyncStore implements SourceSyncStore {
  private readonly states = new Map<string, SourceSyncState>();

  async getState(flowId: string | undefined, sourceId: string): Promise<SourceSyncState | undefined> {
    return this.states.get(stateKey(flowId, sourceId));
  }

  async setState(flowId: string | undefined, sourceId: string, lastSha: string): Promise<SourceSyncState> {
    const state: SourceSyncState = { flowId, sourceId, lastSha, lastCheckedAt: new Date().toISOString() };
    this.states.set(stateKey(flowId, sourceId), state);
    return state;
  }

  async reset(): Promise<void> {
    this.states.clear();
  }
}
```

- [ ] **Step 4: Make Postgres store state-only**

Keep `getState`, `setState`, and `reset`; delete run row mapping and run methods. The SQL uses `flow_id = ''` for default flow:

```ts
function storedFlowId(flowId: string | undefined): string {
  return flowId ?? "";
}

function mapStateRow(row: SourceSyncStateRow): SourceSyncState {
  return {
    flowId: row.flow_id || undefined,
    sourceId: row.source_id,
    lastSha: row.last_sha,
    lastCheckedAt: row.last_checked_at instanceof Date ? row.last_checked_at.toISOString() : String(row.last_checked_at)
  };
}
```

- [ ] **Step 5: Add migration 0033**

Create `packages/db/migrations/0033_source_sync_proposals.sql`:

```sql
-- Source-sync Scope B: source changes now become first-class proposals and
-- execution history lives in maintenance_runs. Keep only baseline state.
DROP TABLE IF EXISTS source_sync_runs;
```

- [ ] **Step 6: Verify and commit**

Run:

```bash
node --import tsx --test apps/api/src/stores/source-sync-store.test.ts
node --import tsx --test apps/api/src/stores/postgres-source-sync-store.test.ts
```

Expected: in-memory tests pass; Postgres tests pass or self-skip without `DATABASE_URL`.

Commit:

```bash
git add apps/api/src/stores/source-sync-store.ts apps/api/src/stores/source-sync-store.test.ts apps/api/src/stores/postgres-source-sync-store.ts apps/api/src/stores/postgres-source-sync-store.test.ts packages/db/migrations/0033_source_sync_proposals.sql
git commit -m "feat(source-sync): keep only baseline state"
```

## Task 3: Source-Sync Creates MaintenanceRun Audits and Proposals

**Files:**
- Modify: `apps/api/src/features/source-sync/service.ts`
- Modify: `apps/api/src/features/source-sync/orchestration.test.ts`
- Modify: `apps/api/src/features/jobs/service.ts`
- Modify: `apps/api/src/scheduling/fold.ts`

- [ ] **Step 1: Update source-sync orchestration tests for the new contract**

Replace run-history assertions with maintenance/proposal assertions. Key tests:

```ts
test("triggerSourceSyncRun enqueues a plan job, advances baseline, and returns zero completed ids before the AI job finishes", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    const repoPath = await baselineAtParent(ctx, checkoutRoot);
    const result = await triggerSourceSyncRun(ctx, { trigger: "scheduled" });

    assert.deepEqual(result, { maintenanceRunIds: [], proposalIds: [] });
    const planJob = (await ctx.jobs.list({})).jobs.find((job) => job.type === "sync_source_changes_generate_plan");
    assert.ok(planJob, "plan job enqueued");

    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    assert.equal((await ctx.stores.sourceSync.getState(undefined, "src-1"))?.lastSha, head.trim());
  } finally {
    await cleanup();
  }
});

test("completing a source-sync plan creates one changeset proposal and records a maintenance run", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    const planJob = (await ctx.jobs.list({ type: "sync_source_changes_generate_plan" })).jobs[0];

    const outcome = await completeJob(ctx, planJob.id, PLAN);
    assert.equal(outcome.ok, true);

    const proposals = await ctx.stores.proposals.list(10);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].title.startsWith("Source sync: Rules repo "), true);
    assert.equal(proposals[0].targetPath, "guide.md");
    assert.equal(proposals[0].changeset?.length, 1);
    assert.equal(proposals[0].flowId, undefined);

    const runs = await ctx.stores.maintenanceRuns.list({ taskType: "source_change_sync", limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "completed");
    assert.deepEqual((runs[0].details as { proposalIds?: string[] }).proposalIds, [proposals[0].id]);

    assert.equal((await ctx.jobs.list({ type: "publish_proposal" })).jobs.length, 1);
  } finally {
    await cleanup();
  }
});
```

Add overlap test:

```ts
test("source-sync proposal overlapping a touchable PR folds through fold_changeset_proposal", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    await triggerSourceSyncRun(ctx, { trigger: "scheduled" });
    await ctx.stores.proposals.create({
      title: "Guide",
      targetPath: "guide.md",
      markdown: "# Guide",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });
    const planJob = (await ctx.jobs.list({ type: "sync_source_changes_generate_plan" })).jobs[0];
    await completeJob(ctx, planJob.id, PLAN);

    assert.equal((await ctx.jobs.list({ type: "fold_changeset_proposal" })).jobs.length, 1);
    assert.equal((await ctx.jobs.list({ type: "publish_proposal" })).jobs.length, 0);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test apps/api/src/features/source-sync/orchestration.test.ts
```

Expected: FAIL because service still returns `SourceSyncRun[]` and uses old run store.

- [ ] **Step 3: Define source-sync result and plan-job metadata**

In `service.ts`:

```ts
export interface SourceSyncTriggerResult {
  maintenanceRunIds: string[];
  proposalIds: string[];
}

interface SourceSyncPlanJobMeta {
  flowId?: string;
  destinationId?: string;
  sourceId: string;
  sourceName: string;
  trigger: "scheduled" | "manual";
  fromSha: string;
  toSha: string;
  changedFileCount: number;
  candidateCount: number;
}
```

The plan job input already carries most of this; read it back with
`syncSourceChangesGeneratePlanInputSchema.safeParse(job.input)` on completion.

- [ ] **Step 4: Change triggerSourceSyncRun to return ids**

`triggerSourceSyncRun` returns:

```ts
export async function triggerSourceSyncRun(
  ctx: AppContext,
  options: { flowId?: string; trigger: "scheduled" | "manual" }
): Promise<SourceSyncTriggerResult> {
  const result: SourceSyncTriggerResult = { maintenanceRunIds: [], proposalIds: [] };
  // loop sources; syncGitSource returns void or immediate maintenance run id for no-candidate cases
  return result;
}
```

When a source has changed files but no candidates, record:

```ts
const run = await ctx.stores.maintenanceRuns.record({
  taskType: "source_change_sync",
  flowId,
  trigger,
  status: "completed",
  summary: `checked ${source.name} ${previous.lastSha.slice(0, 8)}..${headSha.slice(0, 8)} · no candidate docs`,
  details: {
    sourceId: source.id,
    sourceName: source.name,
    destinationId,
    fromSha: previous.lastSha,
    toSha: headSha,
    changedFileCount: changes.length,
    candidateCount: 0,
    proposalIds: []
  }
});
```

- [ ] **Step 5: Create source-sync proposals on completed plan jobs**

Add helper:

```ts
export async function createSourceSyncProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<{ proposal?: Proposal; maintenanceRun?: MaintenanceRun } | undefined> {
  if (!job || job.type !== "sync_source_changes_generate_plan") return undefined;
  const input = syncSourceChangesGeneratePlanInputSchema.safeParse(job.input);
  const parsed = syncSourceChangesGeneratePlanOutputSchema.safeParse(output);
  if (!input.success) return undefined;
  const meta = input.data;
  if (!parsed.success) {
    const run = await recordSourceSyncMaintenanceRun(ctx, meta, "failed", "source-sync plan job returned malformed output", [], job.id);
    return { maintenanceRun: run };
  }
  const changeset = constrainToCandidates(changesetFromPlan(parsed.data), meta.candidateDocuments);
  if (changeset.length === 0) {
    const run = await recordSourceSyncMaintenanceRun(ctx, meta, "completed", "no document changes", [], job.id);
    return { maintenanceRun: run };
  }
  const primary = changeset.find((change) => change.content !== undefined);
  if (!primary?.content) {
    const run = await recordSourceSyncMaintenanceRun(ctx, meta, "completed", "no writable primary document", [], job.id);
    return { maintenanceRun: run };
  }
  const proposal = await ctx.stores.proposals.create({
    title: `Source sync: ${meta.sourceName} ${meta.fromSha.slice(0, 8)}..${meta.toSha.slice(0, 8)}`,
    targetPath: primary.path,
    markdown: primary.content,
    changeset,
    rationale: `${parsed.data.rationale}\n\nSource ${meta.sourceName}: ${meta.fromSha}..${meta.toSha}`,
    evidence: [],
    flowId: meta.flowId,
    destinationId: meta.destinationId,
    jobId: job.id,
    draftContext: {
      gapSummaries: [],
      sourceFiles: meta.changes.map((change) => ({ sourceName: meta.sourceName, path: change.path })),
      evidenceCount: meta.candidateDocuments.length,
      openPullRequests: []
    }
  });
  const run = await recordSourceSyncMaintenanceRun(ctx, meta, "completed", `created proposal ${proposal.id}`, [proposal.id], job.id);
  return { proposal, maintenanceRun: run };
}
```

Import `Proposal` and `MaintenanceRun` types from `@magpie/core`.

- [ ] **Step 6: Add source-sync fold helper**

In `apps/api/src/scheduling/fold.ts`, add:

```ts
export async function reconcileSourceSyncProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) return;
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const targets = proposalTargets(proposal);
  const decision = decideReconciliation(
    {
      lens: "source-sync",
      flowId,
      targets,
      evidence: proposal.draftContext?.sourceFiles.map((file) => file.path ?? file.url ?? file.sourceName) ?? [],
      rationale: proposal.rationale ?? ""
    },
    openPullRequestSummaries(candidates)
  );
  if (decision.kind === "fold") {
    const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
    if (survivor) {
      await ctx.jobs.create("fold_changeset_proposal", {
        provider: ctx.config.get().aiProvider,
        survivorProposalId: survivor.id,
        rivalProposalId: proposal.id,
        survivorChangeset: proposalChangeset(survivor),
        rivalChangeset: proposalChangeset(proposal),
        sharedPaths: sharedTargets(proposalTargets(survivor), targets),
        expectedOutput: "folded_changeset"
      });
      return;
    }
  }
  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
}
```

- [ ] **Step 7: Wire completion dispatcher**

In `apps/api/src/features/jobs/service.ts`, replace:

```ts
await sourceSyncService.attachSourceSyncPlanFromCompletedJob(ctx, existingJob, parsed.data);
await sourceSyncService.recordSourceSyncPublicationFromCompletedJob(ctx, existingJob, parsed.data);
```

with:

```ts
const sourceSyncResult = await sourceSyncService.createSourceSyncProposalFromCompletedJob(ctx, existingJob, parsed.data);
if (sourceSyncResult?.proposal) {
  try {
    await foldService.reconcileSourceSyncProposal(ctx, sourceSyncResult.proposal);
  } catch (error) {
    console.warn(`Source-sync reconcile for proposal ${sourceSyncResult.proposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

- [ ] **Step 8: Verify and commit**

Run:

```bash
node --import tsx --test apps/api/src/features/source-sync/orchestration.test.ts
node --import tsx --test apps/api/src/scheduling/fold.test.ts apps/api/src/features/jobs/service.test.ts
npm run typecheck
```

Expected: focused tests pass; typecheck may still fail in routes/watcher until cleanup tasks.

Commit:

```bash
git add apps/api/src/features/source-sync/service.ts apps/api/src/features/source-sync/orchestration.test.ts apps/api/src/features/jobs/service.ts apps/api/src/scheduling/fold.ts
git commit -m "feat(source-sync): create proposals from source changes"
```

## Task 4: API Route Cleanup

**Files:**
- Modify: `apps/api/src/features/source-sync/routes.ts`
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/api/src/features/source-sync/service.test.ts`

- [ ] **Step 1: Add route assertions**

Add an app test:

```ts
test("source-sync run routes expose only the trigger endpoint", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  assert.equal((await app.request("/api/source-sync/runs")).status, 404);
  assert.equal((await app.request("/api/source-sync/runs/run-1")).status, 404);
  assert.equal((await app.request("/api/source-sync/runs/run-1/execution-context")).status, 404);
});
```

- [ ] **Step 2: Update routes**

`apps/api/src/features/source-sync/routes.ts` keeps only:

```ts
app.post("/run", requireScopes("manage:jobs"), async (c) => {
  const payload = await readJsonBody<{ flowId?: string }>(c);
  return c.json(await sourceSyncService.triggerSourceSyncRun(ctx, {
    flowId: payload.flowId?.trim() || undefined,
    trigger: "scheduled"
  }));
});
```

Remove `parseLimit`, `HttpError`, `GET /runs`, `GET /runs/:id`, and `GET /runs/:id/execution-context`.

- [ ] **Step 3: Verify and commit**

Run:

```bash
node --import tsx --test apps/api/src/app.test.ts apps/api/src/features/source-sync/service.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/api/src/features/source-sync/routes.ts apps/api/src/app.test.ts apps/api/src/features/source-sync/service.test.ts
git commit -m "feat(api): remove source-sync run endpoints"
```

## Task 5: Watcher Publication Cleanup

**Files:**
- Modify: `apps/watcher/src/http-client.ts`
- Modify: `apps/watcher/src/runners/publication.ts`
- Modify: `apps/watcher/src/runners/publication.test.ts`
- Modify: `apps/watcher/src/runners/maintenance.ts`
- Modify: `apps/watcher/src/runners/maintenance.test.ts`

- [ ] **Step 1: Update watcher tests**

In `publication.test.ts`, remove source-sync context fixtures/tests. Update support test:

```ts
assert.ok(runner.supports("publish_proposal"));
assert.ok(!runner.supports("publish_source_sync" as JobView["type"]));
assert.ok(runner.supports("crosslink_pull_requests"));
```

In maintenance tests, update source-sync output:

```ts
assert.deepEqual(output, { maintenanceRunIds: ["run-1"], proposalIds: ["proposal-1"] });
```

- [ ] **Step 2: Remove client and runner path**

In `http-client.ts`, delete `SourceSyncExecutionContext` and `sourceSyncExecutionContext`.

In `publication.ts`, remove:

- `"publish_source_sync"` from `PUBLISH_JOB_TYPES`;
- `PublishSourceSyncRun` type;
- `publishSourceSync`;
- `sourceSyncBranchName`;
- `parseSourceSyncContext`.

`PublicationRunner.run` dispatches only `publish_proposal`, `crosslink_pull_requests`, and `comment_pull_request`.

- [ ] **Step 3: Update maintenance runner output**

Make `WatcherApi.runSourceSync` return:

```ts
Promise<{ maintenanceRunIds: string[]; proposalIds: string[] }>
```

and let `MaintenanceRunner` return that object for `source_change_sync`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --import tsx --test apps/watcher/src/runners/publication.test.ts apps/watcher/src/runners/maintenance.test.ts
npm run typecheck
```

Expected: PASS or typecheck only blocked by web cleanup.

Commit:

```bash
git add apps/watcher/src/http-client.ts apps/watcher/src/runners/publication.ts apps/watcher/src/runners/publication.test.ts apps/watcher/src/runners/maintenance.ts apps/watcher/src/runners/maintenance.test.ts
git commit -m "feat(watcher): remove source-sync publication runner"
```

## Task 6: Web Changeset Proposal Display

**Files:**
- Modify: `apps/web/src/components/ProposalsPanel.tsx`
- Modify: `apps/web/src/lib/types.ts` if type exports need refreshing

- [ ] **Step 1: Add changeset display**

In `ProposalsPanel.tsx`, render a compact changed-file list before the markdown preview:

```tsx
{selectedProposal.changeset && selectedProposal.changeset.length > 0 ? (
  <details className="draftContext" open>
    <summary>{selectedProposal.changeset.length} changed file{selectedProposal.changeset.length === 1 ? "" : "s"}</summary>
    <ul className="clusterGaps">
      {selectedProposal.changeset.map((change) => (
        <li key={`${change.delete ? "delete" : "write"}:${change.path}`}>
          {change.delete ? "Delete" : "Write"} <small className="path">{change.path}</small>
        </li>
      ))}
    </ul>
  </details>
) : null}
```

- [ ] **Step 2: Verify and commit**

Run:

```bash
npm run typecheck -w @magpie/web
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/components/ProposalsPanel.tsx apps/web/src/lib/types.ts
git commit -m "feat(web): show changeset files on proposals"
```

## Task 7: Dead Code, Docs, and Full Verification

**Files:**
- Modify docs with stale source-sync run/publish references as found by `rg`
- Modify tests with stale `publish_source_sync` references as found by `rg`

- [ ] **Step 1: Sweep stale references**

Run:

```bash
rg -n "SourceSyncRun|source_sync_runs|publish_source_sync|sourceSyncExecutionContext|getRunExecutionContext|source_sync_run" packages apps docs -S
```

Expected: only historical docs/specs may remain. Remove code/test references. Update current docs to say source-sync is proposal-backed.

- [ ] **Step 2: Dead-code check**

Run:

```bash
npm run deadcode
```

Expected: PASS. Delete orphaned exports instead of relaxing config.

- [ ] **Step 3: Typecheck**

Run:

```bash
npm run typecheck
npm run typecheck -w @magpie/web
```

Expected: PASS.

- [ ] **Step 4: Test gates**

Run:

```bash
npm test -w @magpie/jobs
npm test -w @magpie/prompts
node --import tsx --test "apps/api/src/**/*.test.ts"
node --import tsx --test apps/watcher/src/runners/maintenance.test.ts apps/watcher/src/runners/publication.test.ts apps/watcher/src/runners/refresh-pull-requests.test.ts
```

Expected: PASS, except any already documented local environment-only failures must be recorded in the final summary with exact failing test names.

- [ ] **Step 5: Commit cleanup**

Commit:

```bash
git add -A
git commit -m "docs(source-sync): record proposal-backed sync migration"
```

## Task 8: Branch Finish and PR

- [ ] **Step 1: Check status and log**

Run:

```bash
git status --short --branch
git log --oneline --max-count=12
```

Expected: clean worktree on feature branch or main with new commits ready to push.

- [ ] **Step 2: Push branch**

If still on `main`, create a feature branch before pushing:

```bash
git switch -c codex/source-sync-proposal-migration
git push -u origin codex/source-sync-proposal-migration
```

If already on the feature branch:

```bash
git push
```

- [ ] **Step 3: Open PR**

Use the repo's normal GitHub workflow. PR title:

```text
Migrate source-sync to proposals and MaintenanceRun audit
```

PR body:

```markdown
## Summary
- migrates source-sync run history onto MaintenanceRun
- creates first-class changeset proposals from source-sync plans
- removes publish_source_sync and source-sync run routes
- updates watcher and web UI for the proposal-backed flow

## Verification
- npm run deadcode
- npm run typecheck
- npm run typecheck -w @magpie/web
- npm test -w @magpie/jobs
- npm test -w @magpie/prompts
- node --import tsx --test "apps/api/src/**/*.test.ts"
- watcher focused tests
```

## Self-Review

- **Spec coverage:** Tasks 1–2 cover type/schema/storage/migration; Task 3 covers maintenance audit rows and proposal creation/gating; Task 4 covers API removal; Task 5 covers watcher/job removal; Task 6 covers UI; Task 7 covers docs and gates; Task 8 covers PR.
- **Placeholder scan:** No `TBD`, `TODO`, or unspecified test commands are intentionally left in implementation steps.
- **Type consistency:** `source_change_sync` output is consistently `{ maintenanceRunIds, proposalIds }`; source-sync state remains `getState/setState/reset`; source-sync changes become changeset `Proposal`s and publish through `publish_proposal`.
