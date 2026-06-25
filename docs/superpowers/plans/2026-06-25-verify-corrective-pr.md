# Verify → corrective PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a verify-lens "unprovable" finding into an actual corrective pull request, routed through the shared reconcile gate so it folds into — never competes with — an open PR on the same file.

**Architecture:** A new `correct_document` AI job repairs a flagged document (repair-or-remove, grounded in the supplied sources). fix-patrol enqueues one per unprovable finding. On completion, a draft `Proposal` (carrying a new first-class `flowId`) is created and reconciled through the gate (fold / defer / open-new), publishing via the existing per-flow publication outbox. Reuses the gap lens's proposal → fold → publish machinery end-to-end.

**Tech Stack:** TypeScript (Node ESM), Zod schemas, Postgres + in-memory stores, pg-boss queue, `node:test`.

## Global Constraints

- UK English in all prose/comments/copy.
- Never process `/sites/CustomerData/` SharePoint content (Rosetta is the allowed exception).
- Workspace tests run via `npm test -w @magpie/<pkg>` — never root-cwd `node --test` (resolves `@magpie/*` to stale dist).
- Pre-PR gates: `npm test` + `npm run typecheck` + `npm run deadcode` (knip STRICT — fix unused exports by de-exporting, never relax the config).
- New AI job type checklist: add to `JOB_TYPES` (types.ts), a `define(...)` entry + the `aiJobTypes` set (catalog.ts), `EXPIRATION_SECONDS` + a routing test (catalog.test.ts), input/output zod schemas (schemas.ts), core types (core/index.ts), a watcher `buildPrompt` case (job-prompts.ts).
- New prompt checklist: add to `promptCatalog` (prompts/catalog.ts), bump the count (13→14) and order array in prompts/catalog.test.ts, and bump the `/api/prompts` count (13→14) in apps/api/src/app.test.ts.
- Migrations are applied in lexical filename order, keyed by filename in `schema_migrations`; next number is **0029** (two 0027s and two 0028s already exist).
- Enqueue-only completion-side work: nothing in a maintenance POST blocks on the model.

---

### Task 1: `correct_document` job contract (additive, no behaviour)

Adds the job type, schemas, core types, catalog entry, prompt, and watcher prompt case. Pure additive — nothing calls it yet. Deliverable: the contract exists and every count/routing test passes.

**Files:**
- Modify: `packages/core/src/index.ts` (after `VerifyDocumentJobOutput`, ~line 430)
- Modify: `packages/jobs/src/schemas.ts` (after `verifyDocumentOutputSchema`, ~line 255; imports ~line 16)
- Modify: `packages/jobs/src/types.ts` (`JOB_TYPES`, after `"verify_document"`, line 14)
- Modify: `packages/jobs/src/catalog.ts` (`definitions` ~line 76; `aiJobTypes` ~line 108)
- Modify: `packages/jobs/src/catalog.test.ts` (`EXPIRATION_SECONDS` ~line 27; new routing test ~line 132)
- Modify: `packages/prompts/src/catalog.ts` (new `CORRECT_DOCUMENT` after `VERIFY_DOCUMENT` ~line 191; `promptCatalog` ~line 278)
- Modify: `packages/prompts/src/catalog.test.ts` (count + order)
- Modify: `apps/api/src/app.test.ts` (`/api/prompts` count ~line 197)
- Modify: `apps/watcher/src/job-prompts.ts` (import + `buildPrompt` case)

**Interfaces:**
- Produces: `CorrectDocumentJobInput { path: string; content: string; claims: UnprovableClaim[]; sources: SourceDataContext[]; destinationId?: string; flowId?: string }` and `CorrectDocumentJobOutput { markdown: string; rationale: string }` (core); `correctDocumentInputSchema`, `correctDocumentOutputSchema` (jobs); job type `"correct_document"`; prompt `CORRECT_DOCUMENT`.

- [ ] **Step 1: Add the routing test (failing)**

In `packages/jobs/src/catalog.test.ts`, add `correct_document: 10 * 60,` to the `EXPIRATION_SECONDS` object (after the `verify_document` line, ~line 27). Then add this test after the `verify_document routes…` test (~line 132):

