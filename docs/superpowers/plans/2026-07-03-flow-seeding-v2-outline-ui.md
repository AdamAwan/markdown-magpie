# Flow seeding v2 — outline generation + web console UI — Implementation Plan

> **For agentic workers:** implement this plan task-by-task, TDD-first. Steps use checkbox
> (`- [ ]`) syntax for tracking. This extends v1 (merged); see
> [`2026-07-03-flow-seeding.md`](./2026-07-03-flow-seeding.md) and §8 of
> [`../specs/2026-07-03-flow-seeding-design.md`](../specs/2026-07-03-flow-seeding-design.md).

**Goal:** Make v1 seeding easy to drive. Two parts:

1. An `outline_flow_seed` AI job that, given a **topic** (+ optional notes) and a **flowId**,
   proposes a `SeedItem[]` (the doc list — titles + coverage) for a human to review before
   seeding. Grounded in the flow's *existing* docs via retrieval, so it proposes docs that fit
   the current structure and don't restate what's there. It only **proposes** — its output
   feeds the v1 `POST /flows/:id/seed` endpoint after approval.
2. A **web console UI** ("Seed / add an area"): pick a flow, enter a topic, **Generate
   outline** (→ `outline_flow_seed`), edit the proposed items, **Seed** (→ the v1 endpoint).

**Architecture.** `outline_flow_seed` is a provider-routed AI job (queue-only, like every other
generative step — the API enqueues, the watcher runs the model). At enqueue the API grounds it
by retrieving the flow's existing destination sections for the topic (inline embeddings, the
same mechanism `describeFlowScope` uses) and passing them as `existingDocuments` context plus the
flow persona. The job returns `{ items: SeedItem[], rationale }`; that output is stored on the
job and read back by the client via `/jobs/:id/wait`. There is **no completion side-effect** — the
outline never drafts or creates a proposal. The UI generates an outline, lets the human edit the
items, then calls the existing v1 `POST /flows/:id/seed`.

```
topic + notes → POST /flows/:id/outline → outline_flow_seed job (retrieval-grounded)
   → watcher returns { items, rationale }        [propose]
      → UI reads job output, human edits items    [review the plan]
         → POST /flows/:id/seed (v1)              [execute → proposals → PRs]
```

**Tech stack:** TypeScript (Node ESM), Zod, Hono, pg-boss, `node:test`; Next.js App Router
(apps/web), React 19, plain global CSS.

## Global Constraints

- UK English in all prose/comments/copy.
- **Queue-only:** the API never calls a chat provider inline. `outline_flow_seed` is enqueued;
  the watcher runs it. (Embeddings for the grounding retrieval are the allowed inline exception.)
- **Never cast through `unknown`/`any`** to silence types; fix them properly.
- Workspace tests via `npm test -w @magpie/<pkg>`.
- Validate as you go: `npm run build`, `npm test`, `npm run typecheck`, `npm run deadcode`
  (knip STRICT — de-export unused exports, never relax the config), `npm run lint`. Don't batch.
- Commit AND push little and often (`git push -u origin claude/flow-seeding-v2-outline-ui`).
- **New AI job checklist:** `JOB_TYPES` (types.ts); `define(...)` entry + `AI_JOB_TYPES` set
  (catalog.ts); `EXPIRATION_SECONDS` + routing test (catalog.test.ts); input/output zod schemas
  (schemas.ts); core types (core/index.ts); a watcher `buildPrompt` case (job-prompts.ts).
- **New prompt checklist:** add to `promptCatalog` (prompts/catalog.ts), bump count (**18→19**)
  and the order array in prompts/catalog.test.ts, and bump `/api/prompts` count (**18→19**) in
  apps/api/src/app.test.ts.
- **No migration** — the outline job persists nothing new; its output rides on the job record.

---

### Task 1: `outline_flow_seed` job contract + prompt (additive, no behaviour)

Adds the job type, schemas, core types, catalog entry, prompt, and watcher prompt case. Pure
additive — nothing enqueues it yet. Deliverable: the contract exists and every count/routing
test passes.

**Files:**
- Modify: `packages/core/src/index.ts` (new `ExistingDocumentContext`, `OutlineFlowSeedJobInput`,
  `OutlineFlowSeedJobOutput`, near the `SeedItem`/`DraftSeedDocument*` types ~line 710)
