# Link Autonomous Drafts to Their Gap Cluster — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry `gapClusterId` from a cluster through the `draft_markdown_proposal` job to the created proposal, so autonomously-drafted proposals are linked to their cluster (fixing duplicate-PR re-drafts and laying the foundation for fold).

**Architecture:** Declare `gapClusterId` on the draft-job contract (core type + zod schema) so the broker preserves it, then thread it `draftFromCluster → draftFromGaps → job input → createProposalFromCompletedJob → proposals.create`. No store/migration/job-type changes. Spec: [`2026-06-23-link-drafts-to-clusters-design.md`](../specs/2026-06-23-link-drafts-to-clusters-design.md).

**Tech Stack:** TypeScript (ESM, `.js` suffixes), Node built-in test runner (`node --import tsx --test`), zod. Workspaces: `@magpie/core`, `@magpie/jobs`, `@magpie/api`.

## Global Constraints

- **ESM imports** — local imports use `.js`; package imports none.
- **The broker strips undeclared input keys** — it stores `inputSchema.safeParse(input).data` (`apps/api/src/jobs/fake-broker.ts`). A field only survives in `job.input` if it is declared on `draftMarkdownProposalInputSchema`. This is the whole reason Task 1 exists; do not "passthrough" `gapClusterId` without declaring it.
- **The schema `satisfies z.ZodType<ProviderInput<CoreDraftMarkdownProposalJobInput>>`** — so the schema and the core type must stay aligned: add `gapClusterId?` to BOTH or the `satisfies` check fails to compile.
- **knip strict** (`npm run deadcode`) and the **root** `npm run typecheck` are the CI gates (not `-w @magpie/api`).
- **On-demand path unchanged** — `draftFromGaps` callers that pass no `gapClusterId` must behave exactly as today (proposal stays unlinked).

---

## File Structure

| File | Change |
| --- | --- |
| `packages/core/src/index.ts` (modify) | add `gapClusterId?: string` to `DraftMarkdownProposalJobInput` |
| `packages/jobs/src/schemas.ts` (modify) | add `gapClusterId: z.string().optional()` to `draftMarkdownProposalInputSchema` |
| `packages/jobs/src/schemas.test.ts` (create or extend) | schema preserves `gapClusterId` |
| `apps/api/src/features/proposals/service.ts` (modify) | `draftFromGaps` threads `gapClusterId`; `createProposalFromCompletedJob` reads it |
| `apps/api/src/features/gaps/service.ts` (modify) | `draftFromCluster` passes `gapClusterId: clusterId` |
| `apps/api/src/features/proposals/link-cluster.test.ts` (create) | threading + completion-linking + on-demand-unchanged |
| `apps/api/src/scheduling/gap-reconciler-link.test.ts` (create) | duplicate-redraft regression |

---

## Task 1: Declare `gapClusterId` on the draft-job contract

**Files:**
- Modify: `packages/core/src/index.ts`, `packages/jobs/src/schemas.ts`
- Test: `packages/jobs/src/schemas.test.ts`

**Interfaces:**
- Produces: `DraftMarkdownProposalJobInput.gapClusterId?: string`; `draftMarkdownProposalInputSchema` accepts + preserves `gapClusterId`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/jobs/src/schemas.test.ts  (create; if it exists, append)
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftMarkdownProposalInputSchema } from "./schemas.js";

test("draft input schema preserves gapClusterId", () => {
  const parsed = draftMarkdownProposalInputSchema.parse({
    provider: "codex",
    gapSummaries: ["g"],
    triggeringQuestions: ["q"],
    evidence: [],
    expectedOutput: "markdown_proposal",
    gapClusterId: "cluster-1"
  });
  assert.equal(parsed.gapClusterId, "cluster-1");
});

