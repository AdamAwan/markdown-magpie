# Flow seeding (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A direct authoring path for a flow — given a list of *seed items* (each ≈ one
document, described by a title + coverage points), draft each straight into a proposal and
publish it as a PR through the shared reconcile gate, with **no** gap clustering, **no**
intent inference, and **no** cron wait. Serves cold starts and adding a new area to an
existing flow alike.

**Architecture:** A new `draft_seed_document` AI job authors one doc per seed item. A
`seedFlow` service enqueues one job per item (reusing flow/source resolution, skipping the
gap-candidate lookup that blocks `draftFromGaps`). On completion a clusterless `Proposal`
carrying a first-class `flowId` is created and reconciled through a shared
`reconcileClusterlessProposal` (extracted from `reconcileCorrectiveProposal`), publishing via
the existing per-flow outbox. A `POST /flows/:id/seed` endpoint and a `kb.seed` MCP tool are
the trigger surfaces. Reuses the corrective-PR machinery end-to-end; no new migration
(`Proposal.flowId` already exists). See
[`../specs/2026-07-03-flow-seeding-design.md`](../specs/2026-07-03-flow-seeding-design.md).

**Tech Stack:** TypeScript (Node ESM), Zod schemas, Postgres + in-memory stores, pg-boss
queue, Hono, `node:test`.

## Global Constraints

- UK English in all prose/comments/copy.
- Never process `/sites/CustomerData/` SharePoint content (Rosetta is the allowed exception).
- Workspace tests run via `npm test -w @magpie/<pkg>` — never root-cwd `node --test` (resolves `@magpie/*` to stale dist).
- Pre-PR gates: `npm test` + `npm run typecheck` + `npm run deadcode` (knip STRICT — fix unused exports by de-exporting, never relax the config).
- **Never cast through `unknown`/`any`** to silence types; fix them properly.
- **No new inline chat/generative provider calls in the API** — all generative work is a job. (Seeding is enqueue-only; the watcher runs the model.)
- New AI job type checklist: add to `JOB_TYPES` (types.ts), a `define(...)` entry + the `aiJobTypes` set (catalog.ts), `EXPIRATION_SECONDS` + a routing test (catalog.test.ts), input/output zod schemas (schemas.ts), core types (core/index.ts), a watcher `buildPrompt` case (job-prompts.ts).
- New prompt checklist: add to `promptCatalog` (prompts/catalog.ts), bump the count (**17→18**) and order array in prompts/catalog.test.ts, and bump the `/api/prompts` count (**17→18**) in apps/api/src/app.test.ts.
- **No migration needed** — seeding reuses `Proposal.flowId` (added for the corrective PR). If you find a genuine schema need, the next number is **0038**.
- Enqueue-only completion-side work: nothing in the seed request blocks on the model.

---

### Task 1: `draft_seed_document` job contract + prompt (additive, no behaviour)

Adds the job type, schemas, core types, catalog entry, prompt, and watcher prompt case. Pure
additive — nothing calls it yet. Deliverable: the contract exists and every count/routing
test passes.

**Files:**
- Modify: `packages/core/src/index.ts` (new `SeedItem`, `DraftSeedDocumentJobInput`, `DraftSeedDocumentJobOutput`, near the drafting types ~`DraftMarkdownProposalJobInput`)
- Modify: `packages/jobs/src/schemas.ts` (new `draftSeedDocumentInputSchema` / `draftSeedDocumentOutputSchema`, next to `draftMarkdownProposal*`; imports)
- Modify: `packages/jobs/src/types.ts` (`JOB_TYPES`, add `"draft_seed_document"` after `"draft_markdown_proposal"`)
- Modify: `packages/jobs/src/catalog.ts` (`definitions` + `aiJobTypes`)
- Modify: `packages/jobs/src/catalog.test.ts` (`EXPIRATION_SECONDS` + routing test)
- Modify: `packages/prompts/src/catalog.ts` (new `DRAFT_SEED_DOCUMENT` + `promptCatalog`)
- Modify: `packages/prompts/src/catalog.test.ts` (count 17→18 + order)
- Modify: `apps/api/src/app.test.ts` (`/api/prompts` count 17→18)
- Modify: `apps/watcher/src/job-prompts.ts` (import + `buildPrompt` case)