- Modify: `packages/jobs/src/schemas.ts` (new `outlineFlowSeedInputSchema` /
  `outlineFlowSeedOutputSchema`, next to `draftSeedDocument*`; imports)
- Modify: `packages/jobs/src/types.ts` (`JOB_TYPES`, add `"outline_flow_seed"` after
  `"draft_seed_document"`)
- Modify: `packages/jobs/src/catalog.ts` (`definitions` + `AI_JOB_TYPES`)
- Modify: `packages/jobs/src/catalog.test.ts` (`EXPIRATION_SECONDS` + routing test)
- Modify: `packages/prompts/src/catalog.ts` (new `OUTLINE_FLOW_SEED` + `promptCatalog`)
- Modify: `packages/prompts/src/catalog.test.ts` (count 18→19 + order array)
- Modify: `apps/api/src/app.test.ts` (`/api/prompts` count 18→19)
- Modify: `apps/watcher/src/job-prompts.ts` (import + `buildPrompt` case)

**Interfaces produced:**
- `ExistingDocumentContext { path: string; heading: string; excerpt: string }`
- `OutlineFlowSeedJobInput { flowId: string; topic: string; notes?: string; existingDocuments:
  ExistingDocumentContext[]; persona?: string }`
- `OutlineFlowSeedJobOutput { items: SeedItem[]; rationale: string }`
- schemas `outlineFlowSeedInputSchema` / `outlineFlowSeedOutputSchema`; job type
  `"outline_flow_seed"`; prompt `OUTLINE_FLOW_SEED`.

- [x] **Step 1: Add the routing test (failing).** In `packages/jobs/src/catalog.test.ts`, add
  `outline_flow_seed: 10 * 60,` to `EXPIRATION_SECONDS` (after the `draft_seed_document` line).
  Then, after the `draft_seed_document routes…` test:

  ```ts
  test("outline_flow_seed routes by provider like other AI work", () => {
    const definition = jobDefinition("outline_flow_seed");
    assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
    assert.equal(queueNameForJob("outline_flow_seed", { provider: "codex" }), "outline_flow_seed__codex");
    assert.ok(queueNamesForCapabilities(["codex"]).includes("outline_flow_seed__codex"));
    assert.ok(!queueNamesForCapabilities(["github"]).includes("outline_flow_seed__codex"));
  });
  ```

- [x] **Step 2: Run it — verify it fails.** `npm test -w @magpie/jobs` → FAIL (not a `JobType`;
  `EXPIRATION_SECONDS` lookup missing).

- [x] **Step 3: Add core types.** In `packages/core/src/index.ts`, after the
  `DraftSeedDocumentJobOutput` interface:

  ```ts
  // A section of an existing flow document, surfaced to the outline generator as
  // retrieval grounding so it proposes docs that fit the current structure and do
  // not restate what the knowledge base already covers.
  export interface ExistingDocumentContext {
    path: string;
    heading: string;
    excerpt: string;
  }

  // Input to the outline_flow_seed AI job: propose a SeedItem[] (a doc list, titles +
  // coverage) for `topic`, grounded in the flow's existing docs. It only PROPOSES —
  // its output feeds the v1 seed endpoint after human review. `provider` is added at
  // enqueue (see @magpie/jobs).
  export interface OutlineFlowSeedJobInput {
    flowId: string;
    topic: string;
    notes?: string;
    existingDocuments: ExistingDocumentContext[];
    persona?: string;
  }

  // Output of outline_flow_seed: the proposed seed items plus a short rationale for
  // the overall shape. The items are edited by a human before being seeded.
  export interface OutlineFlowSeedJobOutput {
    items: SeedItem[];
    rationale: string;
  }
  ```