```ts
test("correct_document routes by provider like other AI work", () => {
  const definition = jobDefinition("correct_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("correct_document", { provider: "codex" }), "correct_document__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("correct_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("correct_document__codex"));
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -w @magpie/jobs`
Expected: FAIL — `"correct_document"` is not a `JobType` (typecheck/runtime error in `jobDefinition`), and the `every job type…` test fails on the missing `EXPIRATION_SECONDS` lookup for any new type.

- [ ] **Step 3: Add core types**

In `packages/core/src/index.ts`, after `VerifyDocumentJobOutput` (~line 430):

```ts
// Input to the correct_document AI job: a document the verify lens flagged as
// unprovable, the specific claims to repair, and the source material to ground the
// repair in. `provider` is added at enqueue (see @magpie/jobs).
export interface CorrectDocumentJobInput {
  path: string;
  content: string;
  claims: UnprovableClaim[];
  sources: SourceDataContext[];
  destinationId?: string;
  flowId?: string;
}

// Output of the correct_document job: the full corrected document body (each
// flagged claim rewritten to match a source excerpt, or removed when unsupportable)
// plus a short rationale.
export interface CorrectDocumentJobOutput {
  markdown: string;
  rationale: string;
}
```

- [ ] **Step 4: Add jobs schemas**

In `packages/jobs/src/schemas.ts`, add to the `@magpie/core` import block (~line 16, next to `VerifyDocumentJobOutput`):

```ts
  CorrectDocumentJobInput as CoreCorrectDocumentJobInput,
  CorrectDocumentJobOutput,
```

After `verifyDocumentOutputSchema` (~line 255):

```ts
export const correctDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  claims: z.array(z.object({ claim: z.string(), reason: z.string() })),
  sources: z.array(sourceDataContextSchema),
  destinationId: z.string().optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreCorrectDocumentJobInput>>;
export const correctDocumentOutputSchema = z.object({
  markdown: z.string(),
  rationale: z.string()
}) satisfies z.ZodType<CorrectDocumentJobOutput>;
```

- [ ] **Step 5: Register the job type + definition + AI set**

`packages/jobs/src/types.ts` — add `"correct_document",` to `JOB_TYPES` immediately after `"verify_document",` (line 14).

`packages/jobs/src/catalog.ts` — add to `definitions` after the `verify_document` line (~line 76):

```ts
  correct_document: define("correct_document", "provider", schemas.correctDocumentInputSchema, schemas.correctDocumentOutputSchema, 10 * 60),
```

…and add `"correct_document",` to the `aiJobTypes` set after `"verify_document"` (~line 108).

- [ ] **Step 6: Run jobs tests — verify they pass**

Run: `npm test -w @magpie/jobs`
Expected: PASS (new routing test + all existing).

- [ ] **Step 7: Add the prompt (failing prompt tests first)**

`packages/prompts/src/catalog.test.ts` — change `assert.equal(promptCatalog.length, 13)` to `14`, and insert `"correct-document",` into the order array immediately after `"verify-document"`.

Run: `npm test -w @magpie/prompts`
Expected: FAIL — length is 13, order array mismatch.

- [ ] **Step 8: Define the prompt**

`packages/prompts/src/catalog.ts` — after `VERIFY_DOCUMENT` (~line 191):

```ts
export const CORRECT_DOCUMENT: PromptDefinition = {
  id: "correct-document",
  title: "Correct a document's unprovable claims",
  description:
    "Repairs a knowledge-base document the verify lens flagged: each unprovable claim is rewritten to match a supporting source excerpt, or removed when the sources do not support it. Returns the full corrected document. Used by the watcher's correct_document job.",
  usedBy: ["watcher · fix-patrol"],
  outputShape: "{ markdown, rationale }",
  instructions: `You correct a Markdown knowledge-base document whose listed claims could not be proven against its source material. Produce a corrected version of the WHOLE document.

Input:
- "path" and "content": the document under repair.
- "claims": the specific unprovable claims to fix, each with a reason.
- "sources": the source material to ground every correction in.

Rules:
- Return JSON only.
- For each listed claim: rewrite it so it matches what the sources actually support, quoting/paraphrasing only what the sources say. If NOTHING in the sources supports the claim, REMOVE it and smooth the surrounding prose.
- Never introduce a new assertion that the sources do not support. Do not invent figures, dates, or facts.
- Leave every other part of the document unchanged.
- "rationale" is a one-paragraph summary of what you changed and why.