**Interfaces:**
- Produces: `SeedItem { title?; targetPath?; coverage: string[]; questions?: string[] }`;
  `DraftSeedDocumentJobInput { flowId: string; title?: string; targetPath?: string; coverage: string[]; questions?: string[]; sourceContext: SourceDataContext[]; destinationId?: string }`;
  `DraftSeedDocumentJobOutput { title: string; targetPath: string; markdown: string; rationale: string }`;
  schemas `draftSeedDocumentInputSchema` / `draftSeedDocumentOutputSchema`; job type `"draft_seed_document"`; prompt `DRAFT_SEED_DOCUMENT`.

- [ ] **Step 1: Add the routing test (failing)**

In `packages/jobs/src/catalog.test.ts`, add `draft_seed_document: 15 * 60,` to `EXPIRATION_SECONDS` (after the `draft_markdown_proposal` line). Then add, after the `draft_markdown_proposal routes…` test:

```ts
test("draft_seed_document routes by provider like other AI work", () => {
  const definition = jobDefinition("draft_seed_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("draft_seed_document", { provider: "codex" }), "draft_seed_document__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("draft_seed_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("draft_seed_document__codex"));
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -w @magpie/jobs`
Expected: FAIL — `"draft_seed_document"` is not a `JobType`, and the `every job type…` test fails on the missing `EXPIRATION_SECONDS` lookup.

- [ ] **Step 3: Add core types**

In `packages/core/src/index.ts`, near `DraftMarkdownProposalJobInput`:

```ts
// One unit of flow seeding: a document to author, described by what it should cover.
// `coverage` plays the role gap summaries play on the demand path; everything else is
// optional shaping. Shared by the seed executor and (v2) the outline generator.
export interface SeedItem {
  title?: string;
  targetPath?: string;
  coverage: string[];
  questions?: string[];
}

// Input to the draft_seed_document AI job: author a NEW document covering `coverage`,
// grounded in `sourceContext`. `provider` is added at enqueue (see @magpie/jobs).
export interface DraftSeedDocumentJobInput {
  flowId: string;
  title?: string;
  targetPath?: string;
  coverage: string[];
  questions?: string[];
  sourceContext: SourceDataContext[];
  destinationId?: string;
}

// Output of draft_seed_document: the authored document plus a short rationale.
export interface DraftSeedDocumentJobOutput {
  title: string;
  targetPath: string;
  markdown: string;
  rationale: string;
}
```

- [ ] **Step 4: Add jobs schemas**

In `packages/jobs/src/schemas.ts`, add to the `@magpie/core` import block (next to the draft types):

```ts
  DraftSeedDocumentJobInput as CoreDraftSeedDocumentJobInput,
  DraftSeedDocumentJobOutput,
```

Next to `draftMarkdownProposalOutputSchema`:

```ts
export const draftSeedDocumentInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  title: z.string().optional(),
  targetPath: z.string().optional(),
  coverage: z.array(z.string()),
  questions: z.array(z.string()).optional(),
  sourceContext: z.array(sourceDataContextSchema),
  destinationId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreDraftSeedDocumentJobInput>>;
export const draftSeedDocumentOutputSchema = z.object({
  title: z.string(),
  targetPath: z.string(),
  markdown: z.string(),
  rationale: z.string()
}) satisfies z.ZodType<DraftSeedDocumentJobOutput>;
```

- [ ] **Step 5: Register the job type + definition + AI set**

`packages/jobs/src/types.ts` — add `"draft_seed_document",` to `JOB_TYPES` immediately after `"draft_markdown_proposal",`.

`packages/jobs/src/catalog.ts` — add to `definitions` after the `draft_markdown_proposal` line:

```ts
  draft_seed_document: define("draft_seed_document", "provider", schemas.draftSeedDocumentInputSchema, schemas.draftSeedDocumentOutputSchema, 15 * 60),
```

…and add `"draft_seed_document",` to the `aiJobTypes` set after `"draft_markdown_proposal"`.

- [ ] **Step 6: Run jobs tests — verify they pass**