test("draft input schema leaves gapClusterId absent when not provided", () => {
  const parsed = draftMarkdownProposalInputSchema.parse({
    provider: "codex",
    gapSummaries: ["g"],
    triggeringQuestions: ["q"],
    evidence: [],
    expectedOutput: "markdown_proposal"
  });
  assert.equal(parsed.gapClusterId, undefined);
});
```

> Note: confirm `"codex"` is a valid `providerSchema` value by checking `providerSchema` in `schemas.ts`; if not, use a value it accepts (e.g. `"openai-compatible"`). Keep the rest identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/jobs -- --test-name-pattern="gapClusterId"`
Expected: FAIL — first test: `parsed.gapClusterId` is `undefined` (schema strips it).

- [ ] **Step 3: Write the implementation**

In `packages/core/src/index.ts`, inside `interface DraftMarkdownProposalJobInput` (after `targetPath?: string;`, before `expectedOutput`):

```typescript
  // The gap cluster this draft belongs to, so the created proposal can be linked
  // back to it on the autonomous path. Absent on the on-demand HTTP draft path.
  gapClusterId?: string;
```

In `packages/jobs/src/schemas.ts`, inside `draftMarkdownProposalInputSchema` (after `targetPath: z.string().optional(),`):

```typescript
  gapClusterId: z.string().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/jobs -- --test-name-pattern="gapClusterId"`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck the contract alignment**

Run: `npm run typecheck`
Expected: clean — proves the schema still `satisfies ProviderInput<DraftMarkdownProposalJobInput>` with the field added to both.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/jobs/src/schemas.ts packages/jobs/src/schemas.test.ts
git commit -m "feat(jobs): add gapClusterId to draft_markdown_proposal input"
```

---

## Task 2: Thread `gapClusterId` cluster → job → proposal

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts`, `apps/api/src/features/gaps/service.ts`
- Test: `apps/api/src/features/proposals/link-cluster.test.ts`

**Interfaces:**
- Consumes: `gapClusterId` on the draft input schema (Task 1).
- Produces: `draftFromGaps` overrides accept `gapClusterId?: string` and put it in the job input; `draftFromCluster` passes the cluster id; `createProposalFromCompletedJob` sets `gapClusterId` on the created proposal.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/features/proposals/link-cluster.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import { makeTestContext } from "../../test-support/context.js";
import { createProposalFromCompletedJob } from "./service.js";

const draftOutput = {
  title: "Refund timing",
  targetPath: "kb/refunds.md",
  markdown: "# Refunds",
  rationale: "covers the gap"
};

function draftJob(input: Record<string, unknown>): JobView {
  return {
    id: "job-1",
    type: "draft_markdown_proposal",
    input,
    state: "completed"
  } as unknown as JobView;
}

