# Source-sync First-class Proposal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert source-sync from a bespoke changeset publication flow into a normal multi-file `Proposal` producer that publishes through `publish_proposal` and folds through `fold_changeset_proposal`.

**Architecture:** Source-sync still detects commits, gathers candidate KB docs, and enqueues `sync_source_changes_generate_plan`. Plan completion now creates a clusterless `Proposal` with `changeset`, then routes that proposal through the existing reconcile gate. The old `publish_source_sync` job, watcher branch, execution-context endpoint, and run-level publication state are removed.

**Tech Stack:** TypeScript, Node test runner, Zod, npm workspaces (`@magpie/core`, `@magpie/jobs`, `@magpie/api`, `@magpie/watcher`), pg-boss job catalog, existing in-memory test stores.

---

## File Structure

- `packages/jobs/src/types.ts`: remove `publish_source_sync` from `JOB_TYPES`.
- `packages/jobs/src/schemas.ts`: remove `publishSourceSyncInputSchema` and `publishSourceSyncOutputSchema`.
- `packages/jobs/src/catalog.ts`: remove `publish_source_sync` definition and github queue.
- `packages/jobs/src/catalog.test.ts`: update counts and add negative assertions for removed job type.
- `apps/api/src/features/source-sync/service.ts`: create source-sync proposals from completed plan jobs; remove publish-specific execution context and publication completion handler.
- `apps/api/src/features/source-sync/routes.ts`: remove `/runs/:id/execution-context`, keep run list/detail and trigger route.
- `apps/api/src/features/source-sync/orchestration.test.ts`: change source-sync completion tests from `publish_source_sync` expectations to proposal/fold/publication expectations.
- `apps/api/src/features/jobs/service.ts`: remove source-sync publication dispatch; keep plan failure handling.
- `apps/api/src/features/jobs/service.test.ts`: remove `publish_source_sync` completion test and add a regression that source-sync plan completion delegates to proposal creation through the dispatcher if not already covered in source-sync tests.
- `apps/api/src/scheduling/fold.ts`: add `reconcileSourceSyncProposal`.
- `apps/api/src/scheduling/fold.test.ts`: cover source-sync `open-new`, `fold`, and `defer` behaviors.
- `apps/api/src/stores/source-sync-store.ts`: remove run-level publication method from the interface and in-memory store.
- `apps/api/src/stores/postgres-source-sync-store.ts`: remove run-level publication method from the Postgres store.
- `packages/core/src/index.ts`: remove source-sync run publication ownership and narrow comments/statuses if practical without a DB migration.
- `apps/watcher/src/runners/publication.ts`: remove `publish_source_sync` support and rely on existing changeset-aware `publish_proposal`.
- `apps/watcher/src/http-client.ts`: remove source-sync execution context client method and related type.
- `apps/watcher/src/runners/publication.test.ts`: remove direct source-sync publication tests; keep or add proposal changeset publication coverage.
- Docs/dataflow: update `docs/scheduled-jobs-migration-status.md`, `docs/maintenance-redesign.md`, `docs/api.md`, `docs/ai-jobs.md`, `apps/web/src/components/dataflow/flows.ts`, and `apps/web/src/components/dataflow/flows.test.tsx`.

---

### Task 1: Remove `publish_source_sync` from the job catalog

**Files:**
- Modify: `packages/jobs/src/types.ts`
- Modify: `packages/jobs/src/schemas.ts`
- Modify: `packages/jobs/src/catalog.ts`
- Modify: `packages/jobs/src/catalog.test.ts`

- [ ] **Step 1: Write failing catalog tests**

In `packages/jobs/src/catalog.test.ts`, update the expected job type list/count so it no longer contains `publish_source_sync`, and replace the current `publish_source_sync is a github queue named by its type` test with a negative assertion:

```ts
test("publish_source_sync is retired", () => {
  assert.equal(JOB_TYPES.includes("publish_source_sync" as never), false);
});
```

