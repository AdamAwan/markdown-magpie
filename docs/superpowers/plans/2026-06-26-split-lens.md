# Split Lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `split` fix-patrol lens: detect overgrown documents, inspect a bounded neighbourhood, and publish/fold a changeset Proposal that reorganises the file-set.

**Architecture:** Reuse the dedupe changeset spine. Add a provider AI job (`split_document`), a split-specific neighbour lookup, an enqueue-only split lens in fix-patrol, a clusterless Proposal completion handler, and a `reconcileSplitProposal` gate wrapper that uses the existing `fold_changeset_proposal` path.

**Tech Stack:** TypeScript ESM monorepo; node:test; Zod job contracts; `@magpie/core`, `@magpie/jobs`, `@magpie/prompts`, `@magpie/api`, `@magpie/watcher`; existing `Proposal.changeset` publication/fold infrastructure.

---

## File Structure

- `packages/core/src/index.ts`: add `SplitDocumentJobInput` and `SplitDocumentJobOutput`.
- `packages/jobs/src/types.ts`: add `split_document` to `JOB_TYPES`.
- `packages/jobs/src/schemas.ts`: add `splitDocumentInputSchema` and `splitDocumentOutputSchema`.
- `packages/jobs/src/catalog.ts`: register `split_document` as provider-routed AI work.
- `packages/jobs/src/catalog.test.ts`, `packages/jobs/src/schemas.test.ts`: contract and routing tests.
- `packages/prompts/src/catalog.ts`: add `SPLIT_DOCUMENT` prompt after `DEDUPE_DOCUMENTS`.
- `packages/prompts/src/catalog.test.ts`: prompt count/order update.
- `apps/watcher/src/job-prompts.ts`, `apps/watcher/src/job-prompts.test.ts`: route `split_document` to the prompt.
- `apps/api/src/scheduling/split-neighbours.ts`: split-specific neighbour retrieval.
- `apps/api/src/scheduling/split-neighbours.test.ts`: threshold/cap/self-exclusion tests.
- `apps/api/src/scheduling/split-lens.ts`: pre-filter and enqueue split scans.
- `apps/api/src/scheduling/split-lens.test.ts`: pre-filter/enqueue/failure tests.
- `apps/api/src/features/patrol/service.ts`, `apps/api/src/features/patrol/service.test.ts`: run split over the selected batch.
- `apps/api/src/features/proposals/service.ts`, `apps/api/src/features/proposals/service.test.ts`: draft split changeset Proposal from completed jobs.
- `apps/api/src/scheduling/fold.ts`, `apps/api/src/scheduling/fold.test.ts`: reconcile split Proposal through the gate.
- `apps/api/src/features/jobs/service.ts`, `apps/api/src/features/jobs/service.test.ts`: completion dispatcher creates and gates split Proposals.
- `apps/api/src/app.test.ts`: prompt count increments.

---

### Task 1: `split_document` Job Contract and Prompt

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/jobs/src/types.ts`
- Modify: `packages/jobs/src/schemas.ts`
- Modify: `packages/jobs/src/catalog.ts`
- Modify: `packages/jobs/src/catalog.test.ts`
- Modify: `packages/jobs/src/schemas.test.ts`
- Modify: `packages/prompts/src/catalog.ts`
- Modify: `packages/prompts/src/catalog.test.ts`
- Modify: `apps/watcher/src/job-prompts.ts`
- Modify: `apps/watcher/src/job-prompts.test.ts`
- Modify: `apps/api/src/app.test.ts`

- [ ] **Step 1: Write failing job schema tests**

Add to `packages/jobs/src/schemas.test.ts` imports:

```ts
  splitDocumentInputSchema,
  splitDocumentOutputSchema,