describe("createProposalFromCompletedJob cluster linking", () => {
  it("links the created proposal to the gapClusterId in the job input", async () => {
    const ctx = makeTestContext();
    const proposal = await createProposalFromCompletedJob(
      ctx,
      draftJob({ gapSummaries: ["g"], evidence: [], gapClusterId: "cluster-7" }),
      draftOutput
    );
    assert.equal(proposal?.gapClusterId, "cluster-7");
  });

  it("leaves the proposal unlinked when the job input has no gapClusterId", async () => {
    const ctx = makeTestContext();
    const proposal = await createProposalFromCompletedJob(
      ctx,
      draftJob({ gapSummaries: ["g"], evidence: [] }),
      draftOutput
    );
    assert.equal(proposal?.gapClusterId, undefined);
  });
});
```

> Note: confirm `createProposalFromCompletedJob` is exported from `service.ts` (it is, per the spec's file map). The `draftJob` cast supplies only the fields the handler reads; if the handler dereferences a field this fixture omits and throws, add that field to the `input` object.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @magpie/api -- --test-name-pattern="cluster linking"`
Expected: FAIL — first test: `proposal.gapClusterId` is `undefined` (handler doesn't read it yet).

- [ ] **Step 3: Implement the completion-handler read**

In `apps/api/src/features/proposals/service.ts`, in `createProposalFromCompletedJob`, add `gapClusterId` to the `create(...)` call (after `destinationId: input.destinationId,`):

```typescript
    gapClusterId: input.gapClusterId,
```

And widen the local `input` cast so the field is typed — change:

```typescript
  const input = job.input as Partial<DraftMarkdownProposalJobInput> & {
    triggeringQuestionIds?: string[];
  };
```

(`DraftMarkdownProposalJobInput` now includes `gapClusterId?`, so no further cast change is needed — confirm `DraftMarkdownProposalJobInput` is the imported type here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @magpie/api -- --test-name-pattern="cluster linking"`
Expected: PASS (2 tests).

- [ ] **Step 5: Thread it from the draft sites**

In `apps/api/src/features/proposals/service.ts`, add `gapClusterId` to the `draftFromGaps` `overrides` type (after `openPullRequests?: OpenPullRequestContext[];`):

```typescript
    // The cluster this draft belongs to, threaded onto the job so the completed
    // proposal links back to it. Absent on the on-demand path.
    gapClusterId?: string;
```

and into the `input` object built for the job (after `targetPath: overrides.targetPath?.trim() || undefined,`):

```typescript
    gapClusterId: overrides.gapClusterId,
```

In `apps/api/src/features/gaps/service.ts`, in `draftFromCluster`, pass the cluster id into the `draftFromGaps` call (add to the overrides object):

```typescript
    gapClusterId: clusterId,
```

- [ ] **Step 6: Write the threading + on-demand test**

```typescript
// append to apps/api/src/features/proposals/link-cluster.test.ts
import { draftFromGaps } from "./service.js";

describe("draftFromGaps threads gapClusterId into the job input", () => {
  async function seedGap(ctx: ReturnType<typeof makeTestContext>, summary: string): Promise<void> {
    const log = await ctx.stores.questionLogs.record({
      question: `${summary}?`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });
    await ctx.stores.questionLogs.recordManualGap(log.id, summary);
  }

  it("includes gapClusterId in the enqueued draft job when provided", async () => {
    const ctx = makeTestContext();
    await seedGap(ctx, "Refunds");
    const outcome = await draftFromGaps(ctx, ["Refunds"], { gapClusterId: "cluster-9" });
    assert.equal(outcome.ok, true);
    const jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0].input as { gapClusterId?: string }).gapClusterId, "cluster-9");
  });

  it("omits gapClusterId on the on-demand path", async () => {
    const ctx = makeTestContext();
    await seedGap(ctx, "Refunds");
    const outcome = await draftFromGaps(ctx, ["Refunds"], {});
    assert.equal(outcome.ok, true);
    const jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal((jobs[0].input as { gapClusterId?: string }).gapClusterId, undefined);
  });
});
```

> Note: confirm the gap-seeding calls (`questionLogs.record` / `recordManualGap`) and the `ctx.jobs.list({type}).jobs` shape against `apps/api/src/scheduling/gap-reconciler.test.ts` (it uses the same harness). Adjust the seed helper to match that file if the signatures differ. `draftFromGaps` matches summaries against `listGapCandidates`, so the seeded summary must equal the requested one.

- [ ] **Step 7: Run the full file + gates**

Run: `npm run typecheck && npm run deadcode && npm test -w @magpie/api -- --test-name-pattern="cluster linking|threads gapClusterId"`
Expected: typecheck + knip clean; 4 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/features/proposals/service.ts apps/api/src/features/gaps/service.ts apps/api/src/features/proposals/link-cluster.test.ts
git commit -m "feat(api): link autonomous drafts to their gap cluster"
```

---

## Task 3: Duplicate-redraft regression test

**Files:**
- Test: `apps/api/src/scheduling/gap-reconciler-link.test.ts`

**Interfaces:**
- Consumes: the linking from Task 2; the existing `reconcileGaps` and in-memory harness.

**Behaviour proven:** once a cluster has a linked proposal, a later reconcile run (after a revision bump from a different cluster) does **not** re-draft that cluster. This is the user-facing duplicate-PR bug.