Run: `npm test -w @magpie/jobs`
Expected: PASS (new routing test + all existing).

- [ ] **Step 7: Add the prompt (failing prompt tests first)**

`packages/prompts/src/catalog.test.ts` — change `assert.equal(promptCatalog.length, 17)` to `18`, and insert `"draft-seed-document",` into the order array in catalog position (immediately after `"draft-markdown-proposal"`, matching the `promptCatalog` order you use in Step 8).

Run: `npm test -w @magpie/prompts`
Expected: FAIL — length 17, order mismatch.

- [ ] **Step 8: Define the prompt**

`packages/prompts/src/catalog.ts` — after the draft-markdown-proposal prompt:

```ts
export const DRAFT_SEED_DOCUMENT: PromptDefinition = {
  id: "draft-seed-document",
  title: "Author a seed document for a flow",
  description:
    "Authors a NEW knowledge-base document from a title + the points it should cover, grounded in the flow's source material. Used to seed a new flow or add a new area to an existing one, bypassing the demand-driven gap pipeline. Used by the watcher's draft_seed_document job.",
  usedBy: ["watcher · flow seeding"],
  outputShape: "{ title, targetPath, markdown, rationale }",
  instructions: `You author a single new Markdown knowledge-base document.

Input:
- "coverage": the points this document must cover. Author the whole document around these.
- "questions" (optional): motivating questions/prompts for context.
- "sourceContext": the source material to ground the document in.
- "title"/"targetPath" (optional): use them if given; otherwise choose a clear title and a
  sensible kebab-case path.

Rules:
- Return JSON only.
- Cover every point in "coverage". Ground every factual claim in "sourceContext" — quote or
  paraphrase only what the sources support. If the sources do not cover a point, write only
  what can be supported and note the gap plainly rather than inventing facts.
- Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs.
- Write clean, well-structured Markdown with headings; UK English.
- "rationale" is a one-paragraph summary of what the document covers and the sources used.

Return JSON:
{
  "title": "the document title",
  "targetPath": "kebab-case/path.md",
  "markdown": "the full document",
  "rationale": "string"
}`
};
```

…and add `DRAFT_SEED_DOCUMENT,` to `promptCatalog` immediately after the draft-markdown-proposal entry (keep it consistent with the order array in Step 7).

- [ ] **Step 9: Wire the watcher prompt + bump the API prompt count**

`apps/watcher/src/job-prompts.ts` — add `DRAFT_SEED_DOCUMENT` to the `@magpie/prompts` import and a case in `buildPrompt` after the `draft_markdown_proposal` case:

```ts
    case "draft_seed_document":
      return `${DRAFT_SEED_DOCUMENT.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
```

`apps/api/src/app.test.ts` — change the `/api/prompts` count assertion `17` → `18`.

- [ ] **Step 10: Run all touched package tests**

Run: `npm test -w @magpie/prompts && npm test -w @magpie/jobs && npm test -w @magpie/core`
Expected: PASS. (`@magpie/core` may have no tests — fine.)

- [ ] **Step 11: Commit**

```bash
git add packages/core packages/jobs packages/prompts apps/watcher/src/job-prompts.ts apps/api/src/app.test.ts
git commit -m "feat(jobs): add draft_seed_document AI job contract + prompt"
```

---

### Task 2: `seedFlow` service — enqueue one draft per item

Drafts each seed item directly into a `draft_seed_document` job, reusing flow/source
resolution but skipping the gap-candidate lookup. Enqueue-only.

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts` (new `draftSeedItem` + `seedFlow`; may need to lift `selectFlow`/`collectSourceContextCached` reuse — they already live in this module)
- Test: `apps/api/src/features/proposals/service.test.ts`

**Interfaces:**
- Consumes: `SeedItem` (`@magpie/core`); the existing flow/source helpers in `service.ts` (`selectFlow`, `collectSourceContextCached`, `defaultDestinationId`); `ctx.jobs.create("draft_seed_document", …)`.
- Produces: `seedFlow(ctx, flowId, items: SeedItem[]): Promise<{ ok: true; jobIds: string[] } | { ok: false; code: string }>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/features/proposals/service.test.ts` (match its imports — `* as proposals`, `makeTestContext`; the test context should expose at least one configured flow — reuse whatever the existing draft tests use for a flow id):

```ts
test("seedFlow enqueues one draft_seed_document per item, carrying flowId + coverage, honouring targetPath", async () => {
  const ctx = makeTestContext();
  const flowId = /* the configured test flow id */;
  const result = await proposals.seedFlow(ctx, flowId, [
    { title: "Overview", targetPath: "overview.md", coverage: ["what it is", "why"] },
    { coverage: ["config options"] }
  ]);
  assert.ok(result.ok);
  assert.equal(result.jobIds.length, 2);

  const jobs = (await ctx.jobs.list({ type: "draft_seed_document" })).jobs;
  assert.equal(jobs.length, 2);
  const first = jobs.find((j) => (j.input as { title?: string }).title === "Overview");
  assert.equal((first?.input as { flowId?: string }).flowId, flowId);
  assert.equal((first?.input as { targetPath?: string }).targetPath, "overview.md");
  assert.deepEqual((first?.input as { coverage?: string[] }).coverage, ["what it is", "why"]);

  // Seeding never touches the gaps store.
  assert.equal((await ctx.stores.questionLogs.listGapCandidates(200)).length, 0);
});

test("seedFlow rejects an unknown flow", async () => {
  const ctx = makeTestContext();
  const result = await proposals.seedFlow(ctx, "no-such-flow", [{ coverage: ["x"] }]);
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="seedFlow"`
Expected: FAIL — `seedFlow` not exported.

- [ ] **Step 3: Implement `draftSeedItem` + `seedFlow`**

In `apps/api/src/features/proposals/service.ts`, add `SeedItem` to the `@magpie/core` import and `DraftSeedDocumentJobInput` alongside it, then:

```ts
// Enqueue a draft_seed_document for one seed item. Reuses flow/source resolution but
// skips the gap-candidate matching that draftFromGaps requires — seed coverage is not a
// logged gap. Enqueue-only: the proposal lands via createSeedProposalFromCompletedJob.
async function draftSeedItem(
  ctx: AppContext,
  flowId: string,
  item: SeedItem,
  cache: SourceContextCache
): Promise<string> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, flowId);
  const sourceIds = flow?.sourceIds;
  const destinationId = flow?.destinationId ?? defaultDestinationId(deps);
  const sourceContext = await collectSourceContextCached(deps, sourceIds, cache);
  const input: DraftSeedDocumentJobInput & { provider: AiProviderName } = {
    flowId,
    title: item.title?.trim() || undefined,
    targetPath: item.targetPath?.trim() || undefined,
    coverage: [...new Set(item.coverage.map((c) => c.trim()).filter((c) => c.length > 0))],
    questions: item.questions?.length ? item.questions : undefined,
    sourceContext,
    destinationId,
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("draft_seed_document", input);
  return job.id;
}

// Seed a flow: draft each item directly into a proposal (bypassing gap clustering + the
// intent gate). Source context is memoised across items in one call.
export async function seedFlow(
  ctx: AppContext,
  flowId: string,
  items: SeedItem[]
): Promise<{ ok: true; jobIds: string[] } | { ok: false; code: string }> {
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  if (!flow) {
    return { ok: false, code: "flow_not_found" };
  }
  const usable = items.filter((item) => item.coverage.some((c) => c.trim().length > 0));
  if (usable.length === 0) {
    return { ok: false, code: "coverage_required" };
  }
  const cache: SourceContextCache = new Map();
  const jobIds: string[] = [];
  for (const item of usable) {
    jobIds.push(await draftSeedItem(ctx, flowId, item, cache));
  }
  logger.info({ flowId, count: jobIds.length }, "seeded flow: enqueued draft_seed_document jobs");
  return { ok: true, jobIds };
}
```

(If `selectFlow` requires an id and returns `undefined` for unknown flows, the guard above
is correct; confirm the exact `selectFlow` signature in this module and adapt. `SourceContextCache`
is already a type in this file.)

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="seedFlow"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/proposals/service.ts apps/api/src/features/proposals/service.test.ts
git commit -m "feat(seeding): seedFlow enqueues a draft_seed_document per seed item"
```

---

### Task 3: Completion handler + shared clusterless reconcile

On a completed `draft_seed_document` job, create a clusterless `Proposal` carrying `flowId`
and reconcile it (fold / self-publish). Extract the shared reconcile body so verify and seed
share one gate.

**Files:**
- Modify: `apps/api/src/scheduling/fold.ts` (extract `reconcileClusterlessProposal(ctx, proposal, lens)`; `reconcileCorrectiveProposal` delegates; new `reconcileSeedProposal`)
- Modify: `apps/api/src/features/proposals/service.ts` (new `createSeedProposalFromCompletedJob`)
- Modify: `apps/api/src/features/jobs/service.ts` (`completeJob` — new rung after the corrective block)
- Test: `apps/api/src/scheduling/fold.test.ts`, `apps/api/src/features/proposals/service.test.ts`, `apps/api/src/features/jobs/service.test.ts`

**Interfaces:**
- Consumes: `draftSeedDocumentOutputSchema` (`@magpie/jobs`); `DraftSeedDocumentJobInput` (`@magpie/core`); `ctx.stores.proposals.create`; the reconcile-gate + fold helpers already imported in `fold.ts`.
- Produces: `reconcileClusterlessProposal(ctx, proposal, lens: MaintenanceLens)`; `reconcileSeedProposal(ctx, proposal)`; `createSeedProposalFromCompletedJob(ctx, job, output): Promise<Proposal | undefined>`.

- [ ] **Step 1: Extract the shared reconcile (refactor, behaviour-preserving)**

In `apps/api/src/scheduling/fold.ts`, factor the body of `reconcileCorrectiveProposal`
(`fold.ts:70`) into:

```ts
// Gate + publish a clusterless proposal (verify corrective, seed, …). It OWNS
// publication: unlike the gap at-draft hook, open-new and defer both publish it as its own
// PR; only a touchable overlap folds. `lens` is cosmetic here — only `targets` drive
// decideReconciliation — but is threaded for the audit/intent trace. Best-effort — the
// caller (completeJob) guards throws.
export async function reconcileClusterlessProposal(
  ctx: AppContext,
  proposal: Proposal,
  lens: MaintenanceLens
): Promise<void> {
  // …exactly the current reconcileCorrectiveProposal body, with `lens: "verify"` replaced
  // by the `lens` parameter in the ChangeIntent…
}

export async function reconcileCorrectiveProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  return reconcileClusterlessProposal(ctx, proposal, "verify");
}