```

Add the test:

```ts
test("split_document schemas round-trip a bounded changeset", () => {
  assert.ok(
    splitDocumentInputSchema.safeParse({
      provider: "codex",
      path: "kb/refunds.md",
      content: "# Refunds",
      neighbours: [{ path: "kb/refund-operations.md", content: "# Refund operations" }],
      destinationId: "docs",
      flowId: "billing"
    }).success
  );
  assert.ok(
    splitDocumentOutputSchema.safeParse({
      split: true,
      rationale: "separated policy from operations",
      primaryPath: "kb/refunds.md",
      changeset: [
        { path: "kb/refunds.md", content: "# Refunds\nSee refund-operations.md." },
        { path: "kb/refund-operations.md", content: "# Refund operations\nMoved detail." }
      ]
    }).success
  );
  assert.ok(splitDocumentOutputSchema.safeParse({ split: false, rationale: "already focused", changeset: [] }).success);
});
```

- [ ] **Step 2: Verify the schema test fails**

Run:

```bash
npm test -w @magpie/jobs -- --test-name-pattern split_document
```

Expected: FAIL because `splitDocumentInputSchema` and `splitDocumentOutputSchema` are not exported.

- [ ] **Step 3: Implement core types and schemas**

Add to `packages/core/src/index.ts` after `DedupeDocumentsJobOutput`:

```ts
export interface SplitDocumentJobInput {
  path: string;
  content: string;
  neighbours: Array<{ path: string; content: string }>;
  destinationId?: string;
  flowId?: string;
}

export interface SplitDocumentJobOutput {
  split: boolean;
  rationale: string;
  primaryPath?: string;
  changeset?: ChangesetChange[];
}
```

Add to `packages/jobs/src/schemas.ts` imports:

```ts
  SplitDocumentJobInput as CoreSplitDocumentJobInput,
  SplitDocumentJobOutput,
```

Add after `dedupeDocumentsOutputSchema`:

```ts
export const splitDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  neighbours: z.array(z.object({ path: z.string(), content: z.string() })),
  destinationId: z.string().optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreSplitDocumentJobInput>>;