- [x] **Step 4: Add jobs schemas.** In `packages/jobs/src/schemas.ts`, add to the `@magpie/core`
  import block: `OutlineFlowSeedJobInput as CoreOutlineFlowSeedJobInput, OutlineFlowSeedJobOutput,
  SeedItem`. After `draftSeedDocumentOutputSchema`:

  ```ts
  const existingDocumentContextSchema = z.object({
    path: z.string(),
    heading: z.string(),
    excerpt: z.string()
  });
  // The seed item shape as the model RETURNS it: coverage may be empty in raw model
  // output (a human edits before seeding, and the v1 seed endpoint enforces min(1)).
  const seedItemSchema = z.object({
    title: z.string().optional(),
    targetPath: z.string().optional(),
    coverage: z.array(z.string()),
    questions: z.array(z.string()).optional()
  }) satisfies z.ZodType<SeedItem>;
  export const outlineFlowSeedInputSchema = z.object({
    provider: providerSchema,
    flowId: z.string(),
    topic: z.string(),
    notes: z.string().optional(),
    existingDocuments: z.array(existingDocumentContextSchema),
    persona: z.string().optional()
  }) satisfies z.ZodType<ProviderInput<CoreOutlineFlowSeedJobInput>>;
  export const outlineFlowSeedOutputSchema = z.object({
    items: z.array(seedItemSchema),
    rationale: z.string()
  }) satisfies z.ZodType<OutlineFlowSeedJobOutput>;
  ```

- [x] **Step 5: Register the job type + definition + AI set.** `packages/jobs/src/types.ts` — add
  `"outline_flow_seed",` to `JOB_TYPES` immediately after `"draft_seed_document",`.
  `packages/jobs/src/catalog.ts` — in `definitions`, after the `draft_seed_document` line:

  ```ts
  outline_flow_seed: define("outline_flow_seed", "provider", schemas.outlineFlowSeedInputSchema, schemas.outlineFlowSeedOutputSchema, 10 * 60),
  ```

  …and add `"outline_flow_seed",` to the `AI_JOB_TYPES` array after `"draft_seed_document"`.

- [x] **Step 6: Run jobs tests.** `npm test -w @magpie/jobs` → PASS.

- [x] **Step 7: Add the prompt (failing prompt tests first).** In
  `packages/prompts/src/catalog.test.ts`, change `promptCatalog.length` `18` → `19` (both the
  test title and the assertion), and insert `"outline-flow-seed",` into the order array
  immediately after `"draft-seed-document"`. Run `npm test -w @magpie/prompts` → FAIL.

- [x] **Step 8: Define the prompt.** `packages/prompts/src/catalog.ts` — after
  `DRAFT_SEED_DOCUMENT`:

  ```ts
  export const OUTLINE_FLOW_SEED: PromptDefinition = {
    id: "outline-flow-seed",
    title: "Outline a seed plan for a flow",
    description:
      "Proposes a list of documents to author (each a title + the points it should cover) for a topic, grounded in the flow's existing docs so the plan fits the current structure and does not restate what is already covered. Proposes only — a human reviews and edits before seeding. Used by the watcher's outline_flow_seed job.",
    usedBy: ["watcher · flow seeding"],
    outputShape: "{ items: [{ title, targetPath?, coverage[], questions? }], rationale }",
    instructions: `You plan how to seed a Markdown knowledge base with content about a topic. You PROPOSE a list of documents to author — you do NOT write them.

Input:
- "topic": the subject area to plan coverage for.
- "notes" (optional): freeform guidance from the requester (scope, audience, must-haves).
- "existingDocuments": sections already in this flow's knowledge base (path, heading, excerpt). These show the current structure and what is already covered.
- "persona" (optional): the flow's audience/voice.

Rules:
- Return JSON only.
- Propose one entry in "items" per document worth authoring. Each is { "title", "targetPath" (optional, kebab-case), "coverage" (the points that document should cover), "questions" (optional motivating questions) }.
- Fit the EXISTING structure: do not propose a document that restates what an existing document already covers. When the topic extends an existing document, either leave it out or make the coverage explicitly about the NEW material only.
- Break the topic into cohesive, non-overlapping documents; prefer a handful of focused docs over one sprawling one. Each item's "coverage" must be specific, authorable points — not vague headings.
- Propose only what the topic and notes support. Do not invent facts; "coverage" describes what to write about, grounded in the topic, not asserted knowledge.
- "rationale" is a one-paragraph summary of the proposed shape and how it relates to the existing docs.
- UK English throughout.

Return JSON:
{
  "items": [
    { "title": "string", "targetPath": "kebab-case/path.md", "coverage": ["point", "point"], "questions": ["string"] }
  ],
  "rationale": "string"
}`
  };
  ```

  …and add `OUTLINE_FLOW_SEED,` to `promptCatalog` immediately after `DRAFT_SEED_DOCUMENT`.