export async function reconcileSeedProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  return reconcileClusterlessProposal(ctx, proposal, "gap");
}
```

Import `MaintenanceLens` from `@magpie/core` if not already imported. **Run the existing
fold tests now** to prove the refactor is behaviour-preserving:

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcileCorrectiveProposal"`
Expected: PASS (unchanged).

- [ ] **Step 2: Write the failing seed-reconcile + completion tests**

Append to `apps/api/src/scheduling/fold.test.ts` (add `reconcileSeedProposal` to the `./fold.js` import), mirroring the corrective tests: `open-new` (no overlap) → one pending publish action; `fold` (overlapping touchable PR on the same path) → one `fold_markdown_proposal` job and no publish action. Use a proposal with `flowId` set and `targetPath` set.

Append to `apps/api/src/features/proposals/service.test.ts`:

```ts
test("createSeedProposalFromCompletedJob creates a flowId-carrying draft, idempotent on jobId", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("draft_seed_document", {
    flowId: "billing", coverage: ["x"], sourceContext: [], provider: "codex"
  });
  const output = { title: "Billing overview", targetPath: "billing.md", markdown: "# Billing", rationale: "seed" };
  const first = await proposals.createSeedProposalFromCompletedJob(ctx, job, output);
  assert.ok(first);
  assert.equal(first?.flowId, "billing");
  assert.equal(first?.targetPath, "billing.md");
  assert.equal(first?.gapClusterId, undefined);
  const second = await proposals.createSeedProposalFromCompletedJob(ctx, job, output);
  assert.equal(second?.id, first?.id);
});
```

- [ ] **Step 3: Run them — verify they fail**

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcileSeedProposal|createSeedProposalFromCompletedJob"`
Expected: FAIL — neither symbol exists yet.