export const splitDocumentOutputSchema = z.object({
  split: z.boolean(),
  rationale: z.string(),
  primaryPath: z.string().optional(),
  changeset: z.array(changesetChangeSchema).optional()
}) satisfies z.ZodType<SplitDocumentJobOutput>;
```

- [ ] **Step 4: Verify schema test passes**

Run:

```bash
npm test -w @magpie/jobs -- --test-name-pattern split_document
```

Expected: PASS for the schema test.

- [ ] **Step 5: Write failing catalog/prompt/router tests**

In `packages/jobs/src/catalog.test.ts`, add `split_document: 10 * 60` to `EXPIRATION_SECONDS` and add:

```ts
test("split_document routes by provider like other AI work", () => {
  const definition = jobDefinition("split_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("split_document", { provider: "codex" }), "split_document__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("split_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("split_document__codex"));
});
```

In `packages/prompts/src/catalog.test.ts`, change prompt count from `16` to `17` and insert `"split-document"` after `"dedupe-documents"`.

In `apps/watcher/src/job-prompts.test.ts`, add:

```ts
  it("uses the split-document instructions for a split_document job", () => {
    const prompt = buildPrompt(job("split_document", { path: "kb/a.md", content: "# A", neighbours: [] }));
    assert.match(prompt, /outgrown a single responsibility/);
    assert.match(prompt, /"neighbours"/);
  });
```

In `apps/api/src/app.test.ts`, change `/api/prompts` count from `16` to `17`.

- [ ] **Step 6: Verify catalog/prompt/router tests fail**

Run:

```bash
npm test -w @magpie/jobs -- --test-name-pattern split_document
npm test -w @magpie/prompts
npm test -w @magpie/watcher -- --test-name-pattern split-document
npm test -w @magpie/api -- --test-name-pattern "GET /api/prompts"
```

Expected: FAIL because the job type, prompt, router case, and API prompt count are not implemented.

- [ ] **Step 7: Implement job catalog and prompt routing**

In `packages/jobs/src/types.ts`, insert `"split_document"` after `"dedupe_documents"`.

In `packages/jobs/src/catalog.ts`, add:

```ts
  split_document: define("split_document", "provider", schemas.splitDocumentInputSchema, schemas.splitDocumentOutputSchema, 10 * 60),
```

and add `"split_document"` to `aiJobTypes`.

In `packages/prompts/src/catalog.ts`, add `SPLIT_DOCUMENT` after `DEDUPE_DOCUMENTS`:

```ts
export const SPLIT_DOCUMENT: PromptDefinition = {
  id: "split-document",
  title: "Split an overgrown document",
  description:
    "Given one knowledge-base document that may have outgrown its responsibility, decides whether to split it into a parent plus new or existing focused documents. Conservative: silent when the document is already cohesive. Used by the watcher's split_document job (fix-patrol).",
  usedBy: ["watcher - fix-patrol"],
  outputShape: "{ split, rationale, primaryPath, changeset[] }",
  instructions: `You are tidying a Markdown knowledge base. You are given one document under review ("path"/"content") and possible existing homes ("neighbours"). Decide whether the document has genuinely outgrown a single responsibility and should be split into a smaller parent plus one or more focused documents.

Rules:
- Return JSON only.
- Be conservative. Only act when the document clearly contains independent responsibilities. Long but cohesive documents should return {"split": false, "rationale": "...", "changeset": []}.
- When splitting, keep "primaryPath" equal to the original input path and include a full write for that path in "changeset".
- The parent document should keep the overview, shared context, and links to the focused documents.
- Prefer moving detail into an existing neighbour when that neighbour is the right home. Create a new document only when no supplied neighbour fits.
- Existing touched paths MUST be either the input path or one of the supplied neighbour paths. New paths are allowed for new documents only.
- You may delete a touched existing document only when your split makes it genuinely redundant or effectively empty.
- Preserve all existing information. Do not introduce facts not present in the input documents.
- "rationale" is a one-paragraph summary of why the split is warranted.

Return JSON:
{
  "split": true,
  "rationale": "string",
  "primaryPath": "existing/parent.md",
  "changeset": [
    { "path": "existing/parent.md", "content": "full rewritten parent document" },
    { "path": "existing/focused-doc.md", "content": "full focused document" }
  ]
}`
};
```

Add `SPLIT_DOCUMENT` to `promptCatalog` after `DEDUPE_DOCUMENTS`.

In `apps/watcher/src/job-prompts.ts`, import `SPLIT_DOCUMENT` and add:

```ts
    case "split_document":
      return `${SPLIT_DOCUMENT.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
```

- [ ] **Step 8: Verify contract layer passes**

Run:

```bash
npm test -w @magpie/jobs
npm test -w @magpie/prompts
npm test -w @magpie/watcher -- --test-name-pattern "buildPrompt|split-document"
npm test -w @magpie/api -- --test-name-pattern "GET /api/prompts"
```

Expected: PASS.

- [ ] **Step 9: Commit contract layer**

Run:

```bash
git add packages/core/src/index.ts packages/jobs/src/types.ts packages/jobs/src/schemas.ts packages/jobs/src/catalog.ts packages/jobs/src/catalog.test.ts packages/jobs/src/schemas.test.ts packages/prompts/src/catalog.ts packages/prompts/src/catalog.test.ts apps/watcher/src/job-prompts.ts apps/watcher/src/job-prompts.test.ts apps/api/src/app.test.ts
git commit -m "feat(jobs): add split_document contract"
```

---

### Task 2: Split Neighbours and Split Lens

**Files:**
- Create: `apps/api/src/scheduling/split-neighbours.ts`
- Create: `apps/api/src/scheduling/split-neighbours.test.ts`
- Create: `apps/api/src/scheduling/split-lens.ts`
- Create: `apps/api/src/scheduling/split-lens.test.ts`

- [ ] **Step 1: Write failing split-neighbour tests**

Create `apps/api/src/scheduling/split-neighbours.test.ts` with tests that mirror `dedupe-neighbours.test.ts` but assert threshold `0.55`, cap `5`, self-exclusion, and best section score per document.

Use this core assertion in the threshold test:

```ts
assert.deepEqual(neighbours.map((n) => n.path), ["kb/ops.md"]);
```

where `kb/ops.md` has relevance `0.56` and `kb/low.md` has relevance `0.54`.

- [ ] **Step 2: Verify split-neighbour tests fail**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern splitNeighbours
```

Expected: FAIL because `split-neighbours.ts` does not exist.

- [ ] **Step 3: Implement split-neighbours**

Create `apps/api/src/scheduling/split-neighbours.ts`:

```ts
import type { AppContext } from "../context.js";

const SPLIT_SIMILARITY_THRESHOLD = 0.55;
const SPLIT_MAX_NEIGHBOURS = 5;

export async function splitNeighbours(
  ctx: AppContext,
  doc: { path: string; content: string },
  repositoryIds: string[] | undefined
): Promise<Array<{ path: string; content: string }>> {
  const ranked = await ctx.stores.knowledgeIndex.search(doc.content, SPLIT_MAX_NEIGHBOURS * 4, repositoryIds);
  const bestByPath = new Map<string, number>();
  for (const { section, relevance } of ranked) {
    if (section.path === doc.path) continue;
    const previous = bestByPath.get(section.path);
    if (previous === undefined || relevance > previous) bestByPath.set(section.path, relevance);
  }
  const contentByPath = new Map(ctx.stores.knowledgeIndex.listDocuments().map((document) => [document.path, document.content]));
  return [...bestByPath.entries()]
    .filter(([, score]) => score >= SPLIT_SIMILARITY_THRESHOLD)
    .sort((left, right) => right[1] - left[1])
    .slice(0, SPLIT_MAX_NEIGHBOURS)
    .map(([path]) => ({ path, content: contentByPath.get(path) }))
    .filter((neighbour): neighbour is { path: string; content: string } => neighbour.content !== undefined);
}
```

- [ ] **Step 4: Verify split-neighbour tests pass**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern splitNeighbours
```

Expected: PASS.

- [ ] **Step 5: Write failing split-lens tests**

Create `apps/api/src/scheduling/split-lens.test.ts` with:

```ts
test("enqueues split_document only for structurally broad documents", async () => {
  const calls: SplitDocumentJobInput[] = [];
  const enqueued = await runSplitLens(ctx, {
    flowId: "billing",
    documents: [
      { path: "kb/small.md", content: "# Small\n\n## One\nFocused.", repositoryId: "docs" },
      { path: "kb/broad.md", content: "# Broad\n\n" + ["A", "B", "C", "D", "E", "F"].map((h) => `## ${h}\nBody`).join("\n"), repositoryId: "docs" }
    ],
    repositoryIds: ["docs"],
    splitDocument: async (_ctx, input) => calls.push(input)
  });
  assert.equal(enqueued, 1);
  assert.equal(calls[0].path, "kb/broad.md");
  assert.equal(calls[0].flowId, "billing");
  assert.equal(calls[0].destinationId, "docs");
});
```

Also add a test that a document with `content.length > 15_000` qualifies, and a test that one failing enqueue does not abort the next qualifying document.

- [ ] **Step 6: Verify split-lens tests fail**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern "split lens|runSplitLens"
```

