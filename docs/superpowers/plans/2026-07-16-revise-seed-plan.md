# Revise a Seed Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer reshape a *proposed* seed plan in place with a natural-language instruction ("don't mention X"), without re-exploring the flow's sources.

**Architecture:** A new queue-only, non-source-grounded job `revise_seed_plan` carries the current plan snapshot + instruction; the watcher runs the `REVISE_SEED_PLAN` prompt on the chat provider via the plain generative path; a completion handler replaces the plan's items (and optionally charter/persona/rationale) in place, only while the plan is still `proposed`.

**Tech Stack:** TypeScript (ESM/NodeNext), Zod, Hono, node:test, Postgres (pg), React (Next/Turbopack), Emotion.

## Global Constraints

- Node ≥ 22.13, ESM/NodeNext, TypeScript. UK English in all model-facing copy.
- **Queue-only AI**: never call a chat provider inline in the API — enqueue a job.
- **Never cast through `unknown`/`any`** to silence types; fix types properly.
- Validate as you go: `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run deadcode` — do not batch.
- **knip is STRICT**: every new export must be consumed, or knip fails CI. Only export what another package/file imports; keep internal helpers unexported.
- Run tests via `npm test -w <pkg>` (root-cwd `node --test` resolves stale dist).
- Commit and push little and often. Work on this `claude/*` branch (main is PR-protected).
- Follow existing patterns in each file; match surrounding comment density and idiom.

---

### Task 1: Core job types

**Files:**
- Modify: `packages/core/src/index.ts` (near the seed types, after `OutlineFlowSeedJobOutput` ~line 1050)

**Interfaces:**
- Produces: `ReviseSeedPlanJobInput`, `ReviseSeedPlanJobOutput` (consumed by Task 2 schemas).

- [ ] **Step 1: Add the interfaces**

In `packages/core/src/index.ts`, immediately after the `OutlineFlowSeedJobOutput` interface, add:

```ts
// Input of revise_seed_plan: an existing proposed plan plus a natural-language
// instruction to reshape it by. Deliberately carries NO sources — the revision
// reshapes the plan text and never re-explores the source repositories (that is
// what makes it "not from scratch"). planId is read back at completion to apply
// the result to the right plan (the seedPlanId precedent).
export interface ReviseSeedPlanJobInput {
  flowId: string;
  planId: string;
  instruction: string;
  currentPlan: {
    items: SeedItem[];
    charter?: string;
    persona?: string;
    rationale: string;
  };
}

// Output of revise_seed_plan: the reshaped plan. items reuse the SeedItem shape
// (coverage may be empty in raw model output; approval separately enforces
// non-empty). charter/persona are returned only when the instruction changed
// them — they must be declared here or the broker strips them before the
// completion handler reads them.
export interface ReviseSeedPlanJobOutput {
  items: SeedItem[];
  rationale: string;
  charter?: string;
  persona?: string;
}
```

- [ ] **Step 2: Build core**

Run: `npm run build -w @magpie/core`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): revise_seed_plan job input/output types"
```

---

### Task 2: Job registration (types, schemas, catalog)

**Files:**
- Modify: `packages/jobs/src/types.ts` (`JOB_TYPES` array)
- Modify: `packages/jobs/src/schemas.ts` (new schemas, after `outlineFlowSeedOutputSchema` ~line 293)
- Modify: `packages/jobs/src/catalog.ts` (`definitions` map ~line 98, `AI_JOB_TYPES` ~line 161)
- Test: `packages/jobs/src/schemas.test.ts`, `packages/jobs/src/catalog.test.ts`

**Interfaces:**
- Consumes: `ReviseSeedPlanJobInput`, `ReviseSeedPlanJobOutput` (Task 1); `seedItemSchema` (existing, schemas.ts ~line 268).
- Produces: `reviseSeedPlanInputSchema`, `reviseSeedPlanOutputSchema`; catalog entry `revise_seed_plan` routed `"provider"`.

- [ ] **Step 1: Write the failing schema test**

In `packages/jobs/src/schemas.test.ts`, add (import the two schemas at the top alongside the existing outline imports):

```ts
test("revise_seed_plan input carries planId/instruction/currentPlan, no sources", () => {
  const input = {
    provider: "codex",
    flowId: "flow-1",
    planId: "plan-1",
    instruction: "don't mention pricing",
    currentPlan: { items: [{ coverage: ["a"] }], rationale: "r", charter: "c" }
  };
  assert.ok(reviseSeedPlanInputSchema.safeParse(input).success);
  assert.ok(!("sources" in reviseSeedPlanInputSchema.shape));
});