Also update any expected queue count or `expectedExpiration` object by removing:

```ts
publish_source_sync: 15 * 60,
```

- [ ] **Step 2: Run the jobs tests and verify they fail**

Run:

```bash
npm test -w @magpie/jobs
```

Expected: FAIL because `publish_source_sync` still exists in `JOB_TYPES`, schemas, and catalog definitions.

- [ ] **Step 3: Remove the job type and schemas**

In `packages/jobs/src/types.ts`, remove:

```ts
"publish_source_sync",
```

In `packages/jobs/src/schemas.ts`, delete:

```ts
export const publishSourceSyncInputSchema = z.object({ runId: z.string() });
export const publishSourceSyncOutputSchema = z.object({
  runId: z.string(),
  branchName: z.string(),
  commitSha: z.string(),
  remoteUrl: z.string().optional(),
  publishedAt: z.string()
});
```

In `packages/jobs/src/catalog.ts`, delete the definition:

```ts
publish_source_sync: define("publish_source_sync", "github", schemas.publishSourceSyncInputSchema, schemas.publishSourceSyncOutputSchema, 15 * 60),
```

- [ ] **Step 4: Run jobs tests and typecheck the package**

Run:

```bash
npm test -w @magpie/jobs
npm run typecheck -w @magpie/jobs
```