Expected: FAIL because `split-lens.ts` does not exist.

- [ ] **Step 7: Implement split lens**

Create `apps/api/src/scheduling/split-lens.ts`:

```ts
import type { SplitDocumentJobInput } from "@magpie/core";
import type { AppContext } from "../context.js";
import { splitNeighbours } from "./split-neighbours.js";

const SPLIT_MIN_CHARS = 15_000;
const SPLIT_MIN_H2_COUNT = 6;

export type SplitDocumentFn = (ctx: AppContext, input: SplitDocumentJobInput) => Promise<void>;

export function qualifiesForSplitScan(content: string): boolean {
  const h2Count = content.split(/\r?\n/).filter((line) => /^##\s+\S/.test(line)).length;
  return content.length > SPLIT_MIN_CHARS || h2Count >= SPLIT_MIN_H2_COUNT;
}

export async function runSplitLens(
  ctx: AppContext,
  input: {
    flowId: string | undefined;
    documents: Array<{ path: string; content: string; repositoryId: string }>;
    repositoryIds: string[] | undefined;
    splitDocument: SplitDocumentFn;
  }
): Promise<number> {
  let enqueued = 0;
  for (const document of input.documents) {
    if (!qualifiesForSplitScan(document.content)) continue;
    try {
      const neighbours = await splitNeighbours(ctx, { path: document.path, content: document.content }, input.repositoryIds);
      await input.splitDocument(ctx, {
        path: document.path,
        content: document.content,
        neighbours,
        destinationId: document.repositoryId,
        flowId: input.flowId
      });
      enqueued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "split failed";
      console.warn(`Split lens: skipping ${document.path} - ${message}.`);
    }
  }
  return enqueued;
}
```