test("revise_seed_plan output keeps optional charter/persona (broker-strip protection)", () => {
  const output = { items: [{ coverage: ["a"] }], rationale: "r", charter: "c2", persona: "p2" };
  const parsed = reviseSeedPlanOutputSchema.safeParse(output);
  assert.ok(parsed.success);
  assert.equal(parsed.success && parsed.data.charter, "c2");
  assert.ok(reviseSeedPlanOutputSchema.safeParse({ items: [], rationale: "r" }).success);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/jobs`
Expected: FAIL — `reviseSeedPlanInputSchema` is not defined.

- [ ] **Step 3: Add the schemas**

In `packages/jobs/src/schemas.ts`, add the core-type imports to the existing `@magpie/core` import block:

```ts
  ReviseSeedPlanJobInput as CoreReviseSeedPlanJobInput,
  ReviseSeedPlanJobOutput,
```

Then after `outlineFlowSeedOutputSchema` (~line 293) add:

```ts
export const reviseSeedPlanInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  planId: z.string(),
  instruction: z.string(),
  currentPlan: z.object({
    items: z.array(seedItemSchema),
    charter: z.string().optional(),
    persona: z.string().optional(),
    rationale: z.string()
  })
}) satisfies z.ZodType<ProviderInput<CoreReviseSeedPlanJobInput>>;
export const reviseSeedPlanOutputSchema = z.object({
  items: z.array(seedItemSchema),
  rationale: z.string(),
  // Returned only when the instruction changed them; declared so the broker
  // does not strip them before the completion handler reads them.
  charter: z.string().optional(),
  persona: z.string().optional()
}) satisfies z.ZodType<ReviseSeedPlanJobOutput>;
```

- [ ] **Step 4: Register the job type**

In `packages/jobs/src/types.ts`, add `"revise_seed_plan",` to `JOB_TYPES` immediately after `"outline_flow_seed",`.

In `packages/jobs/src/catalog.ts`:
- In the `definitions` map after the `outline_flow_seed` line, add:
```ts
  revise_seed_plan: define("revise_seed_plan", "provider", schemas.reviseSeedPlanInputSchema, schemas.reviseSeedPlanOutputSchema, 10 * 60),