Expected: PASS for `@magpie/jobs`. If other packages now fail to compile, that is expected and addressed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add packages/jobs/src/types.ts packages/jobs/src/schemas.ts packages/jobs/src/catalog.ts packages/jobs/src/catalog.test.ts
git commit -m "refactor(jobs): retire publish_source_sync job type"
```

---

### Task 2: Make source-sync plan completion create a proposal

**Files:**
- Modify: `apps/api/src/features/source-sync/orchestration.test.ts`
- Modify: `apps/api/src/features/source-sync/service.ts`
- Modify: `apps/api/src/features/jobs/service.ts`

- [ ] **Step 1: Rewrite the successful completion test first**

In `apps/api/src/features/source-sync/orchestration.test.ts`, replace the test named:

```ts
test("completing the plan job constrains the changeset, completes the run, and enqueues publication", async () => {
```

with:

```ts
test("completing the plan job creates a source-sync proposal and enqueues proposal publication", async () => {
  const broker = new FakeJobBroker();
  const { ctx, checkoutRoot, cleanup } = await seed(broker);
  try {
    await baselineAtParent(ctx, checkoutRoot);
    const run = (await triggerSourceSyncRun(ctx, { trigger: "scheduled" }))[0];
    const jobId = run.jobId;
    assert.ok(jobId, "run linked to a plan job");

    const outcome = await completeJob(ctx, jobId, PLAN);
    assert.equal(outcome.ok, true);

    const completed = await ctx.stores.sourceSync.getRun(run.id);
    assert.equal(completed?.status, "completed");
    assert.ok(completed?.plan, "plan persisted");
    assert.equal(completed?.changeset?.length, 1);
    assert.equal(completed?.changeset?.[0].path, "guide.md");
    assert.equal(completed?.changeset?.[0].content, "# Guide\nThe limit is 2025.\n");

    const proposals = await ctx.stores.proposals.list(20);
    const proposal = proposals.find((candidate) => candidate.jobId === jobId);
    assert.ok(proposal, "source-sync proposal created");
    assert.equal(proposal.flowId, undefined);
    assert.equal(proposal.destinationId, run.destinationId);
    assert.equal(proposal.targetPath, "guide.md");
    assert.equal(proposal.markdown, "# Guide\nThe limit is 2025.\n");
    assert.equal(proposal.changeset?.length, 1);
    assert.match(proposal.gapSummary ?? "", /Source sync:/);

    const publishProposal = (await ctx.jobs.list({})).jobs.find((job) => job.type === "publish_proposal");
    assert.ok(publishProposal, "proposal publication enqueued");
    assert.deepEqual(publishProposal.input, { proposalId: proposal.id });
    assert.equal((await ctx.jobs.list({})).jobs.some((job) => job.type === "publish_source_sync" as never), false);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --import tsx --test "apps/api/src/features/source-sync/orchestration.test.ts"
```

Expected: FAIL because no proposal is created and the code still enqueues `publish_source_sync`.

- [ ] **Step 3: Implement proposal creation helpers**

In `apps/api/src/features/source-sync/service.ts`, add imports:

```ts
import type { ProposalInput } from "../../stores/proposal-store.js";
import * as foldService from "../../scheduling/fold.js";
```

Add these helpers near the pure helper section:

```ts
function primaryChange(changeset: ChangesetChange[]): ChangesetChange {
  return changeset.find((change) => !change.delete && typeof change.content === "string") ?? changeset[0];
}

function sourceSyncProposalInput(run: SourceSyncRun, plan: MaintenancePlan, changeset: ChangesetChange[], job: JobView): ProposalInput {
  const primary = primaryChange(changeset);
  const sourceName = resolveSourceNameFromInput(job.input) ?? resolveSourceNameFallback(run.sourceId);
  const from = run.fromSha?.slice(0, 8) ?? "?";
  const to = run.toSha.slice(0, 8);
  return {
    title: `Sync docs to ${sourceName} changes`,
    targetPath: normalizeRelativePath(primary.path),
    markdown: primary.content ?? "",
    rationale: plan.rationale,
    evidence: [],
    gapSummary: `Source sync: ${sourceName} ${from}..${to}`,
    triggeringQuestionIds: [],
    destinationId: run.destinationId,
    jobId: job.id,
    flowId: run.flowId,
    changeset,
    draftContext: {
      gapSummaries: [`Source sync: ${sourceName} ${from}..${to}`],
      sourceFiles: readChangedSourcePaths(job.input).map((sourcePath) => ({ sourceName, path: sourcePath })),
      evidenceCount: 0,
      openPullRequests: []
    }
  };
}

function resolveSourceNameFromInput(input: unknown): string | undefined {
  const parsed = syncSourceChangesGeneratePlanInputSchema.safeParse(input);
  return parsed.success ? parsed.data.sourceName : undefined;
}

function resolveSourceNameFallback(sourceId: string): string {
  return sourceId;
}
```

Then update `attachSourceSyncPlanFromCompletedJob` after deriving a non-empty changeset:

```ts
const completed = await ctx.stores.sourceSync.completeRun(run.id, parsed.data, changeset);
if (!completed) {
  return;
}
const existing = await ctx.stores.proposals.getByJobId(job.id);
const proposal = existing ?? await ctx.stores.proposals.create(sourceSyncProposalInput(completed, parsed.data, changeset, job));
await foldService.reconcileSourceSyncProposal(ctx, proposal);
```

Remove the old call path that builds a `sourceSyncIntent`, calls `decideReconciliation`, defers runs, or calls `enqueuePublication`.

- [ ] **Step 4: Run the focused source-sync test**

Run:

```bash
node --import tsx --test "apps/api/src/features/source-sync/orchestration.test.ts"
```

Expected: FAIL because `reconcileSourceSyncProposal` does not exist yet.

- [ ] **Step 5: Temporarily add an empty exported stub for compiler progress**

In `apps/api/src/scheduling/fold.ts`, add this temporary implementation. It will be replaced in Task 3:

```ts
export async function reconcileSourceSyncProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft") {
    return;
  }
  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
}
```

- [ ] **Step 6: Run the focused source-sync test again**

Run:

```bash
node --import tsx --test "apps/api/src/features/source-sync/orchestration.test.ts"
```

Expected: PASS for the rewritten successful completion case. Existing overlap/deferred tests will still fail until Task 3 updates the fold behavior.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/features/source-sync/orchestration.test.ts apps/api/src/features/source-sync/service.ts apps/api/src/scheduling/fold.ts
git commit -m "feat(api): create proposals from source-sync plans"
```

---

### Task 3: Implement source-sync proposal reconciliation

**Files:**
- Modify: `apps/api/src/scheduling/fold.ts`
- Modify: `apps/api/src/scheduling/fold.test.ts`
- Modify: `apps/api/src/features/source-sync/orchestration.test.ts`

- [ ] **Step 1: Add fold tests for source-sync proposals**

In `apps/api/src/scheduling/fold.test.ts`, add tests near the dedupe/split tests:

```ts
it("folds a source-sync proposal into a touchable overlapping proposal", async () => {
  const ctx = makeTestContext();
  const survivor = await ctx.stores.proposals.create({
    title: "Guide",
    targetPath: "guide.md",
    markdown: "# Guide\nold",
    evidence: [],
    triggeringQuestionIds: [],
    flowId: "docs"
  });
  const rival = await ctx.stores.proposals.create({
    title: "Sync docs to Rules changes",
    targetPath: "guide.md",
    markdown: "# Guide\nnew",
    evidence: [],
    triggeringQuestionIds: [],
    flowId: "docs",
    changeset: [{ path: "guide.md", content: "# Guide\nnew" }]
  });

  await reconcileSourceSyncProposal(ctx, rival);

  const jobs = (await ctx.jobs.list({})).jobs;
  const fold = jobs.find((job) => job.type === "fold_changeset_proposal");
  assert.ok(fold, "fold job enqueued");
  assert.equal((fold.input as { survivorProposalId: string }).survivorProposalId, survivor.id);
  assert.equal((fold.input as { rivalProposalId: string }).rivalProposalId, rival.id);
});

it("publishes a source-sync proposal with no overlap", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Sync docs to Rules changes",
    targetPath: "guide.md",
    markdown: "# Guide\nnew",
    evidence: [],
    triggeringQuestionIds: [],
    flowId: "docs",
    changeset: [{ path: "guide.md", content: "# Guide\nnew" }]
  });

  await reconcileSourceSyncProposal(ctx, proposal);

  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].proposalId, proposal.id);
});

it("publishes a source-sync proposal when overlap is non-touchable", async () => {
  const ctx = makeTestContext();
  const approved = await ctx.stores.proposals.create({
    title: "Approved Guide",
    targetPath: "guide.md",
    markdown: "# Guide\napproved",
    evidence: [],
    triggeringQuestionIds: [],
    flowId: "docs"
  });
  await ctx.stores.proposals.updateReviewDecision(approved.id, "approved");
  const rival = await ctx.stores.proposals.create({
    title: "Sync docs to Rules changes",
    targetPath: "guide.md",
    markdown: "# Guide\nnew",
    evidence: [],
    triggeringQuestionIds: [],
    flowId: "docs",
    changeset: [{ path: "guide.md", content: "# Guide\nnew" }]
  });

  await reconcileSourceSyncProposal(ctx, rival);

  const jobs = (await ctx.jobs.list({})).jobs;
  assert.equal(jobs.some((job) => job.type === "fold_changeset_proposal"), false);
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.equal(actions[0].proposalId, rival.id);
});
```

Add the import:

```ts
import { reconcileSourceSyncProposal } from "./fold.js";
```

- [ ] **Step 2: Run fold tests and verify failures**

Run:

```bash
node --import tsx --test "apps/api/src/scheduling/fold.test.ts"
```

Expected: FAIL because the temporary stub does not enqueue `fold_changeset_proposal`.

- [ ] **Step 3: Replace the stub with the real implementation**

In `apps/api/src/scheduling/fold.ts`, replace `reconcileSourceSyncProposal` with:

```ts
export async function reconcileSourceSyncProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) {
    return;
  }
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const targets = proposalTargets(proposal);
  const intent: ChangeIntent = {
    lens: "source-sync",
    flowId,
    targets,
    evidence: proposal.draftContext?.sourceFiles.map((source) => source.path ?? source.url ?? source.sourceName) ?? [],
    rationale: proposal.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));

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
      console.log(`Source-sync fold: enqueued fold of ${proposal.id} into ${survivor.id} on [${targets.join(", ")}].`);
      return;
    }
  }

  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
  console.log(`Source-sync ${proposal.id} (${decision.kind}) on [${targets.join(", ")}]: enqueued to publish.`);
}
```

- [ ] **Step 4: Update source-sync overlap tests**

In `apps/api/src/features/source-sync/orchestration.test.ts`, replace the two deferred tests:

```ts
test("a source-sync change that overlaps a touchable open PR is deferred, not published", async () => {
```

and:

```ts
test("a source-sync change that overlaps an approved PR is also deferred", async () => {
```

with expectations that:

- a touchable overlap creates a source-sync proposal and enqueues `fold_changeset_proposal`;
- an approved overlap creates a source-sync proposal and enqueues `publish_proposal`;
- no `publish_source_sync` job exists.

Use this assertion shape in the touchable test:

```ts
const proposal = (await ctx.stores.proposals.list(20)).find((candidate) => candidate.jobId === jobId);
assert.ok(proposal, "source-sync proposal created");
const foldJob = (await ctx.jobs.list({})).jobs.find((job) => job.type === "fold_changeset_proposal");
assert.ok(foldJob, "source-sync proposal folded into touchable overlap");
assert.equal((await ctx.jobs.list({})).jobs.some((job) => job.type === "publish_source_sync" as never), false);
```

Use this assertion shape in the approved test:

```ts
const proposal = (await ctx.stores.proposals.list(20)).find((candidate) => candidate.jobId === jobId);
assert.ok(proposal, "source-sync proposal created");
const publish = (await ctx.jobs.list({})).jobs.find((job) => job.type === "publish_proposal");
assert.ok(publish, "approved overlap self-publishes as proposal");
assert.deepEqual(publish.input, { proposalId: proposal.id });
```

- [ ] **Step 5: Delete re-gate tests**

Remove these Scope A tests from `apps/api/src/features/source-sync/orchestration.test.ts`:

```ts
test("re-gate completes a deferred run once its overlapping PR is gone", async () => {
test("re-gate leaves a deferred run deferred while the overlap persists", async () => {
test("two concurrent re-gate ticks publish a cleared deferred run exactly once", async () => {
```

Deferred source-sync runs are no longer part of the steady state.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --import tsx --test "apps/api/src/scheduling/fold.test.ts" "apps/api/src/features/source-sync/orchestration.test.ts"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/scheduling/fold.ts apps/api/src/scheduling/fold.test.ts apps/api/src/features/source-sync/orchestration.test.ts
git commit -m "feat(api): fold source-sync proposals through the gate"
```

---

### Task 4: Remove source-sync direct publication from API routes and stores

**Files:**
- Modify: `apps/api/src/features/source-sync/service.ts`
- Modify: `apps/api/src/features/source-sync/routes.ts`
- Modify: `apps/api/src/features/source-sync/routes.test.ts`
- Modify: `apps/api/src/features/jobs/service.ts`
- Modify: `apps/api/src/features/jobs/service.test.ts`
- Modify: `apps/api/src/stores/source-sync-store.ts`
- Modify: `apps/api/src/stores/postgres-source-sync-store.ts`
- Modify: `apps/api/src/stores/source-sync-store.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write route test for removed execution context**

In `apps/api/src/features/source-sync/routes.test.ts`, change the execution-context test to:

```ts
test("GET /api/source-sync/runs/:id/execution-context is retired", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/source-sync/runs/missing/execution-context");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run:

```bash
node --import tsx --test "apps/api/src/features/source-sync/routes.test.ts"
```

Expected: FAIL because the route still exists and returns `source_sync_run_not_found`.

- [ ] **Step 3: Remove route and service APIs**

In `apps/api/src/features/source-sync/routes.ts`, delete the route:

```ts
app.get("/runs/:id/execution-context", requireScopes("manage:knowledge"), async (c) => {
  const outcome = await sourceSyncService.getRunExecutionContext(ctx, c.req.param("id"));
  if (!outcome.ok) {
    throw new HttpError(outcome.status, outcome.code, outcome.message);
  }
  return c.json({ run: outcome.run, sourceName: outcome.sourceName, repository: outcome.repository });
});
```

In `apps/api/src/features/source-sync/service.ts`, delete:

- `SourceSyncPublishValidationError`;
- `resolvePublishRepository`;
- `ExecutionContextRepository`;
- `getRunExecutionContext`;
- `PublishSourceSyncJobOutput`;
- `recordSourceSyncPublicationFromCompletedJob`;
- `enqueuePublication`;
- `regateDeferredRuns`;
- any now-unused imports: `publishSourceSyncOutputSchema`, `RepositoryRef`, `findRepositoryForDestination`, `z` if only used for publish output.

Also remove the call to `regateDeferredRuns(ctx, flowId)` from `triggerSourceSyncRun`.

- [ ] **Step 4: Remove job completion dispatch**

In `apps/api/src/features/jobs/service.ts`, remove the line:

```ts
await sourceSyncService.recordSourceSyncPublicationFromCompletedJob(ctx, existingJob, parsed.data);
```

Update the dispatcher comment so it no longer mentions source-sync publication.

In `apps/api/src/features/jobs/service.test.ts`, delete:

```ts
test("source-sync publication completion records the publication once and is idempotent", async () => {
```

- [ ] **Step 5: Remove store-level publication ownership**

In `apps/api/src/stores/source-sync-store.ts`, remove from imports:

```ts
ProposalPublication
```

Remove from `SourceSyncStore`:

```ts
recordRunPublication(id: string, publication: ProposalPublication): Promise<SourceSyncRun | undefined>;
```

Remove from `InMemorySourceSyncStore`:

```ts
async recordRunPublication(id: string, publication: ProposalPublication): Promise<SourceSyncRun | undefined> {
  const existing = this.runs.get(id);
  if (!existing) {
    return undefined;
  }
  const updated: SourceSyncRun = { ...existing, status: "published", publication };
  this.runs.set(id, updated);
  return updated;
}
```

Make the equivalent method deletion in `apps/api/src/stores/postgres-source-sync-store.ts`.

- [ ] **Step 6: Narrow core source-sync run comments/types**

In `packages/core/src/index.ts`, update `SourceSyncRunStatus` to remove statuses no longer emitted:

```ts
export type SourceSyncRunStatus = "running" | "completed" | "failed" | "skipped";
```

Remove `publication?: ProposalPublication;` from `SourceSyncRun`.

Update the preceding comment so it no longer describes `deferred` or run-level publication.

- [ ] **Step 7: Update store tests**

In `apps/api/src/stores/source-sync-store.test.ts`, delete tests for:

- `deferRun`;
- `listDeferredRuns`;
- `completeDeferredRun`;
- `recordRunPublication`.

Keep tests for `completeRun`, `markSkipped`, `failRun`, `listRuns`, `getRunByJobId`, and reset behavior.

- [ ] **Step 8: Run focused API/source-sync tests**

Run:

```bash
node --import tsx --test "apps/api/src/features/source-sync/**/*.test.ts" "apps/api/src/features/jobs/**/*.test.ts" "apps/api/src/stores/source-sync-store.test.ts"
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/features/source-sync/service.ts apps/api/src/features/source-sync/routes.ts apps/api/src/features/source-sync/routes.test.ts apps/api/src/features/jobs/service.ts apps/api/src/features/jobs/service.test.ts apps/api/src/stores/source-sync-store.ts apps/api/src/stores/postgres-source-sync-store.ts apps/api/src/stores/source-sync-store.test.ts packages/core/src/index.ts
git commit -m "refactor(api): remove direct source-sync publication"
```

---

### Task 5: Remove source-sync direct publication from the watcher

**Files:**
- Modify: `apps/watcher/src/runners/publication.ts`
- Modify: `apps/watcher/src/http-client.ts`
- Modify: `apps/watcher/src/runners/publication.test.ts`
- Modify: `apps/watcher/src/capabilities.test.ts` if queue expectations mention `publish_source_sync`

- [ ] **Step 1: Update watcher tests first**

In `apps/watcher/src/runners/publication.test.ts`, remove tests that call or expect `publish_source_sync`.

Add or keep a proposal changeset publication test that proves source-sync-style changesets still publish via `publish_proposal`:

```ts
it("publishes a changeset proposal through publish_proposal", async () => {
  const api = fakeApi({
    proposal: {
      id: "proposal-1",
      title: "Sync docs to Rules changes",
      targetPath: "guide.md",
      markdown: "# Guide\nnew",
      changeset: [{ path: "guide.md", content: "# Guide\nnew" }]
    }
  });
  const deps = fakePublicationDeps();
  const runner = new PublicationRunner(api, deps);

  const output = await runner.run(job("publish_proposal", { proposalId: "proposal-1" }), new AbortController().signal);

  assert.equal(deps.publishChangesetCalls.length, 1);
  assert.equal(deps.publishProposalCalls.length, 0);
  assert.equal((output as { proposalId: string }).proposalId, "proposal-1");
});
```

Use the existing test helpers in that file rather than inventing new helper styles.

- [ ] **Step 2: Run watcher publication tests and verify failure**

Run:

```bash
node --import tsx --test "apps/watcher/src/runners/publication.test.ts"
```

Expected: FAIL until `publish_source_sync` support is removed and tests are aligned.

- [ ] **Step 3: Remove watcher publish_source_sync support**

In `apps/watcher/src/runners/publication.ts`, remove imports:

```ts
publishSourceSyncInputSchema,
publishSourceSyncOutputSchema
```

Remove `SourceSyncExecutionContext` from imported types.

Remove `sourceSyncRunSchema`, `PublishSourceSyncRun`, `parseSourceSyncContext`, `sourceSyncBranchName`, and `publishSourceSync`.

Remove `"publish_source_sync"` from `PUBLISH_JOB_TYPES`.

Remove this branch from `run`:

```ts
if (job.type === "publish_source_sync") {
  return this.publishSourceSync(job);
}
```

In `apps/watcher/src/http-client.ts`, remove:

- `SourceSyncExecutionContext` type;
- `sourceSyncExecutionContext(runId: string)`;
- any `/api/source-sync/runs/:id/execution-context` client method.

- [ ] **Step 4: Run watcher tests**

Run:

```bash
node --import tsx --test "apps/watcher/src/**/*.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/runners/publication.ts apps/watcher/src/http-client.ts apps/watcher/src/runners/publication.test.ts apps/watcher/src/capabilities.test.ts
git commit -m "refactor(watcher): publish source-sync via proposals"
```

---

### Task 6: Update docs and dataflow status

**Files:**
- Modify: `docs/scheduled-jobs-migration-status.md`
- Modify: `docs/maintenance-redesign.md`
- Modify: `docs/api.md`
- Modify: `docs/ai-jobs.md`
- Modify: `apps/web/src/components/dataflow/flows.ts`
- Modify: `apps/web/src/components/dataflow/flows.test.tsx`

- [ ] **Step 1: Update docs to remove stale `publish_source_sync` and Scope B language**

In `docs/scheduled-jobs-migration-status.md`, mark the Scope B checklist item as shipped and leave the `MaintenanceRun` migration as a follow-up.

In `docs/maintenance-redesign.md`, replace the Scope B planned paragraph with shipped language:

```md
- **Scope B (shipped):** source-change-sync now creates first-class proposals, so it folds through the same gate and publishes reviewable PRs like the other lenses.
```

In `docs/api.md` and `docs/ai-jobs.md`, remove references to `publish_source_sync` and direct source-sync execution-context publication. Describe source-sync as producing proposal work after its plan job completes.

- [ ] **Step 2: Align dataflow graph/test**

In `apps/web/src/components/dataflow/flows.ts`, keep the post-Scope-B graph but remove comments that imply it is aspirational or future-tense.

In `apps/web/src/components/dataflow/flows.test.tsx`, keep the existing test that asserts the graph depicts the post-Scope-B outcome.

- [ ] **Step 3: Scan for stale references**

Run:

```bash
rg -n "publish_source_sync|source-sync is not \\(yet\\) a Proposal|Scope B \\(planned\\)|can only defer|never folds" apps packages docs -S
```

Expected: no runtime references to `publish_source_sync`; historical references may remain only inside old `docs/superpowers/plans/**` or `docs/superpowers/specs/**` files. If active docs still match, update them.

- [ ] **Step 4: Run dataflow tests**

Run:

```bash
node --import tsx --test "apps/web/src/components/dataflow/flows.test.tsx"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/scheduled-jobs-migration-status.md docs/maintenance-redesign.md docs/api.md docs/ai-jobs.md apps/web/src/components/dataflow/flows.ts apps/web/src/components/dataflow/flows.test.tsx
git commit -m "docs: mark source-sync scope b shipped"
```

---

### Task 7: Final verification and cleanup

**Files:**
- Potentially modify files surfaced by typecheck/deadcode only.

- [ ] **Step 1: Run the planned verification commands**

Run:

```bash
npm test -w @magpie/jobs
node --import tsx --test "apps/api/src/features/source-sync/**/*.test.ts" "apps/api/src/features/jobs/**/*.test.ts" "apps/api/src/scheduling/**/*.test.ts"
node --import tsx --test "apps/watcher/src/**/*.test.ts"
npm run typecheck
npm run deadcode
```

Expected: all commands exit 0.

- [ ] **Step 2: Fix any dead-code or type failures directly related to this change**

Typical expected cleanup if the commands fail:

- remove unused imports from `source-sync/service.ts`;
- remove unused exports from `packages/jobs/src/schemas.ts`;
- remove stale type exports from `apps/watcher/src/http-client.ts`;
- update exact catalog test counts after removing one job type.

Run the failing command again after each fix.

- [ ] **Step 3: Confirm only intended changes are present**

Run:

```bash
git status --short
git diff --stat
```

Expected: only files touched by this plan are modified. The pre-existing unrelated deletion `docs/superpowers/RESUME-shared-prompt-catalog.md` may still be present and must not be staged unless the user separately asks for it.

- [ ] **Step 4: Commit final cleanup if needed**

If Step 2 changed files:

```bash
git add packages/jobs/src apps/api/src/features/source-sync apps/api/src/features/jobs apps/api/src/scheduling apps/api/src/stores packages/core/src apps/watcher/src docs/scheduled-jobs-migration-status.md docs/maintenance-redesign.md docs/api.md docs/ai-jobs.md apps/web/src/components/dataflow
git commit -m "chore: clean up source-sync proposal conversion"
```

If Step 2 changed nothing, skip this commit.

---

## Spec Coverage

- Source-sync creates normal proposals: Task 2.
- `publish_source_sync` removal: Tasks 1, 4, and 5.
- `fold_changeset_proposal` source-sync folding: Task 3.
- `SourceSyncRun` remains planning audit only: Task 4.
- Empty and failed plan behavior preserved: Tasks 2 and 4.
- Docs/dataflow alignment: Task 6.
- Verification commands from the spec: Task 7.

## Execution Notes

- Keep commits small and task-scoped.
- Do not stage `docs/superpowers/RESUME-shared-prompt-catalog.md`; it is an unrelated pre-existing deletion.
- Prefer existing helper patterns in tests over new abstractions.
- Use `apply_patch` for manual edits.