- [ ] **Step 8: Verify split-lens tests pass**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern "split lens|runSplitLens|qualifiesForSplitScan"
```

Expected: PASS.

- [ ] **Step 9: Commit split lens**

Run:

```bash
git add apps/api/src/scheduling/split-neighbours.ts apps/api/src/scheduling/split-neighbours.test.ts apps/api/src/scheduling/split-lens.ts apps/api/src/scheduling/split-lens.test.ts
git commit -m "feat(patrol): add split lens scanner"
```

---

### Task 3: Wire Split Lens into Fix Patrol

**Files:**
- Modify: `apps/api/src/features/patrol/service.ts`
- Modify: `apps/api/src/features/patrol/service.test.ts`

- [ ] **Step 1: Write failing patrol wiring test**

In `apps/api/src/features/patrol/service.test.ts`, import `SplitDocumentFn` and `SplitDocumentJobInput`, extend `HEALTHY_DEPS` with `splitDocument: async () => {}`, and add:

```ts
test("runFixPatrol runs the split lens over the batch for structurally broad docs", async () => {
  const ctx = makeTestContext();
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: [
      {
        path: "big.md",
        content: "# Big\n\n" + ["A", "B", "C", "D", "E", "F"].map((h) => `## ${h}\nBody`).join("\n")
      },
      { path: "small.md", content: "# Small\n\n## One\nBody" }
    ]
  });
  const scanned: SplitDocumentJobInput[] = [];
  const splitDocument: SplitDocumentFn = async (_ctx, input) => {
    scanned.push(input);
  };
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, {
    verifyDocument: async () => ({ verdict: "healthy", claims: [] }),
    dedupeDocument: async () => {},
    splitDocument
  });
  assert.ok(outcome.ok);
  assert.deepEqual(scanned.map((s) => s.path), ["big.md"]);
});
```

- [ ] **Step 2: Verify patrol test fails**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern "split lens over the batch"
```

Expected: FAIL because `runFixPatrol` does not accept or call `splitDocument`.

- [ ] **Step 3: Implement patrol wiring**

In `apps/api/src/features/patrol/service.ts`:

- Import `SplitDocumentJobInput`, `runSplitLens`, and `SplitDocumentFn`.
- Add default enqueue:

```ts
const defaultSplitDocument: SplitDocumentFn = async (ctx, input) => {
  await ctx.jobs.create("split_document", {
    path: input.path,
    content: input.content,
    neighbours: input.neighbours,
    destinationId: input.destinationId,
    flowId: input.flowId,
    provider: ctx.config.get().aiProvider
  } satisfies SplitDocumentJobInput & { provider: AiProviderName });
};
```