- [ ] **Step 4: Implement `createSeedProposalFromCompletedJob`**

In `apps/api/src/features/proposals/service.ts`, add `draftSeedDocumentOutputSchema` to the `@magpie/jobs` import and `DraftSeedDocumentJobInput` to `@magpie/core`, then:

```ts
// Completion handler for draft_seed_document: a seed draft landed, so create a clusterless
// draft Proposal carrying flowId first-class (so the gate + per-flow outbox treat it as
// same-flow). De-duped by jobId, so a re-delivered completion returns the same proposal.
export async function createSeedProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "draft_seed_document") {
    return undefined;
  }
  const parsed = draftSeedDocumentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<DraftSeedDocumentJobInput>;
  if (!input.flowId) {
    return undefined;
  }
  return ctx.stores.proposals.create({
    title: parsed.data.title,
    targetPath: resolveProposalTargetPath(
      destinationSubpath(ctx.repositoryDeps(), input.destinationId),
      parsed.data.targetPath || parsed.data.title
    ),
    markdown: parsed.data.markdown,
    rationale: parsed.data.rationale,
    evidence: [],
    flowId: input.flowId,
    destinationId: input.destinationId,
    jobId: job.id
  });
}
```

(Confirm the exact `resolveProposalTargetPath` arg order against `createProposalFromCompletedJob`
above it and match it; if it prefers the model's `targetPath`, pass that.)

- [ ] **Step 5: Wire into `completeJob`**

In `apps/api/src/features/jobs/service.ts`, add a rung after the corrective block (~after line 179):

```ts
    const seedProposal = await proposalsService.createSeedProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (seedProposal) {
      try {
        await foldService.reconcileSeedProposal(ctx, seedProposal);
      } catch (error) {
        logger.warn({ proposalId: seedProposal.id, err: error instanceof Error ? error.message : String(error) }, "seed reconcile for proposal failed");
      }
    }
```

- [ ] **Step 6: Integration test for the wiring**

Append to `apps/api/src/features/jobs/service.test.ts`:

```ts
test("completeJob on a draft_seed_document job creates a seed proposal and enqueues its publication", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("draft_seed_document", {
    flowId: "billing", coverage: ["overview"], sourceContext: [], provider: "codex"
  });
  const result = await completeJob(ctx, job.id, { title: "Billing", targetPath: "billing.md", markdown: "# Billing", rationale: "seed" });
  assert.ok(result.ok);
  const proposal = (await ctx.stores.proposals.list(50)).find((p) => p.flowId === "billing");
  assert.ok(proposal);
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.ok(actions.some((a) => a.proposalId === proposal?.id && a.kind === "publish"));
});
```

Run: `npm test -w @magpie/api -- --test-name-pattern="draft_seed_document job creates a seed proposal|reconcileSeedProposal|createSeedProposalFromCompletedJob|reconcileCorrectiveProposal"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/scheduling/fold.ts apps/api/src/scheduling/fold.test.ts apps/api/src/features/proposals/service.ts apps/api/src/features/proposals/service.test.ts apps/api/src/features/jobs/service.ts apps/api/src/features/jobs/service.test.ts
git commit -m "feat(seeding): seed proposals gate + self-publish via shared clusterless reconcile"
```

---

### Task 4: `POST /api/flows/:flowId/seed` endpoint

Expose seeding over HTTP, following the gaps router's scope/auth/404-hiding pattern.

**Files:**
- Create: `apps/api/src/features/seed/routes.ts`, `apps/api/src/features/seed/schema.ts`
- Modify: `apps/api/src/app.ts` (import + mount under `/api`)
- Test: `apps/api/src/features/seed/routes.test.ts` (or extend `app.test.ts`)

**Interfaces:**
- Consumes: `seedFlow` (Task 2); `requireScopes`, `assertCan`, `HttpError`, `zValidator`.
- Produces: `seedRoutes(ctx: AppContext): Hono`; `POST /api/flows/:flowId/seed` → `{ ok: true, jobIds }`.

- [ ] **Step 1: Body schema**

`apps/api/src/features/seed/schema.ts`:

```ts
import { z } from "zod";

export const seedItemSchema = z.object({
  title: z.string().optional(),
  targetPath: z.string().optional(),
  coverage: z.array(z.string().min(1)).min(1),
  questions: z.array(z.string()).optional()
});

export const seedBodySchema = z.object({
  items: z.array(seedItemSchema).min(1)
});
```

- [ ] **Step 2: Write the failing route test**

`apps/api/src/features/seed/routes.test.ts` — mirror `gaps/routes.test.ts` (auth/context helpers): a valid POST returns `{ ok: true, jobIds: [...] }` with one job id per item; an unknown/unauthorised `:flowId` returns 404; an empty `items` array returns 400.

- [ ] **Step 3: Run it — verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="seed route|/flows/:flowId/seed"`
Expected: FAIL — router not mounted.

- [ ] **Step 4: Implement the router**

`apps/api/src/features/seed/routes.ts` (template: `gaps/routes.ts`):

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import { seedFlow } from "../proposals/service.js";
import { seedBodySchema } from "./schema.js";

export function seedRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  app.post(
    "/:flowId/seed",
    requireScopes("manage:jobs"),
    zValidator("json", seedBodySchema, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_seed_body" }, 400);
    }),
    async (c) => {
      const flowId = c.req.param("flowId");
      if (!ctx.knowledgeConfig.flows.some((f) => f.id === flowId)) {
        throw new HttpError(404, "flow_not_found");
      }
      assertCan(ctx, c, "manage", flowId);
      const { items } = c.req.valid("json");
      const outcome = await seedFlow(ctx, flowId, items);
      if (!outcome.ok) {
        throw new HttpError(outcome.code === "flow_not_found" ? 404 : 400, outcome.code);
      }
      return c.json({ ok: true, jobIds: outcome.jobIds });
    }
  );
  return app;
}
```

`apps/api/src/app.ts` — import `seedRoutes` and mount: `api.route("/flows", seedRoutes(ctx));`
(confirm no existing `/flows` collision; if `/flows` is taken for flow listing, mount the seed
router there too or under the existing flows router — keep the `POST :id/seed` path).

- [ ] **Step 5: Run it — verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="seed route|/flows/:flowId/seed"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/features/seed apps/api/src/app.ts
git commit -m "feat(seeding): POST /flows/:id/seed endpoint"
```

---

### Task 5: `kb.seed` MCP tool

Let an interviewer LLM submit a finished outline in one shot.

**Files:**
- Modify: `apps/mcp/src/kb-client.ts` (new `seedFlow` method)
- Modify: `apps/mcp/src/main.ts` (tool declaration + `callTool` branch)
- Test: MCP client test if present (`apps/mcp/src/*.test.ts`)

**Interfaces:**
- Consumes: `postJson` in `kb-client.ts`.
- Produces: `seedFlow(flowId, items, options?)` client method; MCP tool `kb.seed`.

- [ ] **Step 1: Client method**

In `apps/mcp/src/kb-client.ts`, mirroring `submitFeedback`'s POST pattern:

```ts
export async function seedFlow(
  flowId: string,
  items: unknown,
  options?: KbClientOptions
): Promise<string> {
  const body = await postJson(`/flows/${encodeURIComponent(flowId)}/seed`, { items }, options);
  return JSON.stringify(body);
}
```

- [ ] **Step 2: Tool declaration + dispatch**

In `apps/mcp/src/main.ts`, add to the `tools` array (after `kb.feedback`):

```ts
{
  name: "kb.seed",
  description:
    "Seed a flow with initial content: submit a list of documents to author (each a title + the points it should cover). Drafts each straight into a proposal → PR, skipping the gap-clustering pipeline. Use for a new flow or to add a new area to an existing one.",
  inputSchema: {
    type: "object",
    properties: {
      flow: { type: "string", description: "The flow id to seed (see kb.flows)." },
      items: {
        type: "array",
        description: "One entry per document to author.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            targetPath: { type: "string" },
            coverage: { type: "array", items: { type: "string" }, description: "Points this doc must cover." },
            questions: { type: "array", items: { type: "string" } }
          },
          required: ["coverage"],
          additionalProperties: false
        }
      }
    },
    required: ["flow", "items"],
    additionalProperties: false
  } satisfies JsonSchema
}
```

…and a branch in `callTool`:

```ts
if (params.name === "kb.seed") {
  const flow = stringArgument(params.arguments, "flow");
  const items = params.arguments?.items;
  const result = await seedFlow(flow, items, { token: stdioAuthToken });
  return textResult(result);
}
```

Import `seedFlow` from `./kb-client.js`.

- [ ] **Step 3: Run MCP tests + build**

Run: `npm test -w @magpie/mcp && npm run build -w @magpie/mcp`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/src/kb-client.ts apps/mcp/src/main.ts
git commit -m "feat(mcp): kb.seed tool to seed a flow in one shot"
```

---

### Task 6: Docs + full-suite gates + branch finish

- [ ] **Step 1: Document the job + the seed path**

Add `draft_seed_document` to [`docs/ai-jobs.md`](../../ai-jobs.md) (job list + one-line
description) and a short "Seeding a flow" section to the architecture/README noting: direct
authoring, bypasses gap clustering + intent, surfaced via `POST /flows/:id/seed` and
`kb.seed`, still ends at a reviewable PR. Cross-link the design spec.

- [ ] **Step 2: Full API suite**

Run: `npm test -w @magpie/api`
Expected: PASS. Known unrelated local-only failures (a Windows path-separator watcher test; a
web test-glob quirk) pass on CI Linux — investigate any OTHER failure.

- [ ] **Step 3: Typecheck + deadcode + whole-repo tests**

Run: `npm run typecheck && npm run deadcode && npm test`
Expected: PASS. If knip flags a new export as unused, confirm it is consumed (e.g.
`reconcileSeedProposal` by `completeJob`, `seedFlow` by both the route and `kb.seed`); if
genuinely unused, de-export — never relax the knip config.

- [ ] **Step 4: Finish the branch**

Push to `claude/flow-seeding-optimization-p9j7np`. Open a PR off `main` only when asked. PR
title: `feat: seed a flow (direct authoring, v1)`. Summarise: the `draft_seed_document` job +
prompt, `seedFlow`, the seed completion handler + shared `reconcileClusterlessProposal`, the
`POST /flows/:id/seed` endpoint, and the `kb.seed` MCP tool. **Both this plan and the design
spec ship in the same PR** (they are committed under `docs/superpowers/`).

---

## Self-Review

**Spec coverage:**
- §2 `SeedItem`/`SeedSpec` → Task 1 (core) + Task 4 (route schema). ✓
- §3 dedicated `draft_seed_document` job + seed prompt (why not `draftFromGaps`) → Task 1. ✓
- §4 `seedFlow` skips clustering/intent, memoised source context, enqueue-only → Task 2. ✓
- §5 clusterless proposal → shared reconcile → self-publish via outbox → Task 3. ✓
- §6 API endpoint + `kb.seed` → Tasks 4 + 5. ✓
- §7 error handling: malformed output → no proposal (Task 3 parse guard); idempotent on jobId
  (Task 3 test); overlap folds (Task 3 fold test). ✓
- §9 testing — every listed test maps to a step. ✓

**Deliberately out of scope (v2, §8 of the spec):** `outline_flow_seed` job, web console UI,
in-place revision of an existing doc.

**Type consistency:** `draft_seed_document` / `draftSeedDocumentInputSchema` /
`draftSeedDocumentOutputSchema` / `DraftSeedDocumentJobInput` / `DraftSeedDocumentJobOutput` /
`SeedItem` / `seedFlow` / `createSeedProposalFromCompletedJob` / `reconcileSeedProposal` /
`reconcileClusterlessProposal` are used identically across tasks. No new migration; reuses
`Proposal.flowId`. The fold-job input in the shared reconcile is unchanged from
`reconcileCorrectiveProposal`.

**Placeholder scan:** two intentional "confirm the exact signature" notes (`selectFlow`,
`resolveProposalTargetPath`) where the plan defers to the real in-module signature rather than
guessing arg order — each states the behavioural contract to preserve. The configured test
flow id in Task 2 Step 1 is left as a `/* … */` for the implementer to fill from the existing
test context.