Return JSON:
{
  "markdown": "the full corrected document",
  "rationale": "string"
}`
};
```

…and add `CORRECT_DOCUMENT,` to the `promptCatalog` array immediately after `VERIFY_DOCUMENT` (~line 278).

- [ ] **Step 9: Wire the watcher prompt + bump the API prompt count**

`apps/watcher/src/job-prompts.ts` — add `CORRECT_DOCUMENT` to the `@magpie/prompts` import (~line 6) and a case in `buildPrompt` after the `verify_document` case (~line 43):

```ts
    case "correct_document":
      return `${CORRECT_DOCUMENT.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
```

`apps/api/src/app.test.ts` — change `assert.equal(body.prompts.length, 13)` to `14` (~line 197).

- [ ] **Step 10: Run all touched package tests**

Run: `npm test -w @magpie/prompts && npm test -w @magpie/jobs && npm test -w @magpie/core`
Expected: PASS. (`@magpie/core` may have no tests — that is fine.)

- [ ] **Step 11: Commit**

```bash
git add packages/core packages/jobs packages/prompts apps/watcher/src/job-prompts.ts apps/api/src/app.test.ts
git commit -m "feat(jobs): add correct_document AI job contract + prompt"
```

---

### Task 2: First-class `Proposal.flowId`

Gives a proposal a flow identity independent of its gap cluster, so a clusterless verify proposal is seen as same-flow by the gate and drained by its flow's outbox. Gap proposals are unchanged.

**Files:**
- Modify: `packages/core/src/index.ts` (`Proposal` interface, ~line 223 next to `gapClusterId`)
- Modify: `apps/api/src/stores/proposal-store.ts` (`ProposalInput` ~line 4; `InMemoryProposalStore.create` ~line 42)
- Modify: `apps/api/src/stores/postgres-proposal-store.ts` (`create` INSERT ~line 19; `ProposalRow` ~line 145; `mapRow` ~line 164)
- Create: `packages/db/migrations/0029_proposal_flow_id.sql`
- Modify: `apps/api/src/scheduling/flow.ts` (`proposalFlowId` ~line 13)
- Modify: `apps/api/src/scheduling/gap-reconciler.ts` (`proposalFlowId` ~line 438)
- Test: `apps/api/src/stores/proposal-store.test.ts`; `apps/api/src/scheduling/flow.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Proposal.flowId?: string`; `ProposalInput.flowId?: string`; `proposalFlowId(p) === p.flowId` when set (both copies).

- [ ] **Step 1: Write the failing store test**

Append to `apps/api/src/stores/proposal-store.test.ts`:

```ts
test("create persists a first-class flowId", async () => {
  const store = new InMemoryProposalStore();
  const proposal = await store.create({
    title: "t",
    targetPath: "a.md",
    markdown: "# a",
    rationale: "r",
    evidence: [],
    flowId: "billing"
  });
  assert.equal(proposal.flowId, "billing");
  assert.equal((await store.get(proposal.id))?.flowId, "billing");
});
```

(Ensure the file imports `InMemoryProposalStore`, `test`, and `assert` — match the existing header.)

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="persists a first-class flowId"`
Expected: FAIL — `flowId` is not on `ProposalInput`/`Proposal` (typecheck error) or is `undefined` at runtime.

- [ ] **Step 3: Add `flowId` to the core type and the in-memory store**

`packages/core/src/index.ts` — in `Proposal`, after `gapClusterId?: string;` (~line 223):

```ts
  // The flow this proposal belongs to, independent of any gap cluster. Gap
  // proposals leave this unset and resolve their flow via the cluster; patrol-lens
  // proposals (verify, and later dedupe/split/complete) set it directly so the
  // reconcile gate sees them as same-flow and the per-flow outbox drains them.
  flowId?: string;
```

`apps/api/src/stores/proposal-store.ts` — add `flowId?: string;` to `ProposalInput` (~line 10), and in `InMemoryProposalStore.create` set `flowId: input.flowId,` in the constructed `proposal` object (after `gapClusterId: input.gapClusterId,`, ~line 55).

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="persists a first-class flowId"`
Expected: PASS.

- [ ] **Step 5: Persist `flow_id` in Postgres + migration**

Create `packages/db/migrations/0029_proposal_flow_id.sql`:

```sql
-- A proposal's flow, independent of its gap cluster. Gap proposals leave this null
-- and resolve their flow via the cluster (unchanged); patrol-lens proposals
-- (verify, and later dedupe/split/complete) set it directly so the reconcile gate
-- sees them as same-flow and the per-flow publication outbox drains them.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS flow_id text;
```

`apps/api/src/stores/postgres-proposal-store.ts` — in `create`:
- add `flow_id` to the column list (after `gap_cluster_id,` before `draft_context`),
- the VALUES tuple becomes `($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint, $12, $13)` (flow_id as `$13`, after `draft_context` `$12` — keep `draft_context` as `$12` and append `flow_id` last in BOTH the column list and VALUES; simplest: append `flow_id` after `draft_context` in the column list and `$13` at the end of VALUES),
- append `input.flowId ?? null` as the last element of the params array.

Add `flow_id: string | null;` to `ProposalRow` (~line 145, next to `gap_cluster_id`). Add `flowId: row.flow_id ?? undefined,` to `mapRow` (~line 164, next to `gapClusterId`).

- [ ] **Step 6: Write the failing flow-resolution test**

Create `apps/api/src/scheduling/flow.test.ts` (or append if it exists):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../test-support/context.js";
import { proposalFlowId } from "./flow.js";

test("proposalFlowId prefers a first-class flowId over the cluster lookup", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "t",
    targetPath: "a.md",
    markdown: "# a",
    rationale: "r",
    evidence: [],
    flowId: "billing"
  });
  assert.equal(await proposalFlowId(ctx, proposal), "billing");
});

test("proposalFlowId falls back to undefined when neither flowId nor cluster is set", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "t",
    targetPath: "a.md",
    markdown: "# a",
    rationale: "r",
    evidence: []
  });
  assert.equal(await proposalFlowId(ctx, proposal), undefined);
});
```

- [ ] **Step 7: Run it — verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="proposalFlowId"`
Expected: FAIL — the first test resolves `undefined` (cluster-only lookup ignores `flowId`).

- [ ] **Step 8: Generalise both `proposalFlowId` copies**

`apps/api/src/scheduling/flow.ts` (~line 13):

```ts
export async function proposalFlowId(ctx: AppContext, proposal: Proposal): Promise<string | undefined> {
  if (proposal.flowId) {
    return proposal.flowId;
  }
  if (!proposal.gapClusterId) {
    return undefined;
  }
  const cluster = await ctx.stores.gapClusters.getCluster(proposal.gapClusterId);
  return cluster?.flowId;
}
```

`apps/api/src/scheduling/gap-reconciler.ts` (the cached copy, ~line 442) — add the same first check at the top of the function body, before the `const clusterId = proposal.gapClusterId;` line:

```ts
  if (proposal.flowId) {
    return proposal.flowId;
  }
```

- [ ] **Step 9: Run it — verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="proposalFlowId|persists a first-class flowId"`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core packages/db/migrations apps/api/src/stores apps/api/src/scheduling/flow.ts apps/api/src/scheduling/gap-reconciler.ts apps/api/src/scheduling/flow.test.ts apps/api/src/stores/proposal-store.test.ts
git commit -m "feat(proposals): first-class Proposal.flowId for clusterless proposals"
```

---

### Task 3: `reconcileCorrectiveProposal`

The gate step for a corrective proposal: fold into an open same-flow PR, else publish as its own PR (open-new or defer-against-approved). Separate from `reconcileDraftedProposal` because gap's `open-new` deliberately no-ops (the cluster reconciler owns gap publication), whereas a clusterless verify proposal owns its own.

**Files:**
- Modify: `apps/api/src/scheduling/fold.ts` (new export `reconcileCorrectiveProposal`)
- Test: `apps/api/src/scheduling/fold.test.ts`

**Interfaces:**
- Consumes: `decideReconciliation`, `openPullRequestSummaries` (`./reconcile-gate.js`); `proposalFlowId`, `sameFlowOpenProposals` (`./flow.js`); `ctx.stores.gapClusters.enqueuePublicationAction`; `ctx.jobs.create("fold_markdown_proposal", …)`.
- Produces: `reconcileCorrectiveProposal(ctx: AppContext, proposal: Proposal): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/scheduling/fold.test.ts`. Add `reconcileCorrectiveProposal` to the `./fold.js` import. Use `describe`/`it` (the file imports `{ describe, it }` from `node:test`) and the job-inspection accessor the existing tests use: `(await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs`.

```ts
describe("reconcileCorrectiveProposal", () => {
  it("open-new (no overlap) enqueues a publish action", async () => {
    const ctx = makeTestContext();
    const proposal = await ctx.stores.proposals.create({
      title: "Verify: correct unprovable claims in a.md",
      targetPath: "a.md", markdown: "# a", rationale: "r", evidence: [], flowId: "billing"
    });
    await reconcileCorrectiveProposal(ctx, proposal);
    const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.deepEqual(actions.map((a) => ({ proposalId: a.proposalId, kind: a.kind })), [
      { proposalId: proposal.id, kind: "publish" }
    ]);
  });

  it("fold (overlapping touchable PR) enqueues a fold_markdown_proposal job, no publish", async () => {
    const ctx = makeTestContext();
    const survivor = await ctx.stores.proposals.create({
      title: "Gap doc", targetPath: "a.md", markdown: "# survivor", rationale: "r", evidence: [], flowId: "billing"
    });
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git", branchName: "b", commitSha: "c", pullRequestUrl: "http://pr/1", publishedAt: new Date().toISOString()
    });
    const rival = await ctx.stores.proposals.create({
      title: "Verify: correct unprovable claims in a.md",
      targetPath: "a.md", markdown: "# rival", rationale: "r", evidence: [], flowId: "billing"
    });
    await reconcileCorrectiveProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 1);
    assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcileCorrectiveProposal"`
Expected: FAIL — `reconcileCorrectiveProposal` is not exported.

- [ ] **Step 3: Implement `reconcileCorrectiveProposal`**

In `apps/api/src/scheduling/fold.ts`, add (the file already imports `decideReconciliation`, `openPullRequestSummaries`, `proposalFlowId`, `sameFlowOpenProposals`, `ChangeIntent`):

```ts
// Gate + publish a corrective (verify-lens) proposal. Unlike the gap at-draft hook,
// this OWNS publication: a clusterless patrol proposal is not published by the gap
// cluster reconciler, so open-new and defer both publish it as its own PR; only a
// touchable overlap folds. Best-effort — the caller (completeJob) guards throws.
export async function reconcileCorrectiveProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) {
    return;
  }
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const intent: ChangeIntent = {
    lens: "verify",
    flowId,
    targets: [proposal.targetPath],
    evidence: proposal.evidence.map((citation) => citation.path),
    rationale: proposal.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));

  if (decision.kind === "fold") {
    const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
    if (survivor) {
      await ctx.jobs.create("fold_markdown_proposal", {
        provider: ctx.config.get().aiProvider,
        survivorProposalId: survivor.id,
        rivalProposalId: proposal.id,
        targetPath: proposal.targetPath,
        survivorMarkdown: survivor.markdown,
        rivalMarkdown: proposal.markdown,
        rivalGapSummaries: [],
        rivalEvidence: proposal.evidence,
        expectedOutput: "folded_markdown"
      });
      console.log(`Verify fold: enqueued fold of corrective ${proposal.id} into ${survivor.id} on ${proposal.targetPath}.`);
      return;
    }
    // Survivor vanished between gate and fetch — fall through to self-publish.
  }

  // open-new, defer, or a fold whose survivor disappeared: publish as its own PR.
  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
  console.log(`Verify corrective ${proposal.id} (${decision.kind}) on ${proposal.targetPath}: enqueued to publish.`);
}
```

`MaintenanceLens` already includes `"verify"`; `lens` is cosmetic for `decideReconciliation` (only `targets` drive it).

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcileCorrectiveProposal"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/fold.ts apps/api/src/scheduling/fold.test.ts
git commit -m "feat(verify): reconcileCorrectiveProposal gates + publishes a corrective proposal"
```

---

### Task 4: `correct_document` completion handler + wire into `completeJob`

On a completed `correct_document` job, create a draft `Proposal` (carrying `flowId`, labelled for triage) and reconcile it. Idempotent on `jobId` (the store already de-dupes by `job_id`).

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts` (new `createCorrectiveProposalFromCompletedJob`; imports)
- Modify: `apps/api/src/features/jobs/service.ts` (`completeJob` sequence, ~line 157-166)
- Test: `apps/api/src/features/proposals/service.test.ts`

**Interfaces:**
- Consumes: `correctDocumentOutputSchema` (`@magpie/jobs`); `CorrectDocumentJobInput` (`@magpie/core`); `ctx.stores.proposals.create`; `foldService.reconcileCorrectiveProposal` (Task 3).
- Produces: `createCorrectiveProposalFromCompletedJob(ctx, job, output): Promise<Proposal | undefined>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/features/proposals/service.test.ts`:

```ts
test("createCorrectiveProposalFromCompletedJob creates a labelled draft carrying the flowId, idempotent on jobId", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("correct_document", {
    path: "a.md", content: "# a", claims: [{ claim: "stale", reason: "x" }],
    sources: [], destinationId: "docs", flowId: "billing", provider: "codex"
  });
  const output = { markdown: "# a (fixed)", rationale: "removed stale claim" };

  const first = await proposals.createCorrectiveProposalFromCompletedJob(ctx, job, output);
  assert.ok(first);
  assert.equal(first?.flowId, "billing");
  assert.equal(first?.targetPath, "a.md");
  assert.equal(first?.markdown, "# a (fixed)");
  assert.ok(first?.title.startsWith("Verify:"));

  // Re-delivery: same jobId → same proposal, no duplicate.
  const second = await proposals.createCorrectiveProposalFromCompletedJob(ctx, job, output);
  assert.equal(second?.id, first?.id);
  assert.equal((await proposals.list(ctx, 50)).length, 1);
});
```

(Ensure the test imports `* as proposals from "./service.js"` and `makeTestContext` — match the file header.)

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="createCorrectiveProposalFromCompletedJob"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement the handler**

In `apps/api/src/features/proposals/service.ts`, add `CorrectDocumentJobInput` to the `@magpie/core` import and `correctDocumentOutputSchema` to the `@magpie/jobs` import, then add:

```ts
// Completion handler for correct_document jobs: a verify-lens repair landed, so
// create a draft Proposal for it. flowId is carried first-class (Task 2) so the gate
// and outbox treat it as same-flow; the title is prefixed for PR-stream triage. The
// store de-dupes by jobId, so a re-delivered completion returns the same proposal.
export async function createCorrectiveProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "correct_document") {
    return undefined;
  }
  const parsed = correctDocumentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<CorrectDocumentJobInput>;
  if (!input.path) {
    return undefined;
  }
  return ctx.stores.proposals.create({
    title: `Verify: correct unprovable claims in ${input.path}`,
    targetPath: input.path,
    markdown: parsed.data.markdown,
    rationale: parsed.data.rationale,
    evidence: [],
    flowId: input.flowId,
    destinationId: input.destinationId,
    jobId: job.id
  });
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="createCorrectiveProposalFromCompletedJob"`
Expected: PASS.

- [ ] **Step 5: Wire into `completeJob`**

In `apps/api/src/features/jobs/service.ts`, in the `try` block after the existing drafted-proposal fold hook (after line 165, before `applyFoldFromCompletedJob`):

```ts
    const correctiveProposal = await proposalsService.createCorrectiveProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (correctiveProposal) {
      try {
        await foldService.reconcileCorrectiveProposal(ctx, correctiveProposal);
      } catch (error) {
        console.warn(`Corrective reconcile for proposal ${correctiveProposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
```

- [ ] **Step 6: Write + run the integration test for the wiring**

Append to `apps/api/src/features/jobs/service.test.ts` (match its imports — `completeJob`, `makeTestContext`):

```ts
test("completeJob on a correct_document job creates a corrective proposal and enqueues its publication", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("correct_document", {
    path: "a.md", content: "# a", claims: [{ claim: "stale", reason: "x" }],
    sources: [], destinationId: "docs", flowId: "billing", provider: "codex"
  });
  const result = await completeJob(ctx, job.id, { markdown: "# a (fixed)", rationale: "fixed" });
  assert.ok(result.ok);
  const proposal = (await ctx.stores.proposals.list(50)).find((p) => p.targetPath === "a.md");
  assert.ok(proposal);
  assert.equal(proposal?.flowId, "billing");
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.ok(actions.some((a) => a.proposalId === proposal?.id && a.kind === "publish"));
});
```

Run: `npm test -w @magpie/api -- --test-name-pattern="correct_document job creates a corrective proposal"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/features/proposals/service.ts apps/api/src/features/jobs/service.ts apps/api/src/features/proposals/service.test.ts apps/api/src/features/jobs/service.test.ts
git commit -m "feat(verify): create + reconcile a corrective proposal on correct_document completion"
```

---

### Task 5: fix-patrol enqueues the correction

`runFixPatrol` enqueues one `correct_document` per unprovable finding, via an injectable `correctDocument` dep mirroring `verifyDocument`. The verify lens stays pure detect-and-report.

**Files:**
- Modify: `apps/api/src/features/patrol/service.ts` (`CorrectDocumentFn`, `defaultCorrectDocument`, `runFixPatrol` deps + loop)
- Test: `apps/api/src/features/patrol/service.test.ts`

**Interfaces:**
- Consumes: `CorrectDocumentJobInput` (`@magpie/core`); `ctx.jobs.create("correct_document", …)`; `VerifyFinding` (already has `path`, `claims`).
- Produces: `CorrectDocumentFn` type; `runFixPatrol` now takes `deps: { verifyDocument?: VerifyDocumentFn; correctDocument?: CorrectDocumentFn }`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/features/patrol/service.test.ts`, add (import `CorrectDocumentFn` from `../../scheduling/verify-lens.js` if exported there, else from `./service.js` — see Step 3 for where it lives):

```ts
test("runFixPatrol enqueues a correction for each unprovable finding, none for healthy", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const verifyDocument: VerifyDocumentFn = async (_c, input) =>
    input.path === "a.md"
      ? { verdict: "unprovable", claims: [{ claim: "stale", reason: "no source" }] }
      : { verdict: "healthy", claims: [] };
  const corrected: Array<{ path: string; claims: number }> = [];
  const correctDocument: CorrectDocumentFn = async (_c, input) => {
    corrected.push({ path: input.path, claims: input.claims.length });
  };

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, { verifyDocument, correctDocument });
  assert.ok(outcome.ok);
  assert.deepEqual(corrected, [{ path: "a.md", claims: 1 }]);
});
```

Also update the existing `"runFixPatrol records verify findings for unprovable documents"` test to pass a noop `correctDocument` so it stays fully offline:

```ts
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, { verifyDocument, correctDocument: async () => {} });
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="enqueues a correction for each unprovable finding"`
Expected: FAIL — `correctDocument` is not part of `runFixPatrol`'s deps (typecheck) / never invoked.

- [ ] **Step 3: Implement the dep + loop**

In `apps/api/src/features/patrol/service.ts`:

Add `CorrectDocumentJobInput` to the `@magpie/core` import. Add the type + default near `defaultVerifyDocument` (~line 47):

```ts
// Runs the corrective repair for one document. The default enqueues a
// correct_document AI job (enqueue-only — the proposal lands later via the job
// completion machinery in completeJob); tests inject a spy/fake.
export type CorrectDocumentFn = (ctx: AppContext, input: CorrectDocumentJobInput) => Promise<void>;

const defaultCorrectDocument: CorrectDocumentFn = async (ctx, input) => {
  await ctx.jobs.create("correct_document", {
    path: input.path,
    content: input.content,
    claims: input.claims,
    sources: input.sources,
    destinationId: input.destinationId,
    flowId: input.flowId,
    provider: ctx.config.get().aiProvider
  } satisfies CorrectDocumentJobInput & { provider: AiProviderName });
};
```

Change `runFixPatrol`'s `deps` parameter (~line 72) to:

```ts
  deps: { verifyDocument?: VerifyDocumentFn; correctDocument?: CorrectDocumentFn } = {}
```

…and at the top of the body resolve both:

```ts
  const verifyDocument = deps.verifyDocument ?? defaultVerifyDocument;
  const correctDocument = deps.correctDocument ?? defaultCorrectDocument;
```

Update the `runVerifyLens` call to pass `verifyDocument` (the local). After `findings` is returned and before `createRun`, add the corrective loop:

```ts
  // Each unprovable finding becomes a corrective proposal: enqueue a correct_document
  // job grounded in the same source material the verify lens saw. Enqueue-only — the
  // proposal is drafted + gated later, on job completion.
  for (const finding of findings) {
    const document = documents.find((doc) => doc.path === finding.path);
    if (!document) {
      continue;
    }
    await correctDocument(ctx, {
      path: finding.path,
      content: document.content,
      claims: finding.claims,
      sources,
      destinationId: document.repositoryId,
      flowId: options.flowId
    });
  }
```

(`documents` is the scoped `KnowledgeDocument[]` already in scope — it carries `repositoryId` and `content`.)

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="enqueues a correction for each unprovable finding|records verify findings"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/patrol/service.ts apps/api/src/features/patrol/service.test.ts
git commit -m "feat(patrol): fix-patrol enqueues correct_document per unprovable finding"
```

---

### Task 6: Full-suite gates + branch finish

- [ ] **Step 1: Run the full API suite**

Run: `npm test -w @magpie/api`
Expected: PASS. Known unrelated local-only failures may appear: the Windows path-separator test in `apps/watcher/.../publication.test.ts` and a web test-glob quirk — these pass on CI Linux and are not caused by this change. Investigate any OTHER failure.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors across the workspace).

- [ ] **Step 3: Dead-code gate**

Run: `npm run deadcode`
Expected: PASS. If knip flags a new export as unused, confirm it is actually consumed (e.g. `CorrectDocumentFn` by the patrol service, `reconcileCorrectiveProposal` by `completeJob`); if genuinely unused, de-export it — never relax the knip config.

- [ ] **Step 4: Whole-repo test run**

Run: `npm test`
Expected: PASS (modulo the two known local-only failures above).

- [ ] **Step 5: Finishing the branch**

Use the superpowers:finishing-a-development-branch skill to open a PR off `main` (never direct-to-main). PR title: `feat: verify → corrective PR (fix-patrol)`. Summarise: the `correct_document` job, first-class `Proposal.flowId` (migration 0029), the corrective completion handler + `reconcileCorrectiveProposal`, and the fix-patrol enqueue.

---

## Self-Review

**Spec coverage:**
- §2 `Proposal.flowId` → Task 2. ✓
- §3 `correct_document` job (repair-or-remove, registration chores) → Task 1. ✓
- §4 fix-patrol enqueues per unprovable finding, injectable dep, lens stays pure → Task 5. ✓ (`decision` stays a preview — `runVerifyLens` unchanged.)
- §5 completion handler → draft proposal (idempotent on jobId) → reconcile (fold/defer/open-new) → publish via outbox → Tasks 3 + 4. ✓
- §6 labelling → Task 4 (title prefix `Verify:`; PR title becomes `docs: Verify: …`, branch name derives from it). Body-marker beyond the title is not separately built API-side, so the title prefix is the triage lever; richer body labelling would touch the watcher and is out of scope. ✓
- §7 error handling: malformed/failed correction → no proposal, finding stands (Task 4 returns undefined on parse failure; enqueue-only means a never-completing job just never drafts). Idempotency on jobId (Task 4 test). Fold guard rails reused (Task 3 via `decideReconciliation`/touchable). ✓
- §8 testing — every listed test maps to a step. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the code; commands have expected output. The one soft spot — the exact job-inspection accessor in `fold.test.ts`/`service.test.ts` (`ctx.jobs.list`) — is called out with the behavioural contract to assert if the accessor differs.

**Type consistency:** `correct_document` / `correctDocumentInputSchema` / `correctDocumentOutputSchema` / `CorrectDocumentJobInput` / `CorrectDocumentJobOutput` / `CorrectDocumentFn` / `reconcileCorrectiveProposal` / `createCorrectiveProposalFromCompletedJob` are used identically across tasks. `Proposal.flowId` and `ProposalInput.flowId` match. The fold-job input fields match the existing `fold_markdown_proposal` contract (`survivorProposalId`, `rivalProposalId`, `survivorMarkdown`, `rivalMarkdown`, `rivalGapSummaries`, `rivalEvidence`, `expectedOutput: "folded_markdown"`).