- Add `splitDocument?: SplitDocumentFn` to deps.
- Resolve `const splitDocument = deps.splitDocument ?? defaultSplitDocument;`.
- After `runDedupeLens`, call `runSplitLens` over the same selected docs.
- Extend the log with `${splitScans} split scan(s) enqueued`.

- [ ] **Step 4: Verify patrol tests pass**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern "runFixPatrol"
```

Expected: PASS.

- [ ] **Step 5: Commit patrol wiring**

Run:

```bash
git add apps/api/src/features/patrol/service.ts apps/api/src/features/patrol/service.test.ts
git commit -m "feat(patrol): run split lens in fix patrol"
```

---

### Task 4: Split Proposal Completion and Reconciliation

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts`
- Modify: `apps/api/src/features/proposals/service.test.ts`
- Modify: `apps/api/src/scheduling/fold.ts`
- Modify: `apps/api/src/scheduling/fold.test.ts`
- Modify: `apps/api/src/features/jobs/service.ts`
- Modify: `apps/api/src/features/jobs/service.test.ts`

- [ ] **Step 1: Write failing proposal completion tests**

In `apps/api/src/features/proposals/service.test.ts`, add a `splitJob(ctx)` helper that creates `split_document` with `path`, `content`, `neighbours`, `destinationId`, `flowId`, and `provider`.

Add tests:

```ts
test("createSplitProposalFromCompletedJob drafts a file-set proposal carrying the changeset and flowId", async () => {
  const ctx = makeTestContext();
  const job = await splitJob(ctx);
  const changeset = [
    { path: "kb/refunds.md", content: "# Refunds\nOverview" },
    { path: "kb/refund-operations.md", content: "# Refund operations\nMoved detail" }
  ];
  const first = await proposals.createSplitProposalFromCompletedJob(ctx, job, {
    split: true,
    rationale: "split responsibilities",
    primaryPath: "kb/refunds.md",
    changeset
  });
  assert.ok(first);
  assert.equal(first?.flowId, "billing");
  assert.equal(first?.targetPath, "kb/refunds.md");
  assert.equal(first?.markdown, "# Refunds\nOverview");
  assert.deepEqual(first?.changeset, changeset);
  assert.ok(first?.title.startsWith("Split:"));
  const second = await proposals.createSplitProposalFromCompletedJob(ctx, job, {
    split: true,
    rationale: "split responsibilities",
    primaryPath: "kb/refunds.md",
    changeset
  });
  assert.equal(second?.id, first?.id);
});
```

Also test `split:false`, missing primary write, `primaryPath` not equal to input path, and existing touched path outside `{input.path} + neighbours`.

- [ ] **Step 2: Verify proposal completion tests fail**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern createSplitProposalFromCompletedJob
```

Expected: FAIL because the function does not exist.

- [ ] **Step 3: Implement split proposal completion**

In `apps/api/src/features/proposals/service.ts`, import `SplitDocumentJobInput` and `splitDocumentOutputSchema`, then add:

```ts
export async function createSplitProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "split_document") return undefined;
  const parsed = splitDocumentOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const { split, changeset, primaryPath, rationale } = parsed.data;
  if (!split || !changeset || !primaryPath) return undefined;
  const input = job.input as Partial<SplitDocumentJobInput>;
  if (!input.path || primaryPath !== input.path) return undefined;
  const primaryWrite = changeset.find((change) => change.path === primaryPath);
  if (!primaryWrite || primaryWrite.content === undefined) return undefined;
  const existingPaths = new Set([input.path, ...(input.neighbours ?? []).map((neighbour) => neighbour.path)]);
  for (const change of changeset) {
    if (existingPaths.has(change.path)) continue;
    if (change.delete) return undefined;
    if (change.content === undefined) return undefined;
  }
  return ctx.stores.proposals.create({
    title: `Split: reorganise ${primaryPath}`,
    targetPath: primaryPath,
    markdown: primaryWrite.content,
    changeset,
    rationale,
    evidence: [],
    flowId: input.flowId,
    destinationId: input.destinationId,
    jobId: job.id
  });
}
```

- [ ] **Step 4: Verify proposal completion tests pass**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern createSplitProposalFromCompletedJob
```