- [x] **Step 9: Wire the watcher prompt + bump the API prompt count.**
  `apps/watcher/src/job-prompts.ts` — add `OUTLINE_FLOW_SEED` to the `@magpie/prompts` import and a
  case in `buildPrompt` after the `draft_seed_document` case:

  ```ts
  case "outline_flow_seed":
    return `${OUTLINE_FLOW_SEED.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
  ```

  `apps/api/src/app.test.ts` — change the `/api/prompts` count assertion `18` → `19`.

- [x] **Step 10: Run all touched package tests.**
  `npm test -w @magpie/prompts && npm test -w @magpie/jobs && npm test -w @magpie/core` → PASS.

- [x] **Step 11: Commit.**
  `git commit -m "feat(jobs): add outline_flow_seed AI job contract + prompt"`

---

### Task 2: retrieval grounding + `outlineFlowSeed` service — enqueue the outline job

Enqueue an `outline_flow_seed` job for a topic, grounding it in the flow's existing docs via
inline retrieval. Enqueue-only; the outline lands as the job's output.

**Files:**
- Modify: `apps/api/src/features/retrieve/service.ts` (new `describeExistingDocuments`)
- Modify: `apps/api/src/features/retrieve/service.test.ts` (if present) — or a new colocated test
- Modify: `apps/api/src/features/proposals/service.ts` (new `outlineFlowSeed`)
- Test: `apps/api/src/features/proposals/service.test.ts`

**Interfaces:**
- Produces: `describeExistingDocuments(ctx, flowId, query, limit?): Promise<ExistingDocumentContext[]>`;
  `outlineFlowSeed(ctx, flowId, { topic, notes }): Promise<{ ok: true; jobId: string } | { ok: false; code: string }>`.
- Consumes: `ctx.stores.knowledgeIndex.search`, `selectFlow`, `ctx.jobs.create("outline_flow_seed", …)`.

- [x] **Step 1: `describeExistingDocuments`.** In `apps/api/src/features/retrieve/service.ts`,
  mirror `describeFlowScope` (same `resolveRepositoryScope`, no relevance floor so the model always
  sees the closest structure). Map ranked sections to `{ path, heading, excerpt }` (excerpt capped,
  reuse the `SCOPE_SNIPPET_CHARS` idea). Return `[]` (via a guard) for an unknown flow rather than
  throwing — the caller already validated the flow, this is just grounding. Signature:

  ```ts
  export async function describeExistingDocuments(
    ctx: AppContext,
    flowId: string | undefined,
    query: string,
    limit = 8
  ): Promise<ExistingDocumentContext[]>
  ```

  Import `ExistingDocumentContext` from `@magpie/core`.

- [x] **Step 2: Failing test for `outlineFlowSeed`.** Append to
  `apps/api/src/features/proposals/service.test.ts` (match its imports / `makeTestContext` and the
  configured test flow id used by the seed tests):

  ```ts
  test("outlineFlowSeed enqueues an outline_flow_seed job carrying flowId + topic", async () => {
    const ctx = makeTestContext();
    const flowId = /* the configured test flow id */;
    const result = await proposals.outlineFlowSeed(ctx, flowId, { topic: "Billing", notes: "focus on refunds" });
    assert.ok(result.ok);
    const jobs = (await ctx.jobs.list({ type: "outline_flow_seed" })).jobs;
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0].input as { flowId?: string }).flowId, flowId);
    assert.equal((jobs[0].input as { topic?: string }).topic, "Billing");
    assert.equal((jobs[0].input as { notes?: string }).notes, "focus on refunds");
    assert.ok(Array.isArray((jobs[0].input as { existingDocuments?: unknown[] }).existingDocuments));
    assert.equal(result.jobId, jobs[0].id);
  });

  test("outlineFlowSeed rejects an unknown flow", async () => {
    const ctx = makeTestContext();
    const result = await proposals.outlineFlowSeed(ctx, "no-such-flow", { topic: "x" });
    assert.equal(result.ok, false);
  });

  test("outlineFlowSeed rejects an empty topic", async () => {
    const ctx = makeTestContext();
    const flowId = /* the configured test flow id */;
    const result = await proposals.outlineFlowSeed(ctx, flowId, { topic: "   " });
    assert.equal(result.ok, false);
  });
  ```

- [x] **Step 3: Run it — verify it fails.**
  `npm test -w @magpie/api -- --test-name-pattern="outlineFlowSeed"` → FAIL (not exported).

- [x] **Step 4: Implement `outlineFlowSeed`.** In `apps/api/src/features/proposals/service.ts`, add
  `OutlineFlowSeedJobInput` to the `@magpie/core` import and import `describeExistingDocuments` from
  `../retrieve/service.js`, then:

  ```ts
  // Propose a seed outline for a topic: enqueue an outline_flow_seed job grounded in the
  // flow's existing docs (retrieved inline for the topic) so the model proposes a doc list
  // that fits the current structure. Enqueue-only — the proposed SeedItem[] lands as the
  // job's output; a human reviews/edits it, then the v1 seed endpoint executes it. Bypasses
  // the gap pipeline entirely, like the rest of seeding.
  export async function outlineFlowSeed(
    ctx: AppContext,
    flowId: string,
    request: { topic: string; notes?: string }
  ): Promise<{ ok: true; jobId: string } | { ok: false; code: string }> {
    const flow = selectFlow(ctx.repositoryDeps(), flowId);
    if (!flow) {
      return { ok: false as const, code: "flow_not_found" };
    }
    const topic = request.topic.trim();
    if (topic.length === 0) {
      return { ok: false as const, code: "topic_required" };
    }
    const existingDocuments = await describeExistingDocuments(ctx, flowId, topic);
    const input: OutlineFlowSeedJobInput & { provider: AiProviderName } = {
      flowId,
      topic,
      notes: request.notes?.trim() || undefined,
      existingDocuments,
      persona: flow.persona,
      provider: ctx.config.get().aiProvider
    };
    const job = await ctx.jobs.create("outline_flow_seed", input);
    logger.info({ jobId: job.id, flowId, existingDocs: existingDocuments.length }, "enqueued outline_flow_seed job");
    return { ok: true as const, jobId: job.id };
  }
  ```

  (Confirm `flow.persona` exists on the selectFlow result; if it's `persona?: string`, the optional
  assignment is fine — omit the key when absent to keep the payload clean, matching how the codebase
  spreads optional fields.)

- [x] **Step 5: Run it — verify it passes.**
  `npm test -w @magpie/api -- --test-name-pattern="outlineFlowSeed"` → PASS.

- [x] **Step 6: Commit.**
  `git commit -m "feat(seeding): outlineFlowSeed enqueues a retrieval-grounded outline job"`

---

### Task 3: `POST /api/flows/:flowId/outline` endpoint

Expose outline generation over HTTP, on the same seed router, with the same scope/auth/404-hiding
as `POST /flows/:flowId/seed`.

**Files:**
- Modify: `apps/api/src/features/seed/schema.ts` (new `outlineBodySchema`)
- Modify: `apps/api/src/features/seed/routes.ts` (add the `POST /:flowId/outline` route)
- Test: `apps/api/src/features/seed/routes.test.ts` (extend it) — or `app.test.ts`

**Interfaces:**
- Consumes: `outlineFlowSeed` (Task 2); `requireScopes("manage:jobs")`, `assertCan`, `HttpError`,
  `zValidator`.
- Produces: `POST /api/flows/:flowId/outline` → `{ ok: true, jobId }`.

- [x] **Step 1: Body schema.** In `apps/api/src/features/seed/schema.ts`:

  ```ts
  export const outlineBodySchema = z.object({
    topic: z.string().min(1),
    notes: z.string().optional()
  });
  ```

- [x] **Step 2: Failing route test.** In `apps/api/src/features/seed/routes.test.ts` (mirror the
  seed route tests): a valid POST returns `{ ok: true, jobId }`; an unknown/unauthorised `:flowId`
  → 404; an empty `topic` → 400.

- [x] **Step 3: Run it — verify it fails.**
  `npm test -w @magpie/api -- --test-name-pattern="outline"` → FAIL.

- [x] **Step 4: Implement the route.** In `apps/api/src/features/seed/routes.ts`, import
  `outlineFlowSeed` and `outlineBodySchema`, then add before `return app;`:

  ```ts
  app.post(
    "/:flowId/outline",
    requireScopes("manage:jobs"),
    zValidator("json", outlineBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_outline_body" }, 400);
      }
    }),
    async (c) => {
      const flowId = c.req.param("flowId");
      if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === flowId)) {
        throw new HttpError(404, "flow_not_found");
      }
      assertCan(ctx, c, "manage", flowId);
      const { topic, notes } = c.req.valid("json");
      const outcome = await outlineFlowSeed(ctx, flowId, { topic, notes });
      if (!outcome.ok) {
        throw new HttpError(outcome.code === "flow_not_found" ? 404 : 400, outcome.code);
      }
      return c.json({ ok: true, jobId: outcome.jobId });
    }
  );
  ```

- [x] **Step 5: Run it — verify it passes.**
  `npm test -w @magpie/api -- --test-name-pattern="outline|seed route"` → PASS.

- [x] **Step 6: Commit.**
  `git commit -m "feat(seeding): POST /flows/:id/outline endpoint"`

---

### Task 4: Web console UI — "Seed / add an area" form

A new admin page: pick a flow, enter a topic (+ notes), **Generate outline** (→ outline job,
polled to completion), edit the proposed items in an editable list, **Seed** (→ v1 endpoint).
Follows the ConsoleProvider-owns-handlers / presentational-panel pattern.

**Files:**
- Modify: `apps/web/src/lib/types.ts` (add `"seed"` to the `ConsoleSection` union; add `SeedItem` /
  outline response types if not importable from `@magpie/core`)
- Modify: `apps/web/src/lib/sections.ts` (`SECTION_NAV` entry)
- Modify: `apps/web/src/components/ConsoleProvider.tsx` (`generateOutline` + `seedFlow` handlers,
  expose via context)
- Create: `apps/web/src/components/SeedPanel.tsx`
- Create: `apps/web/src/app/seed/page.tsx`
- Modify: `apps/web/src/app/styles.css` only if a new class is genuinely needed (prefer existing:
  `surface`, `field`, `button`, `pill`, `hint`, `empty`)
- Test: `apps/web/src/components/SeedPanel.test.tsx`

**Interfaces:**
- `generateOutline(flowId, topic, notes): Promise<SeedItem[]>` — POSTs `/flows/:id/outline`, polls
  `/jobs/:id/wait` to terminal, returns `job.output.items` (or throws with the job error).
- `seedFlow(flowId, items): Promise<string[]>` — POSTs `/flows/:id/seed`, returns `jobIds`.
- `SeedPanel` props: `flows`, `loading`, `onGenerate`, `onSeed` (+ whatever local editing state
  it owns internally).

- [x] **Step 1: Types + nav.** Add `"seed"` to `ConsoleSection` in `lib/types.ts`. Add to
  `SECTION_NAV` in `lib/sections.ts` (group 1, near proposals):
  `{ section: "seed", path: "/seed", glyph: "Se", label: "Seed", group: 1 }`.

- [x] **Step 2: Provider handlers.** In `ConsoleProvider.tsx`, add `generateOutline` and `seedFlow`
  following the `indexRepository` / `submitQuestion` shape (set loading, clearMessage, try/catch →
  showMessage + refresh). `generateOutline` must **loop `waitForJob` until terminal** (the bounded
  `/jobs/:id/wait` can return a still-active job when its deadline elapses) and then read
  `job.output` — surface `job.error` as a danger message if the job failed. Expose both on the
  context value and its type.

  ```ts
  async function generateOutline(flowId: string, topic: string, notes: string): Promise<SeedItem[]> {
    const { jobId } = await apiPost<{ ok: boolean; jobId: string }>(`/flows/${flowId}/outline`, { topic, notes: notes || undefined });
    let job = await waitForJob({ id: jobId });
    while (job.state !== "completed" && job.state !== "failed" && job.state !== "cancelled") {
      job = await waitForJob({ id: jobId });
    }
    if (job.state !== "completed") {
      throw new Error(job.error?.message ?? "Outline generation did not complete.");
    }
    return (job.output as { items?: SeedItem[] } | undefined)?.items ?? [];
  }
  ```

  (Keep the message/refresh bookkeeping in the panel or provider consistent with the other
  handlers; the panel calls these and renders the returned items into an editable list.)

- [x] **Step 3: `SeedPanel` + page.** Build `SeedPanel.tsx`: a flow `<select>` (from `flows`), a
  topic `<input>` + notes `<textarea>`, a **Generate outline** button (disabled while generating or
  when topic empty). On success it renders the returned items as an editable list — each row: title
  input, targetPath input, coverage (one point per line in a textarea, or add/remove rows),
  optional questions — plus **add item** / **remove item**. A **Seed** button (disabled unless ≥1
  item has ≥1 non-empty coverage point) calls `onSeed(flowId, items)` and shows the returned job
  count. `app/seed/page.tsx` is the thin `"use client"` wrapper reading from `useConsole()`.

- [x] **Step 4: Test.** `SeedPanel.test.tsx` — `renderToStaticMarkup` with stub `flows` +
  `onGenerate`/`onSeed`; assert the heading, the flow options, the topic field, and the disabled
  Generate button render. (Static markup can't exercise the async edit flow; keep it to structure,
  matching `SchedulesPanel.test.tsx`.)

- [x] **Step 5: Run web tests + build.**
  `npm test -w @magpie/web && npm run build -w @magpie/web` → PASS.

- [x] **Step 6: Commit.**
  `git commit -m "feat(web): Seed / add an area console form (generate outline → edit → seed)"`

---

### Task 5: Docs + full-suite gates + branch finish

- [x] **Step 1: Document the job + the outline path.** Add `outline_flow_seed` to
  [`docs/ai-jobs.md`](../../ai-jobs.md) (job list + one-line description). Extend the "Seeding a
  flow" section (added in v1) with the v2 outline step: topic → `outline_flow_seed` (retrieval-
  grounded, proposes `SeedItem[]`) → human review in the console → v1 `POST /flows/:id/seed`. Note
  the console "Seed" page. Cross-link this plan and §8 of the design spec.

- [x] **Step 2: Full API + web suites.** `npm test -w @magpie/api && npm test -w @magpie/web` →
  PASS. (Known unrelated local-only failures — a Windows path-separator watcher test; a web
  test-glob quirk — pass on CI Linux; investigate any OTHER failure.)

- [x] **Step 3: Typecheck + deadcode + lint + whole-repo tests.**
  `npm run typecheck && npm run deadcode && npm run lint && npm test` → PASS. If knip flags a new
  export as unused, confirm it is consumed (`outlineFlowSeed` by the route; `describeExistingDocuments`
  by `outlineFlowSeed`; `outlineFlowSeedOutputSchema` by the catalog); if genuinely unused,
  de-export — never relax the knip config.

- [x] **Step 4: Finish the branch.** Push to `claude/flow-seeding-v2-outline-ui`. Do not open a PR
  unless asked. Both this plan and any doc updates ship on the branch.

---

## Self-Review

**Spec coverage (§8):**
- `outline_flow_seed` AI job (topic + notes + flowId → `SeedItem[]`), full new-AI-job checklist →
  Task 1. ✓
- Retrieval-grounded in the flow's existing docs → Task 2 (`describeExistingDocuments`). ✓
- Proposes only; feeds the v1 endpoint after approval (no completion side-effect) → Tasks 2–4. ✓
- API endpoint to trigger it → Task 3. ✓
- Web console "Seed / add an area" form (pick flow → topic → Generate outline → edit → Seed) →
  Task 4. ✓

**Queue-only:** the API enqueues `outline_flow_seed`; the watcher runs the model. The only inline
provider work is the grounding retrieval's embeddings (the documented exception). ✓

**No new migration:** the outline job's output rides on the job record (read via `/jobs/:id/wait`),
so nothing new is persisted. ✓

**Type consistency:** `outline_flow_seed` / `outlineFlowSeedInputSchema` /
`outlineFlowSeedOutputSchema` / `OutlineFlowSeedJobInput` / `OutlineFlowSeedJobOutput` /
`ExistingDocumentContext` / `outlineFlowSeed` / `describeExistingDocuments` used identically across
tasks. `SeedItem` reused from `@magpie/core`.

**Placeholder notes:** the configured test flow id (Task 2 Step 2) and `flow.persona`'s exact
optionality (Task 2 Step 4) are left for the implementer to confirm against the real test context /
`selectFlow` result rather than guessed.