```
- In `AI_JOB_TYPES` add `"revise_seed_plan",` after `"outline_flow_seed",` (it is metered provider work). Do **not** add it to `INTERACTIVE_AI_JOB_TYPES`.

- [ ] **Step 5: Add the catalog routing test**

In `packages/jobs/src/catalog.test.ts`, add:

```ts
test("revise_seed_plan routes by provider and is metered but not interactive", () => {
  const definition = jobDefinition("revise_seed_plan");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("revise_seed_plan", { provider: "codex" }), "revise_seed_plan__codex");
  assert.ok(isAiJobType("revise_seed_plan"));
  assert.ok(!isInteractiveJobType("revise_seed_plan"));
});
```

Check the existing TTL map test (`catalog.test.ts` ~line 31) — if it asserts an exhaustive per-type map, add `revise_seed_plan: 10 * 60,`. Ensure `isAiJobType`/`isInteractiveJobType` are imported in the test.

- [ ] **Step 6: Run tests**

Run: `npm test -w @magpie/jobs`
Expected: PASS (all, including any exhaustive-catalog assertions).

- [ ] **Step 7: Build + commit**

```bash
npm run build -w @magpie/jobs
git add packages/core packages/jobs
git commit -m "feat(jobs): register revise_seed_plan job (provider-routed, metered)"
```

---

### Task 3: The REVISE_SEED_PLAN prompt

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (new export near `OUTLINE_FLOW_SEED` ~line 224; add to `promptCatalog` array ~line 647)
- Test: `packages/prompts/src/catalog.test.ts`

**Interfaces:**
- Produces: `REVISE_SEED_PLAN` (a `PromptDefinition`), consumed by Task 4's `JOB_INSTRUCTIONS`.

- [ ] **Step 1: Write the failing catalog test**

Inspect `packages/prompts/src/catalog.test.ts` for the pattern that asserts each prompt is registered (e.g. a loop over ids, or `getPrompt`). Add an assertion mirroring it:

```ts
test("revise-flow-seed prompt is registered", () => {
  const prompt = getPrompt("revise-flow-seed");
  assert.ok(prompt, "REVISE_SEED_PLAN should be registered");
  assert.match(prompt!.instructions, /reshape/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @magpie/prompts`
Expected: FAIL — `getPrompt("revise-flow-seed")` is undefined.

- [ ] **Step 3: Add the prompt**

In `packages/prompts/src/catalog.ts`, after the `OUTLINE_FLOW_SEED` definition, add:

```ts
export const REVISE_SEED_PLAN: PromptDefinition = {
  id: "revise-flow-seed",
  title: "Revise a seed plan by instruction",
  description:
    "Reshapes an existing, human-reviewed seed plan according to a natural-language instruction (e.g. \"don't mention X\", merge/split/reorder items). Reshapes the plan text only — it has NO access to the source repositories, so it never invents new grounded facts. Used by the watcher's revise_seed_plan job.",
  usedBy: ["watcher · seed plan revision"],
  outputShape: "{ items: [{ title, targetPath?, coverage[], questions? }], rationale, charter?, persona? }",
  instructions: `You revise an existing plan for seeding a Markdown knowledge base. You are given the CURRENT plan and an INSTRUCTION describing a change to make. You reshape the plan to satisfy the instruction — you do NOT write the documents.

Input:
- "instruction": the change to make to the plan.
- "currentPlan": the plan to revise — { items: [{ title, targetPath?, coverage[], questions? }], charter?, persona?, rationale }.

What you may change:
- Remove, soften, or reframe coverage points; merge, split, drop, or reorder items; edit titles and target paths; add or remove motivating questions.
- When the instruction implies it, trim or reword "charter" and/or "persona" — return them ONLY when you changed them.

Hard rules:
- You have NO access to the source repositories in this task. Do NOT invent new facts, coverage, titles, or documents that the current plan did not already contain. You may only recombine, reduce, and reframe what is already in the plan.
- If the instruction asks for genuinely new material that would require reading the sources (e.g. "add a document about a topic the plan doesn't cover"), leave "items" unchanged and explain in "rationale" that the request needs a fresh source-grounded outline.
- Preserve every item's grounding: never move a coverage point onto a document it does not belong to just to satisfy the instruction.
- Return JSON only. UK English.

"rationale" is a one-paragraph summary of what you changed and why (and anything you deliberately did not change).

Return JSON:
{
  "items": [
    { "title": "string", "targetPath": "kebab-case/path.md", "coverage": ["point"], "questions": ["string"] }
  ],
  "rationale": "string",
  "charter": "string (only when you changed it)",
  "persona": "string (only when you changed it)"
}`
};
```

Add `REVISE_SEED_PLAN,` to the `promptCatalog` array (after `OUTLINE_FLOW_SEED,`).

- [ ] **Step 4: Run tests**

Run: `npm test -w @magpie/prompts`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
npm run build -w @magpie/prompts
git add packages/prompts
git commit -m "feat(prompts): REVISE_SEED_PLAN reshape-only prompt"
```

---

### Task 4: Watcher prompt wiring

**Files:**
- Modify: `apps/watcher/src/job-prompts.ts` (import ~line 23, `JOB_INSTRUCTIONS` map ~line 83)
- Test: `apps/watcher/src/job-prompts.test.ts`

**Interfaces:**
- Consumes: `REVISE_SEED_PLAN` (Task 3), `reviseSeedPlanOutputSchema` via `parseJobOutput` (Task 2).
- The revise job has no `sources`, so it flows through `buildPrompt` → `runGenerativeJob`'s default branch. No runner code change needed.

- [ ] **Step 1: Write the failing test**

In `apps/watcher/src/job-prompts.test.ts`, add a test that `buildPrompt` for a `revise_seed_plan` job includes the reshape instructions and the input JSON:

```ts
test("buildPrompt renders the revise_seed_plan instructions with the plan", () => {
  const job = {
    id: "j1",
    type: "revise_seed_plan",
    input: { flowId: "f", planId: "p", instruction: "drop pricing", currentPlan: { items: [], rationale: "r" } }
  } as unknown as JobView;
  const prompt = buildPrompt(job);
  assert.match(prompt, /reshape/i);
  assert.match(prompt, /drop pricing/);
});
```

(Match the file's existing import of `JobView` and `buildPrompt`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bash -lc "npm test -w @magpie/watcher"` (watcher tests use a Unix env-prefix — run via Git Bash, not PowerShell)
Expected: FAIL — falls back to the generic envelope, no "reshape".

- [ ] **Step 3: Wire the instruction**

In `apps/watcher/src/job-prompts.ts`: add `REVISE_SEED_PLAN,` to the `@magpie/prompts` import block, and add to `JOB_INSTRUCTIONS`:

```ts
  revise_seed_plan: REVISE_SEED_PLAN.instructions,
```

- [ ] **Step 4: Run the test**

Run: `bash -lc "npm test -w @magpie/watcher"`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
npm run build -w @magpie/watcher
git add apps/watcher/src/job-prompts.ts apps/watcher/src/job-prompts.test.ts
git commit -m "feat(watcher): route revise_seed_plan to its prompt"
```

---

### Task 5: Store `revise` method

**Files:**
- Modify: `apps/api/src/stores/seed-plan-store.ts` (interface + `InMemorySeedPlanStore`)
- Modify: `apps/api/src/stores/postgres-seed-plan-store.ts` (`PostgresSeedPlanStore`)
- Test: `apps/api/src/stores/seed-plan-store.test.ts`, `apps/api/src/stores/postgres-seed-plan-store.test.ts`

**Interfaces:**
- Produces: `SeedPlanStore.revise(id, next)` where
  `next: { items: Omit<SeedPlanItem,"id"|"status"|"draftJobId">[]; charter?: string; persona?: string; rationale: string }`
  → `Promise<SeedPlan | undefined>`. Consumed by Task 6.

- [ ] **Step 1: Write the failing in-memory test**

In `apps/api/src/stores/seed-plan-store.test.ts`, add:

```ts
test("revise replaces items with fresh proposed ids and updates rationale/charter/persona", async () => {
  const store = new InMemorySeedPlanStore();
  const plan = await store.create({
    flowId: "f", origin: "manual", charterProposed: false, personaProposed: false,
    items: [{ title: "old", coverage: ["x"] }], rationale: "r0", outlineJobId: "o1", sourceHash: "h"
  });
  const oldId = plan.items[0].id;
  const revised = await store.revise(plan.id, {
    items: [{ title: "new", coverage: ["y"] }], charter: "c1", persona: "p1", rationale: "r1"
  });
  assert.ok(revised);
  assert.equal(revised!.id, plan.id);
  assert.equal(revised!.rationale, "r1");
  assert.equal(revised!.charter, "c1");
  assert.equal(revised!.persona, "p1");
  assert.equal(revised!.items.length, 1);
  assert.equal(revised!.items[0].title, "new");
  assert.equal(revised!.items[0].status, "proposed");
  assert.notEqual(revised!.items[0].id, oldId);
  assert.equal(await store.revise("missing", { items: [], rationale: "r" }), undefined);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern "revise replaces items"`
Expected: FAIL — `store.revise` is not a function.

- [ ] **Step 3: Add to the interface + in-memory store**

In `seed-plan-store.ts`, add to the `SeedPlanStore` interface (after `patch`):

```ts
  // Replaces the plan's items wholesale (fresh proposed ids, like create) and
  // updates rationale; charter/persona are updated only when provided. Used by
  // the revise_seed_plan completion handler; the "only while proposed" rule is
  // enforced in the seed service.
  revise(
    id: string,
    next: {
      items: Omit<SeedPlanItem, "id" | "status" | "draftJobId">[];
      charter?: string;
      persona?: string;
      rationale: string;
    }
  ): Promise<SeedPlan | undefined>;
```

Add to `InMemorySeedPlanStore` (after `patch`):

```ts
  async revise(
    id: string,
    next: {
      items: Omit<SeedPlanItem, "id" | "status" | "draftJobId">[];
      charter?: string;
      persona?: string;
      rationale: string;
    }
  ): Promise<SeedPlan | undefined> {
    const existing = this.plans.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: SeedPlan = {
      ...existing,
      ...(next.charter !== undefined ? { charter: next.charter } : {}),
      ...(next.persona !== undefined ? { persona: next.persona } : {}),
      items: next.items.map((item) => ({ ...item, id: randomUUID(), status: "proposed" as const })),
      rationale: next.rationale,
      updatedAt: new Date().toISOString()
    };
    this.plans.set(id, updated);
    return updated;
  }
```

- [ ] **Step 4: Run the in-memory test**

Run: `npm test -w @magpie/api -- --test-name-pattern "revise replaces items"`
Expected: PASS.

- [ ] **Step 5: Add the postgres implementation**

In `postgres-seed-plan-store.ts`, add (after `patch`), following the locked read-modify-write pattern:

```ts
  async revise(
    id: string,
    next: {
      items: Omit<SeedPlanItem, "id" | "status" | "draftJobId">[];
      charter?: string;
      persona?: string;
      rationale: string;
    }
  ): Promise<SeedPlan | undefined> {
    const items: SeedPlanItem[] = next.items.map((item) => ({
      ...item,
      id: randomUUID(),
      status: "proposed" as const
    }));
    const result = await this.pool.query<SeedPlanRow>(
      `
        UPDATE seed_plans
        SET charter = COALESCE($2, charter),
            persona = COALESCE($3, persona),
            items = $4,
            rationale = $5,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [id, next.charter ?? null, next.persona ?? null, JSON.stringify(items), next.rationale]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }
```

- [ ] **Step 6: Add the postgres integration test**

In `postgres-seed-plan-store.test.ts`, mirror an existing test's structure (gated by `RUN_PG_INTEGRATION` via the throwaway-container harness) to create a plan, `revise` it, and assert items replaced + rationale/charter updated + fresh item ids + same plan id.

- [ ] **Step 7: Run tests + typecheck**

Run: `npm test -w @magpie/api -- --test-name-pattern "revise"` then `npm run typecheck -w @magpie/api`
Expected: PASS. (Postgres integration test runs only when `RUN_PG_INTEGRATION` is set; see writing-magpie-tests.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/stores/seed-plan-store.ts apps/api/src/stores/postgres-seed-plan-store.ts apps/api/src/stores/seed-plan-store.test.ts apps/api/src/stores/postgres-seed-plan-store.test.ts
git commit -m "feat(api): SeedPlanStore.revise replaces items in place"
```

---

### Task 6: Seed service — enqueue + completion handler

**Files:**
- Modify: `apps/api/src/features/seed/service.ts`
- Test: `apps/api/src/features/seed/service.test.ts`

**Interfaces:**
- Consumes: `ctx.jobs.create`, `ctx.stores.seedPlans.{get,revise}`, `selectFlow`, `reviseSeedPlanOutputSchema` (from `@magpie/jobs`), `ReviseSeedPlanJobInput` + `AiProviderName`.
- Produces:
  - `requestSeedPlanRevision(ctx, planId, instruction) → { ok: true; jobId } | { ok: false; code: "plan_not_found" | "plan_not_revisable" }`
  - `reviseSeedPlanFromCompletedJob(ctx, job, output) → Promise<SeedPlan | undefined>`

- [ ] **Step 1: Write the failing service tests**

In `apps/api/src/features/seed/service.test.ts`, add (reuse the file's existing `ctx`/job fixtures and helpers):

```ts
test("requestSeedPlanRevision enqueues a revise job for a proposed plan", async () => {
  const { ctx } = makeCtx();
  const plan = await seedPlanFixture(ctx, { status: "proposed" }); // helper in this file
  const outcome = await seed.requestSeedPlanRevision(ctx, plan.id, "drop pricing");
  assert.ok(outcome.ok);
  const { jobs } = await ctx.jobs.list({ type: "revise_seed_plan", limit: 10 });
  const input = jobs[0].input as ReviseSeedPlanJobInput;
  assert.equal(input.planId, plan.id);
  assert.equal(input.instruction, "drop pricing");
  assert.ok(!("sources" in input));
});

test("requestSeedPlanRevision rejects a non-proposed plan", async () => {
  const { ctx } = makeCtx();
  const plan = await seedPlanFixture(ctx, { status: "approved" });
  const outcome = await seed.requestSeedPlanRevision(ctx, plan.id, "x");
  assert.deepEqual(outcome, { ok: false, code: "plan_not_revisable" });
});

test("reviseSeedPlanFromCompletedJob applies items/charter to a still-proposed plan", async () => {
  const { ctx } = makeCtx();
  const plan = await seedPlanFixture(ctx, { status: "proposed" });
  const job = { id: "j1", type: "revise_seed_plan", input: { planId: plan.id, flowId: plan.flowId, instruction: "x", currentPlan: { items: [], rationale: "r" } } } as unknown as JobView;
  const updated = await seed.reviseSeedPlanFromCompletedJob(ctx, job, {
    items: [{ title: "T", coverage: ["c"] }], rationale: "r2", charter: "c2"
  });
  assert.ok(updated);
  assert.equal(updated!.items[0].title, "T");
  assert.equal(updated!.charter, "c2");
  assert.equal(updated!.rationale, "r2");
});

test("reviseSeedPlanFromCompletedJob ignores non-proposed plans, other types, unparsable output", async () => {
  const { ctx } = makeCtx();
  const approved = await seedPlanFixture(ctx, { status: "approved" });
  const jobFor = (planId: string) => ({ id: "j", type: "revise_seed_plan", input: { planId, flowId: "f", instruction: "x", currentPlan: { items: [], rationale: "r" } } } as unknown as JobView);
  assert.equal(await seed.reviseSeedPlanFromCompletedJob(ctx, jobFor(approved.id), { items: [], rationale: "r" }), undefined);
  const other = { id: "j", type: "outline_flow_seed", input: {} } as unknown as JobView;
  assert.equal(await seed.reviseSeedPlanFromCompletedJob(ctx, other, { items: [], rationale: "r" }), undefined);
  const proposed = await seedPlanFixture(ctx, { status: "proposed" });
  assert.equal(await seed.reviseSeedPlanFromCompletedJob(ctx, jobFor(proposed.id), { nonsense: true }), undefined);
  assert.equal(await seed.reviseSeedPlanFromCompletedJob(ctx, undefined, { items: [], rationale: "r" }), undefined);
});
```

If a `seedPlanFixture`/`makeCtx` helper does not already exist in this test file, create a small local helper that creates a plan via `ctx.stores.seedPlans.create(...)` and, for the `approved` case, follows with `setStatus(plan.id, "approved")`. Import `ReviseSeedPlanJobInput` from `@magpie/core` and `JobView` from `@magpie/jobs`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w @magpie/api -- --test-name-pattern "SeedPlanRevision|reviseSeedPlanFromCompletedJob"`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the service functions**

In `apps/api/src/features/seed/service.ts`, add the import for the output schema to the existing `@magpie/jobs` import (`reviseSeedPlanOutputSchema`) and the core type to the `@magpie/core` import (`ReviseSeedPlanJobInput`). Then add:

```ts
// Enqueue a revise_seed_plan job to reshape a still-proposed plan by a
// natural-language instruction. Enqueue-only: the reshaped plan lands in place
// via reviseSeedPlanFromCompletedJob. NOT source-grounded — the current plan
// snapshot rides the input and the job never re-opens the flow's sources.
export async function requestSeedPlanRevision(
  ctx: AppContext,
  planId: string,
  instruction: string
): Promise<{ ok: true; jobId: string } | { ok: false; code: "plan_not_found" | "plan_not_revisable" }> {
  const plan = await ctx.stores.seedPlans.get(planId);
  if (!plan) {
    return { ok: false as const, code: "plan_not_found" as const };
  }
  if (plan.status !== "proposed") {
    return { ok: false as const, code: "plan_not_revisable" as const };
  }
  const input: ReviseSeedPlanJobInput & { provider: AiProviderName } = {
    flowId: plan.flowId,
    planId: plan.id,
    instruction,
    currentPlan: {
      items: plan.items.map((item) => ({
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.targetPath !== undefined ? { targetPath: item.targetPath } : {}),
        coverage: item.coverage,
        ...(item.questions !== undefined ? { questions: item.questions } : {})
      })),
      ...(plan.charter !== undefined ? { charter: plan.charter } : {}),
      ...(plan.persona !== undefined ? { persona: plan.persona } : {}),
      rationale: plan.rationale
    },
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("revise_seed_plan", input);
  logger.info({ jobId: job.id, planId: plan.id, flowId: plan.flowId }, "enqueued revise_seed_plan job");
  return { ok: true as const, jobId: job.id };
}

// Completion handler for revise_seed_plan: apply the reshaped plan in place.
// Only while the plan is still "proposed" — a concurrent approve/dismiss wins and
// the stale revision is dropped. Keeps the plan id, flow, origin, outlineJobId,
// sourceHash and the charter/persona *proposed provenance flags; replaces items
// (fresh proposed ids) and rationale, and charter/persona when the output carries
// them.
export async function reviseSeedPlanFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<SeedPlan | undefined> {
  if (!job || job.type !== "revise_seed_plan") {
    return undefined;
  }
  const parsed = reviseSeedPlanOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<ReviseSeedPlanJobInput>;
  if (!input.planId) {
    return undefined;
  }
  const plan = await ctx.stores.seedPlans.get(input.planId);
  if (!plan || plan.status !== "proposed") {
    if (plan) {
      logger.info({ planId: plan.id, status: plan.status }, "revise_seed_plan completion dropped: plan no longer proposed");
    }
    return undefined;
  }
  const updated = await ctx.stores.seedPlans.revise(plan.id, {
    items: parsed.data.items,
    ...(parsed.data.charter !== undefined ? { charter: parsed.data.charter } : {}),
    ...(parsed.data.persona !== undefined ? { persona: parsed.data.persona } : {}),
    rationale: parsed.data.rationale
  });
  logger.info({ planId: plan.id, flowId: plan.flowId, items: updated?.items.length }, "revised seed plan in place");
  return updated;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @magpie/api -- --test-name-pattern "SeedPlanRevision|reviseSeedPlanFromCompletedJob"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck -w @magpie/api
git add apps/api/src/features/seed/service.ts apps/api/src/features/seed/service.test.ts
git commit -m "feat(api): seed service revise enqueue + completion handler"
```

---

### Task 7: Route + completion dispatch

**Files:**
- Modify: `apps/api/src/features/seed/routes.ts` (`seedPlanRoutes`) and `apps/api/src/features/seed/schema.ts` (new body schema)
- Modify: `apps/api/src/features/jobs/service.ts` (~line 353, add the revise completion call)
- Test: `apps/api/src/features/seed/routes.test.ts`

**Interfaces:**
- Consumes: `requestSeedPlanRevision`, `reviseSeedPlanFromCompletedJob` (Task 6).
- Produces: `POST /api/seed-plans/:id/revise { instruction }` → `{ jobId }`.

- [ ] **Step 1: Write the failing route test**

In `apps/api/src/features/seed/routes.test.ts`, add (mirroring the existing approve/dismiss route tests and their auth helpers):

```ts
test("POST /seed-plans/:id/revise enqueues on a proposed plan", async () => {
  const { app, ctx } = await makeApp(); // existing helper
  const plan = await createSeedPlanFromCompletedJob(ctx, outlineJob(), { items: [{ coverage: ["c"] }], rationale: "r" });
  const res = await app.request(`/api/seed-plans/${plan!.id}/revise`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ instruction: "don't mention pricing" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.jobId === "string");
});

test("POST /seed-plans/:id/revise 400s on empty instruction and 404s on unknown plan", async () => {
  const { app } = await makeApp();
  const empty = await app.request(`/api/seed-plans/does-not-exist/revise`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ instruction: "x" })
  });
  assert.equal(empty.status, 404);
});
```

(Use the exact helper names already in `routes.test.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern "revise"`
Expected: FAIL — route returns 404 for the method/path (not mounted).

- [ ] **Step 3: Add the body schema**

In `apps/api/src/features/seed/schema.ts`, add:

```ts
// Body for revising a plan: a non-empty natural-language instruction.
export const seedPlanReviseSchema = z.object({
  instruction: z.string().trim().min(1)
});
```

- [ ] **Step 4: Add the route**

In `apps/api/src/features/seed/routes.ts`: import `requestSeedPlanRevision` from `./service.js` and `seedPlanReviseSchema` from `./schema.js`. In `seedPlanRoutes`, after the `approve` route, add:

```ts
  // Revise: enqueue a revise_seed_plan job to reshape the plan by a
  // natural-language instruction. Enqueue-only — the reshaped plan lands in
  // place via the job's completion handler. Only while proposed (409 otherwise).
  app.post(
    "/:id/revise",
    requireScopes("manage:jobs"),
    zValidator("json", seedPlanReviseSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_revise_body" }, 400);
      }
    }),
    async (c) => {
      const plan = await getSeedPlan(ctx, c.req.param("id"));
      if (!plan) {
        throw new HttpError(404, "plan_not_found");
      }
      assertCan(ctx, c, "manage", plan.flowId);
      const { instruction } = c.req.valid("json");
      const outcome = await requestSeedPlanRevision(ctx, plan.id, instruction);
      if (!outcome.ok) {
        throw new HttpError(outcome.code === "plan_not_found" ? 404 : 409, outcome.code);
      }
      return c.json({ jobId: outcome.jobId });
    }
  );
```

- [ ] **Step 5: Wire the completion dispatch**

In `apps/api/src/features/jobs/service.ts`, immediately after the `createSeedPlanFromCompletedJob` call (~line 353), add:

```ts
    // Revise completions apply the reshaped plan in place (no-op for other job
    // types; a real store failure rides the 500-replay contract below).
    await seedService.reviseSeedPlanFromCompletedJob(ctx, existingJob, resultData);
```

- [ ] **Step 6: Run route tests + full api suite**

Run: `npm test -w @magpie/api -- --test-name-pattern "revise"` then `npm test -w @magpie/api`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck -w @magpie/api
git add apps/api/src/features/seed/routes.ts apps/api/src/features/seed/schema.ts apps/api/src/features/jobs/service.ts apps/api/src/features/seed/routes.test.ts
git commit -m "feat(api): POST /seed-plans/:id/revise + completion dispatch"
```

---

### Task 8: Web — ConsoleProvider handler + SeedPanel revise block

**Files:**
- Modify: `apps/web/src/components/ConsoleProvider.tsx` (new `reviseSeedPlan` handler + return object + `apiPost` import if needed)
- Modify: `apps/web/src/components/SeedPanel.tsx` (new `onRevise` prop + revise UI + poll)
- Modify: `apps/web/src/app/seed/page.tsx` (pass `onRevise={reviseSeedPlan}`)
- Test: `apps/web/src/components/SeedPanel.test.tsx`

**Interfaces:**
- Consumes: `POST /seed-plans/:id/revise` (Task 7).
- Produces: `reviseSeedPlan(planId, instruction) → Promise<{ jobId: string } | undefined>` on the console context; `onRevise` prop on `SeedPanel`.

- [ ] **Step 1: Add the ConsoleProvider handler**

In `apps/web/src/components/ConsoleProvider.tsx`, after `dismissSeedPlan` (~line 960), add:

```ts
  // Revise a still-proposed plan by a natural-language instruction. Enqueue-only —
  // the reshaped plan lands in place; the panel polls listSeedPlans and re-hydrates
  // the same plan when its items change.
  async function reviseSeedPlan(planId: string, instruction: string): Promise<{ jobId: string } | undefined> {
    try {
      const outcome = await apiPost<{ jobId: string }>(
        `/seed-plans/${encodeURIComponent(planId)}/revise`,
        { instruction }
      );
      showMessage("Revising the plan — it will update here when the revision lands.", "info");
      return outcome;
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
    }
  }
```

Add `reviseSeedPlan,` to the returned object (after `dismissSeedPlan,` ~line 1043).

- [ ] **Step 2: Thread the prop through the page**

In `apps/web/src/app/seed/page.tsx`, add `reviseSeedPlan` to the `useConsole()` destructure and pass `onRevise={reviseSeedPlan}` to `<SeedPanel>`.

- [ ] **Step 3: Write the failing SeedPanel test**

In `apps/web/src/components/SeedPanel.test.tsx`, extend the default props with an `onRevise` mock and add a test: while a proposed plan is selected, the revise textarea + button render; typing an instruction and clicking Revise calls `onPatch` (auto-save) then `onRevise` with the instruction. Mirror the file's existing render/interaction helpers. Also assert the revise block is absent for a non-proposed plan.

- [ ] **Step 4: Run to verify it fails**

Run: `bash -lc "npm test -w @magpie/web"` (web tests need Git Bash on Windows)
Expected: FAIL — no revise control; `onRevise` not called.

- [ ] **Step 5: Implement the SeedPanel revise block**

In `apps/web/src/components/SeedPanel.tsx`:
- Add `onRevise` to the props type: `onRevise: (planId: string, instruction: string) => Promise<{ jobId: string } | undefined>;`
- Add state: `const [instruction, setInstruction] = useState("");` and a `revising` flag (reuse `busy` + a `reviseJobId` for the poll).
- Generalise the existing landing poll: add a `reviseJobId` state and, in an effect like the `planningJobId` one, poll `refreshPlans` and re-hydrate the selected plan when `updatedAt` advances past the value captured at enqueue; clear `reviseJobId`.
- Add a `revise()` handler:

```ts
  async function revise() {
    if (!selectedPlan) return;
    setBusy(true);
    try {
      // Auto-save pending pane edits so they are part of what gets reshaped.
      const saved = await onPatch(selectedPlan.id, { charter, persona, items: items.map(toItemPatch) });
      if (saved) {
        setPlans((current) => current.map((plan) => (plan.id === saved.id ? saved : plan)));
      }
      const outcome = await onRevise(selectedPlan.id, instruction.trim());
      if (outcome) {
        setReviseJobId(outcome.jobId);
        setReviseBaseline(saved?.updatedAt ?? selectedPlan.updatedAt);
        setInstruction("");
      }
    } finally {
      setBusy(false);
    }
  }
```

- Render, inside the `reviewable` block near the action buttons, a `Field` with a `Textarea` bound to `instruction` and a `Button` "Revise" (disabled when `busy`, `reviseJobId` set, or `instruction.trim()` empty). Add a short `Hint` explaining it reshapes the current plan without re-reading sources.

- [ ] **Step 6: Run the test**

Run: `bash -lc "npm test -w @magpie/web"`
Expected: PASS.

- [ ] **Step 7: Typecheck + build + commit**

```bash
npm run typecheck -w @magpie/web
git add apps/web/src/components/ConsoleProvider.tsx apps/web/src/components/SeedPanel.tsx apps/web/src/app/seed/page.tsx apps/web/src/components/SeedPanel.test.tsx
git commit -m "feat(web): revise a seed plan with an instruction from the Seed page"
```

---

### Task 9: Docs, full validation, and PR

**Files:**
- Modify: any seeding/architecture doc that enumerates the seed flow or job catalog (search for where `outline_flow_seed`/seed plans are documented, e.g. `magpie-orientation` skill job catalog or a `docs/` seeding page) — add a line for `revise_seed_plan`.

- [ ] **Step 1: Update documentation**

Search: `grep -rin "outline_flow_seed\|seed plan" docs .claude/skills` and add a short note to wherever the seed flow / job catalog is described that a proposed plan can be revised in place via `revise_seed_plan`.

- [ ] **Step 2: Full validation across the repo**

Run each and confirm PASS:
```bash
npm run build
npm test
npm run typecheck
npm run lint
npm run deadcode
```
(Run web/watcher test steps via Git Bash. Fix any knip finding by de-exporting unused symbols — do not relax the config.)

- [ ] **Step 3: Verify in the running stack (run-magpie skill)**

Follow the `run-magpie` skill to launch Postgres → migrate → API → Watcher → Web. On the Seed page, select a flow, propose (or open) a proposed plan, enter "don't mention <something in the plan>", click Revise, and confirm the plan's items update in place with that content removed. Capture a screenshot.

- [ ] **Step 4: Push + open the PR**

```bash
git push -u origin claude/reverent-clarke-fc04f7
gh pr create --title "feat: revise a seed plan with a natural-language instruction" --body "<summary + test evidence + screenshot>"
```

Draft the PR body for Adam's review before creating it (per the show-issue-text-before-posting convention): what changed, the queue-only job design, the reshape-only scope with the source-grounded follow-up seam, and validation evidence.

---

## Self-Review notes

- **Spec coverage:** job (T2), non-source-grounded prompt path (T3/T4), in-place revision keeping provenance flags (T6), proposed-only guard at request + completion (T6/T7), store replace (T5), route 404/409/400 (T7), auto-save-then-revise UI + in-place poll (T8), charter/persona in output (T1/T2/T6/T8), tests at every layer, docs + future seam (T3 prompt, T9). All covered.
- **Type consistency:** `revise(id, next)` signature identical across interface, in-memory, postgres, and service call sites; `reviseSeedPlan(planId, instruction)` identical across ConsoleProvider, page, and SeedPanel prop.
- **knip:** `requestSeedPlanRevision`/`reviseSeedPlanFromCompletedJob` are consumed by routes.ts/jobs-service.ts; `reviseSeedPlan` by page.tsx; schemas by catalog.ts + service — all consumed, no dead exports.