Expected: PASS.

- [ ] **Step 5: Write failing fold and dispatcher tests**

In `apps/api/src/scheduling/fold.test.ts`, add `reconcileSplitProposal` tests matching dedupe:

- no overlap -> pending publish action
- touchable overlap on any changeset path -> `fold_changeset_proposal`
- approved-only overlap -> self-publish

In `apps/api/src/features/jobs/service.test.ts`, add a `split_document` completion test asserting the Proposal is created and a publish action is enqueued for open-new.

- [ ] **Step 6: Verify fold and dispatcher tests fail**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern "reconcileSplitProposal|split_document completion"
```

Expected: FAIL because `reconcileSplitProposal` and dispatcher wiring are missing.

- [ ] **Step 7: Implement split reconcile and dispatcher wiring**

In `apps/api/src/scheduling/fold.ts`, add:

```ts
export async function reconcileSplitProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) return;
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const targets = proposalTargets(proposal);
  const intent: ChangeIntent = {
    lens: "split",
    flowId,
    targets,
    evidence: proposal.evidence.map((citation) => citation.path),
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
      console.log(`Split fold: enqueued fold of ${proposal.id} into ${survivor.id} on [${targets.join(", ")}].`);
      return;
    }
  }
  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
  console.log(`Split ${proposal.id} (${decision.kind}) on [${targets.join(", ")}]: enqueued to publish.`);
}
```

In `apps/api/src/features/jobs/service.ts`, after the dedupe block, add:

```ts
    const splitProposal = await proposalsService.createSplitProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (splitProposal) {
      try {
        await foldService.reconcileSplitProposal(ctx, splitProposal);
      } catch (error) {
        console.warn(`Split reconcile for proposal ${splitProposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
```

- [ ] **Step 8: Verify split completion and reconcile tests pass**

Run:

```bash
npm test -w @magpie/api -- --test-name-pattern "createSplitProposalFromCompletedJob|reconcileSplitProposal|split_document completion"
```

Expected: PASS.

- [ ] **Step 9: Commit proposal/reconcile wiring**

Run:

```bash
git add apps/api/src/features/proposals/service.ts apps/api/src/features/proposals/service.test.ts apps/api/src/scheduling/fold.ts apps/api/src/scheduling/fold.test.ts apps/api/src/features/jobs/service.ts apps/api/src/features/jobs/service.test.ts
git commit -m "feat(split): draft and reconcile split proposals"
```

---

### Task 5: Final Verification and PR

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run focused workspace tests**

Run:

```bash
npm test -w @magpie/jobs
npm test -w @magpie/prompts
npm test -w @magpie/watcher
npm test -w @magpie/api
```

Expected: PASS. Known local-only Windows watcher publication path-separator failure may appear; if it does, record it and continue only if unrelated to split changes.

- [ ] **Step 2: Run pre-PR gates**

Run:

```bash
npm test
npm run typecheck
npm run deadcode
```

Expected: PASS except for the known local-only Windows watcher publication path-separator test if it appears during `npm test`.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git log --oneline --decorate -5
git diff origin/main...HEAD --stat
```

Expected: only split-lens commits on `codex/split-lens`.

- [ ] **Step 4: Use finishing-a-development-branch**

Announce:

```text
I'm using the finishing-a-development-branch skill to complete this work.
```

Then follow the skill. Since the user already requested a PR, choose the push-and-PR path after verifying tests.