- [ ] **Step 1: Write the regression test**

```typescript
// apps/api/src/scheduling/gap-reconciler-link.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";
import type { AppContext } from "../context.js";

const keepOpen = { fetchPullRequestStatus: async () => ({ merged: false, state: "open" as const }) };

async function seedClusterWithGap(ctx: AppContext, summary: string): Promise<string> {
  const log = await ctx.stores.questionLogs.record({
    question: `${summary}?`,
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, summary);
  const cluster = await ctx.stores.gapClusters.createCluster({ title: summary, revision: 1 });
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary(summary);
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);
  return cluster.id;
}

function draftJobsForCluster(jobs: { input: unknown }[], clusterId: string): number {
  return jobs.filter((j) => (j.input as { gapClusterId?: string }).gapClusterId === clusterId).length;
}

describe("autonomous drafts are not re-drafted once linked", () => {
  it("does not enqueue a second draft for a cluster that already has a linked proposal", async () => {
    const ctx = makeTestContext();
    const clusterA = await seedClusterWithGap(ctx, "Refunds");

    // First reconcile: drafts cluster A (one draft job carrying gapClusterId=A).
    await reconcileGaps(ctx, undefined, keepOpen);
    let jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(draftJobsForCluster(jobs, clusterA), 1, "A drafted once");

    // Simulate that draft completing into a linked proposal (what
    // createProposalFromCompletedJob does once the watcher finishes).
    await ctx.stores.proposals.create({
      title: "Refunds",
      targetPath: "kb/refunds.md",
      markdown: "# Refunds",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: [],
      gapClusterId: clusterA
    });

    // A new gap in a different cluster bumps the catalog revision so the next
    // reconcile re-runs clustering + drafting.
    await seedClusterWithGap(ctx, "Credit notes");

    // Second reconcile: drafts the new cluster but NOT A again.
    await reconcileGaps(ctx, undefined, keepOpen);
    jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(draftJobsForCluster(jobs, clusterA), 1, "A is not re-drafted once it has a linked proposal");
  });
});
```

> Note: this drives the real `reconcileGaps`. Mirror `apps/api/src/scheduling/gap-reconciler.test.ts` for: the exact `questionLogs.record`/`recordManualGap`/`gapIdsForSummary`/`createCluster`/`assignGapToCluster` signatures, and confirm `reconcileGaps` completes offline (the reshape step `requestReshape` must no-op without a chat watcher — that file's tests already rely on this). If reshape blocks, copy whatever that file does to keep it offline. The key assertions (draft-jobs-for-A stays 1) are the regression and must not change.

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="not re-drafted once linked"`
Expected: PASS. (Sanity: temporarily removing `gapClusterId: clusterA` from the simulated proposal makes the final assertion fail — A gets re-drafted — confirming the test actually guards the bug. Revert after checking.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/scheduling/gap-reconciler-link.test.ts
git commit -m "test(api): cover no-duplicate-redraft once a draft is cluster-linked"
```

---

## Self-Review

- **Spec coverage:** contract declaration (core + schema) = Task 1; threading + completion linking + on-demand-unchanged = Task 2; the duplicate-redraft bug = Task 3. The mechanism note (broker strips undeclared keys) is honoured by Task 1 being a real schema change, not a passthrough.
- **Placeholder scan:** none — every step has complete code. Four `> Note:` callouts are verify-then-use against existing files (provider value, `createProposalFromCompletedJob` export, harness signatures, reshape-offline behaviour), not placeholders.
- **Type consistency:** `gapClusterId` is the single field name across the core type, schema, `draftFromGaps` overrides, the job input, `createProposalFromCompletedJob`, `draftFromCluster`, and all tests. The `satisfies` alignment is explicitly typecheck-gated in Task 1 Step 5.
- **Out of scope:** the parallel `triggeringQuestionIds`/`openPullRequests` strip is a separate follow-up (spawned task), not addressed here.
