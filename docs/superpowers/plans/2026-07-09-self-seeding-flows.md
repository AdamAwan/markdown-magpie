# Self-Seeding Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seeding starts from the sources: `outline_flow_seed` becomes a source-grounded agentic job that explores the flow's source repos and proposes a complete document plan (plus a charter/persona when the flow lacks one); plans persist in a new `seed_plans` table awaiting console review; approval drafts each item through the existing `draft_seed_document` → proposal → PR pipeline; a new `seed_bootstrap` maintenance job auto-proposes a plan for any flow with sources but a near-empty KB.

**Architecture:** The outline job joins the source-grounded set (`sourceGroundedInputSchema()` switch — that one switch routes it through the CLI/native and HTTP/tool-loop agentic paths automatically). Its completion handler persists a `SeedPlan` (idempotent on job id, superseding older un-reviewed plans). Plan review endpoints live in the existing `features/seed` module; approve enqueues `draft_seed_document` per approved item carrying the plan's run-scoped charter/persona and `seedPlanId` (read back at draft completion to link the proposal). `seed_bootstrap` follows the patrol pattern: maintenance-capability job → thin API endpoint → guards → enqueue. Charter/persona stay config-only durable (`KNOWLEDGE_FLOWS`); the system never writes flow config.

**Tech Stack:** TypeScript ESM/NodeNext, node:test, zod, Hono, pg-boss, custom SQL migrator, Emotion CSS-in-JS (web), MCP (apps/mcp).

**Spec:** `docs/superpowers/specs/2026-07-09-self-seeding-flows-design.md`. Branch: `claude/priceless-cerf-6223c8` (main is PR-protected — never push main).

## Global Constraints

- The API never calls a chat/generative provider inline. Everything generative here is the existing queue path; the new endpoints only enqueue.
- Never cast through `unknown`/`any` to silence types. No hacky workarounds.
- Relative imports need explicit `.js` extensions, even from `.ts` sources.
- Validate as you go: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`. DB-backed tests: `npm run test:db` (never run full root `npm test` expecting apps/mcp HTTP tests to pass in a sandbox — run per-workspace, e.g. `npm test -w @magpie/api`).
- Commit and push little and often (on the feature branch).
- Migrations: append-only, `NNNN_snake_case.sql`; next free prefix is **0051** at time of writing — re-check `ls packages/db/migrations | sort | tail -1` before creating.
- Broker gotcha: any new field on a job output MUST be declared on the zod output schema in `@magpie/jobs` or the broker strips it before the API's completion handler sees it (`mapUpdates`/`uncoveredPoints`/`provenance` precedent in `packages/jobs/src/schemas.ts`).
- Fields the completion side needs from the *input* (e.g. `seedPlanId`, `origin`, `charter`) are read back off the stored job input — the `triggeringQuestionIds` precedent — so they must be on the input schema too.
- UK English in all prompt text and UI copy.
- Web: style with the `src/components/ui` primitives + colocated Emotion `styled`; never add a `.css` file.

---

### Task 1: Contracts — core types, jobs schemas, flow-config `charter`

**Files:**
- Modify: `packages/core/src/index.ts` (SeedItem block ~line 848; `DraftSeedDocumentJobInput` ~903; `ExistingDocumentContext` ~930; `OutlineFlowSeedJobInput/Output` ~940; new `SeedPlan` types after `SeedItem`)
- Modify: `packages/jobs/src/schemas.ts` (~222–267: `draftSeedDocumentInputSchema`, `outlineFlowSeedInputSchema/OutputSchema`)
- Modify: `apps/api/src/stores/knowledge-repositories.ts` (interface ~line 22, parser ~line 213)
- Test: `packages/jobs/src/schemas.test.ts`, `apps/api/src/stores/knowledge-repositories.test.ts`

**Interfaces (produced — every later task consumes these):**

```ts
// packages/core/src/index.ts

// ExistingDocumentContext.excerpt becomes optional: the whole-flow lister (Task 4)
// supplies path+heading only; the retrieval-scored variant keeps excerpts.
export interface ExistingDocumentContext {
  path: string;
  heading: string;
  excerpt?: string;
}

// Reworked: source-grounded whole-flow planning. topic is GONE; notes is the
// optional human steer. origin records what triggered the run. charter is the
// flow's coverage mission (config), distinct from persona (voice) and
// routingSummary (router blurb) — all optional; when charter/persona are absent
// the model proposes them (see output).
export interface OutlineFlowSeedJobInput {
  flowId: string;
  origin: "manual" | "auto";
  notes?: string;
  sources: SourceDescriptor[];
  existingDocuments: ExistingDocumentContext[];
  persona?: string;
  charter?: string;
  routingSummary?: string;
}

export interface OutlineFlowSeedJobOutput {
  items: SeedItem[];
  rationale: string;
  // Proposed only when the input lacked charter/persona. Never written to flow
  // config by the system — surfaced in the console with a copy-to-config hint
  // and carried run-scoped on the seed plan.
  proposedCharter?: string;
  proposedPersona?: string;
  mapUpdates?: SourceMapUpdate[];
}

// DraftSeedDocumentJobInput gains run-scoped shaping + the plan linkage the
// completion handler reads back (triggeringQuestionIds precedent):
export interface DraftSeedDocumentJobInput {
  flowId: string;
  title?: string;
  targetPath?: string;
  coverage: string[];
  questions?: string[];
  sources: SourceDescriptor[];
  destinationId?: string;
  charter?: string;
  persona?: string;
  seedPlanId?: string;
}

// Persisted seed plan (new). Item ids are stable uuids so PATCH edits and
// approve-replay address items unambiguously.
export type SeedPlanStatus = "proposed" | "approved" | "dismissed" | "superseded";
export type SeedPlanItemStatus = "proposed" | "approved" | "dismissed";
export interface SeedPlanItem extends SeedItem {
  id: string;
  status: SeedPlanItemStatus;
  // Set when approval enqueued this item's draft job; replay skips items that
  // already have one (idempotent partial-approve recovery).
  draftJobId?: string;
}
export interface SeedPlan {
  id: string;
  flowId: string;
  status: SeedPlanStatus;
  origin: "manual" | "auto";
  // Run-scoped charter/persona: flow config's when set, else the model's
  // proposal, as later edited by the reviewer. *Proposed flags record that the
  // value came from the model (drives the copy-to-config hint in the console).
  charter?: string;
  persona?: string;
  charterProposed: boolean;
  personaProposed: boolean;
  items: SeedPlanItem[];
  rationale: string;
  notes?: string;
  outlineJobId: string;
  // hashSourceDescriptors() of the input sources — the bootstrap dismissal
  // guard compares this against the flow's current sources.
  sourceHash: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}
```

```ts
// apps/api/src/stores/knowledge-repositories.ts — flow entry (~line 22) gains:
  charter?: string;
// parser (~line 213) gains, alongside persona/routingSummary:
  const charter = stringValue(candidate.charter);
// and spreads `...(charter ? { charter } : {})` into the flow object (~line 220).
```

- [ ] **Step 1: Write the failing schema tests**

Add to `packages/jobs/src/schemas.test.ts` (follow the existing strip-protection test style):

```ts
test("outline_flow_seed input carries sources/charter/origin; topic is gone", () => {
  const input = {
    provider: "codex",
    flowId: "flow-1",
    origin: "auto",
    notes: "focus on operator-facing behaviour",
    sources: [{ id: "src-1", name: "Repo", kind: "git", url: "https://example.com/r.git" }],
    existingDocuments: [{ path: "a.md", heading: "A" }],
    persona: "site reliability engineers",
    charter: "Everything an operator needs to run the service",
    routingSummary: "operations"
  };
  const parsed = outlineFlowSeedInputSchema.safeParse(input);
  assert.ok(parsed.success);
  assert.equal(parsed.success ? parsed.data.origin : undefined, "auto");
  assert.ok(!outlineFlowSeedInputSchema.safeParse({ ...input, origin: "cron" }).success);
  assert.ok(!("topic" in outlineFlowSeedInputSchema.shape));
});

test("outline_flow_seed output keeps proposedCharter/proposedPersona/mapUpdates (broker-strip protection)", () => {
  const output = {
    items: [{ title: "Runbook", coverage: ["how to restart"] }],
    rationale: "r",
    proposedCharter: "Cover operational runbooks",
    proposedPersona: "on-call engineers",
    mapUpdates: [{ sourceId: "src-1", topic: "restarts", paths: ["ops/restart.md"], description: "d" }]
  };
  const parsed = outlineFlowSeedOutputSchema.safeParse(output);
  assert.ok(parsed.success);
  assert.equal(parsed.success ? parsed.data.proposedCharter : undefined, output.proposedCharter);
  assert.deepEqual(parsed.success ? parsed.data.mapUpdates : undefined, output.mapUpdates);
  assert.ok(outlineFlowSeedOutputSchema.safeParse({ items: [], rationale: "r" }).success, "proposals stay optional");
});

test("draft_seed_document input keeps charter/persona/seedPlanId (input read-back protection)", () => {
  const input = {
    provider: "codex",
    flowId: "flow-1",
    coverage: ["c"],
    sources: [],
    charter: "Cover operational runbooks",
    persona: "on-call engineers",
    seedPlanId: "plan-1"
  };
  const parsed = draftSeedDocumentInputSchema.safeParse(input);
  assert.ok(parsed.success);
  assert.equal(parsed.success ? parsed.data.seedPlanId : undefined, "plan-1");
});
```

Add to `apps/api/src/stores/knowledge-repositories.test.ts`, next to the existing persona/routingSummary parser tests:

```ts
test("flow parser reads charter", () => {
  // Follow the surrounding tests' construction of a KNOWLEDGE_FLOWS candidate —
  // add `charter: "Cover everything an operator needs"` and assert it round-trips,
  // and that an absent charter yields no key (exact-shape spread pattern).
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w @magpie/jobs && npm test -w @magpie/api`. Expected: FAIL (unknown keys stripped / `origin` missing / `topic` required).

- [ ] **Step 3: Implement**

In `packages/core/src/index.ts`: apply the interface changes from the Interfaces block above (replace `OutlineFlowSeedJobInput/Output` bodies, extend `DraftSeedDocumentJobInput`, make `excerpt` optional, add the `SeedPlan*` types with the comments shown).

In `packages/jobs/src/schemas.ts` (~222–267):

```ts
export const draftSeedDocumentInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  title: z.string().optional(),
  targetPath: z.string().optional(),
  coverage: z.array(z.string()),
  questions: z.array(z.string()).optional(),
  sources: z.array(sourceDescriptorSchema),
  destinationId: z.string().optional(),
  // Run-scoped shaping from the seed plan; seedPlanId is read back at completion
  // to link the proposal (triggeringQuestionIds precedent) — must be on the
  // schema or the broker strips it.
  charter: z.string().optional(),
  persona: z.string().optional(),
  seedPlanId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreDraftSeedDocumentJobInput>>;

const existingDocumentContextSchema = z.object({
  path: z.string(),
  heading: z.string(),
  excerpt: z.string().optional()
});

export const outlineFlowSeedInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  origin: z.enum(["manual", "auto"]),
  notes: z.string().optional(),
  sources: z.array(sourceDescriptorSchema),
  existingDocuments: z.array(existingDocumentContextSchema),
  persona: z.string().optional(),
  charter: z.string().optional(),
  routingSummary: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreOutlineFlowSeedJobInput>>;
export const outlineFlowSeedOutputSchema = z.object({
  items: z.array(seedItemSchema),
  rationale: z.string(),
  // Proposed only when the flow lacked them; must be declared or the broker
  // strips them before the plan-creation handler reads them.
  proposedCharter: z.string().optional(),
  proposedPersona: z.string().optional(),
  mapUpdates: mapUpdatesField
}) satisfies z.ZodType<OutlineFlowSeedJobOutput>;
```

In `apps/api/src/stores/knowledge-repositories.ts`: add `charter?: string;` to the flow interface with a comment (`// Coverage mission for seeding/planning prompts — what this KB should cover. Distinct from persona (voice) and routingSummary (router blurb).`) and parse/spread it as shown in the Interfaces block.

- [ ] **Step 4: Fix the compile fallout in the same commit.** `npm run typecheck` will flag every consumer of the old outline contract; adjust only *signatures/construction sites* here (real behaviour changes land in their own tasks): `apps/api/src/features/seed/service.ts` + `schema.ts` (Task 4 rewrites these — make the minimal edit that compiles: build `origin: "manual"`, `sources: []` placeholder is NOT acceptable; instead reorder Task 4's `outlineFlowSeed` service rewrite into this step if the typecheck cannot otherwise pass honestly), `apps/watcher/src/job-prompts.test.ts`/`runners/*.test.ts` fixtures, `apps/mcp/src/kb-client.ts` (Task 8 rewrites; minimal compile fix here), `apps/web` (`ConsoleProvider.tsx` — Task 7). Prefer pulling the small service rewrite forward over inventing throwaway stubs.

- [ ] **Step 5: Run to verify pass** — `npm run build && npm run typecheck && npm test -w @magpie/jobs && npm test -w @magpie/api`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(contracts): source-grounded outline_flow_seed contract, flow charter, seed-plan types"` and push.

---

### Task 2: Watcher + prompt — outline joins the source-grounded set

**Files:**
- Modify: `apps/watcher/src/source-workspace.ts` (~line 43 `sourceGroundedInputSchema` switch)
- Modify: `packages/prompts/src/catalog.ts` (~line 217 `OUTLINE_FLOW_SEED`)
- Modify: `apps/api/src/features/source-map/service.ts` (`SOURCE_GROUNDED_JOB_TYPES` set near the top — outline outputs now carry `mapUpdates`)
- Test: `apps/watcher/src/source-workspace.test.ts`, `packages/prompts/src/catalog.test.ts` (if prompt invariants are asserted there), `apps/api/src/features/source-map/service.test.ts`

**Interfaces:**
- Consumes: `outlineFlowSeedInputSchema` (Task 1).
- Produces: `sourceDescriptorsOf(job)` returns the outline job's sources → both `runners/chat.ts` and `runners/cli.ts` route it down their agentic paths with no further change (they key solely off that function). `applySourceMapUpdatesFromCompletedJob` accepts outline completions.

- [ ] **Step 1: Write the failing tests**

In `apps/watcher/src/source-workspace.test.ts`, alongside the existing `sourceDescriptorsOf` cases:

```ts
test("sourceDescriptorsOf returns sources for outline_flow_seed", () => {
  const sources = [{ id: "s1", name: "Repo", kind: "git" as const, url: "https://example.com/r.git" }];
  const job = jobView({
    type: "outline_flow_seed",
    input: {
      provider: "codex", flowId: "f1", origin: "manual",
      sources, existingDocuments: []
    }
  });
  assert.deepEqual(sourceDescriptorsOf(job), sources);
});
```

(Use the file's existing job-fixture helper; if it's named differently, follow it.)

In `apps/api/src/features/source-map/service.test.ts`: copy the existing "applies mapUpdates from a completed source-grounded job" case with `type: "outline_flow_seed"` and assert the update lands.

- [ ] **Step 2: Run to verify failure** — `npm test -w @magpie/watcher && npm test -w @magpie/api`. Expected: FAIL (empty descriptors / update ignored).

- [ ] **Step 3: Implement**

`apps/watcher/src/source-workspace.ts` — add to the switch:

```ts
    case "outline_flow_seed":
      return outlineFlowSeedInputSchema;
```

(import it from `@magpie/jobs`). Update the comment above the five-type list (and the count) — it is quoted in the orientation skill and docs, which Task 9 updates.

`apps/api/src/features/source-map/service.ts` — add `"outline_flow_seed"` to `SOURCE_GROUNDED_JOB_TYPES`.

`packages/prompts/src/catalog.ts` — replace `OUTLINE_FLOW_SEED` wholesale:

```ts
export const OUTLINE_FLOW_SEED: PromptDefinition = {
  id: "outline-flow-seed",
  title: "Plan the seed coverage for a flow",
  description:
    "Explores a flow's source repositories and proposes the complete list of documents its knowledge base needs (each a title + the points it should cover), fitted to the flow's existing docs. When the flow lacks a charter or persona it proposes one from what it found. Proposes only — a human reviews the persisted plan before anything is drafted. Used by the watcher's outline_flow_seed job.",
  usedBy: ["watcher · flow seeding"],
  outputShape:
    "{ items: [{ title, targetPath?, coverage[], questions? }], rationale, proposedCharter?, proposedPersona?, mapUpdates? }",
  instructions: `You plan how to seed a Markdown knowledge base, grounded in the source repositories you have been given access to. You PROPOSE a complete list of documents to author — you do NOT write them.

Input:
- "charter" (optional): what this knowledge base should cover — your scope. When present, plan to it.
- "persona" (optional): the audience/voice of the flow.
- "routingSummary" (optional): a one-line topical blurb for the flow.
- "notes" (optional): freeform guidance from the requester for THIS run.
- "existingDocuments": documents already in this flow's knowledge base (path, heading, sometimes an excerpt). These show what is already covered.
- "origin": whether a human requested this run ("manual") or the system proposed it for a sparse flow ("auto").

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them: list directories to learn the structure, search broadly, open the files that matter, and follow references. Do not stop at the first area you find — the plan should reflect the WHOLE corpus that falls inside the scope, not one topic.
- Every proposed item's "coverage" must name specific, authorable points grounded in files you actually read — not vague headings and not invented facts.

Scope:
- When "charter" is given, it defines what is in scope. Propose nothing outside it.
- When "charter" is absent, derive the scope yourself from the sources, the flow's name/persona/routingSummary, and "notes" — and return it as "proposedCharter": 2–4 sentences stating what this knowledge base should cover and for whom. A human will edit it.
- When "persona" is absent, also return "proposedPersona": one sentence naming the audience and voice.

Rules:
- Return JSON only.
- Propose one entry in "items" per document worth authoring. Each is { "title", "targetPath" (optional, kebab-case), "coverage" (the points that document should cover), "questions" (optional motivating questions) }.
- Fit the EXISTING structure: do not propose a document that restates what an existing document already covers. When new material extends an existing document, make the coverage explicitly about the NEW material only.
- Break the corpus into cohesive, non-overlapping documents; prefer focused docs over sprawling ones. Order items most-important-first.
- "rationale" is a one-paragraph summary of the proposed shape, how it relates to the existing docs, and anything in scope you deliberately left out.

${SOURCE_MAP_CONTRACT}

- UK English throughout.

Return JSON:
{
  "items": [
    { "title": "string", "targetPath": "kebab-case/path.md", "coverage": ["point", "point"], "questions": ["string"] }
  ],
  "rationale": "string",
  "proposedCharter": "string (only when no charter was given)",
  "proposedPersona": "string (only when no persona was given)",
  "mapUpdates": [
    { "sourceId": "string", "topic": "string", "paths": ["string"], "description": "string" }
  ]
}`
};
```

(Confirm `SOURCE_MAP_CONTRACT` is already imported/defined in that file — it is used by the other source-grounded prompts.)

- [ ] **Step 4: Run to verify pass** — `npm test -w @magpie/watcher && npm test -w @magpie/api && npm test -w @magpie/prompts && npm run typecheck`. Expected: PASS (fix any prompt-catalog snapshot/invariant tests that assert the old outline text).

- [ ] **Step 5: Commit** — `git commit -am "feat(watcher,prompts): outline_flow_seed becomes source-grounded whole-flow planning"` and push.

---

### Task 3: Migration 0051 + seed-plan store

**Files:**
- Create: `packages/db/migrations/0051_seed_plans.sql`
- Create: `apps/api/src/stores/seed-plan-store.ts` (interface + in-memory)
- Create: `apps/api/src/stores/postgres-seed-plan-store.ts`
- Modify: `apps/api/src/context.ts` (~lines 49–55 store types, ~138–144 wiring)
- Modify: `apps/api/src/stores/postgres-knowledge-store.ts` / proposal store: persist `Proposal.seedPlanId` (follow the `provenance` column plumbing from migration 0049 — find it with `grep -rn provenance apps/api/src/stores/*proposal*`)
- Modify: `packages/core/src/index.ts` (`Proposal` gains `seedPlanId?: string;` next to `jobId`)
- Test: `apps/api/src/stores/seed-plan-store.test.ts`, `apps/api/src/stores/postgres-seed-plan-store.test.ts` (integration, `RUN_PG_INTEGRATION`-gated per the writing-magpie-tests skill)

**Interfaces:**
- Produces:

```ts
// apps/api/src/stores/seed-plan-store.ts
import type { SeedPlan, SeedPlanItem, SeedPlanStatus } from "@magpie/core";

export interface NewSeedPlan {
  flowId: string;
  origin: "manual" | "auto";
  charter?: string;
  persona?: string;
  charterProposed: boolean;
  personaProposed: boolean;
  items: Omit<SeedPlanItem, "id" | "status" | "draftJobId">[];
  rationale: string;
  notes?: string;
  outlineJobId: string;
  sourceHash: string;
}

export interface SeedPlanItemPatch {
  id: string;
  title?: string;
  targetPath?: string;
  coverage?: string[];
  questions?: string[];
  status?: "proposed" | "approved" | "dismissed";
}

export interface SeedPlanStore {
  // Idempotent on outlineJobId: a re-delivered completion returns the existing plan.
  create(plan: NewSeedPlan): Promise<SeedPlan>;
  get(id: string): Promise<SeedPlan | undefined>;
  listByFlow(flowId: string): Promise<SeedPlan[]>; // newest first
  latestByFlow(flowId: string, status: SeedPlanStatus): Promise<SeedPlan | undefined>;
  setStatus(id: string, status: SeedPlanStatus): Promise<SeedPlan | undefined>;
  // Applies reviewer edits (charter/persona text + per-item patches). Store-level
  // only — the service enforces "only while proposed".
  patch(id: string, patch: { charter?: string; persona?: string; items?: SeedPlanItemPatch[] }): Promise<SeedPlan | undefined>;
  setItemDraftJob(id: string, itemId: string, draftJobId: string): Promise<SeedPlan | undefined>;
}

export function createSeedPlanStore(config: AppConfigHandle, pool: Pool | undefined): SeedPlanStore
// — factory returning postgres-backed when pool is present, in-memory otherwise
// (copy the exact factory shape from createSourceMapStore / createGapClusterStore).
```

- [ ] **Step 1: Write the migration**

`packages/db/migrations/0051_seed_plans.sql`:

```sql
-- Seed plans (self-seeding flows): a persisted, human-reviewable document plan
-- proposed by the source-grounded outline_flow_seed job. status: proposed →
-- approved | dismissed | superseded (a newer proposed plan supersedes an older
-- un-reviewed one for the same flow). charter/persona are RUN-SCOPED text (flow
-- config's value when set, else the model's proposal, as edited by the
-- reviewer) — flow config remains the only durable home. items is the
-- SeedPlanItem[] JSONB (stable per-item uuids, per-item status + draftJobId).
-- source_hash is hashSourceDescriptors() of the planning input, compared by the
-- seed_bootstrap dismissal guard so a dismissed plan is not re-proposed until
-- the flow's sources change.
CREATE TABLE IF NOT EXISTS seed_plans (
  id UUID PRIMARY KEY,
  flow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  charter TEXT,
  persona TEXT,
  charter_proposed BOOLEAN NOT NULL DEFAULT FALSE,
  persona_proposed BOOLEAN NOT NULL DEFAULT FALSE,
  items JSONB NOT NULL,
  rationale TEXT NOT NULL,
  notes TEXT,
  outline_job_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT seed_plans_outline_job_unique UNIQUE (outline_job_id)
);

CREATE INDEX IF NOT EXISTS seed_plans_flow_created_idx
  ON seed_plans (flow_id, created_at DESC);

-- Link proposals back to the plan item that spawned them (progress display).
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS seed_plan_id UUID;
```

- [ ] **Step 2: Write the failing in-memory store tests**

`apps/api/src/stores/seed-plan-store.test.ts` (node:test, follow `gap-cluster-store.test.ts` conventions). Cases:

```ts
// create assigns id + per-item uuids + status "proposed" everywhere, stamps timestamps
// create is idempotent on outlineJobId (second create returns the first plan)
// listByFlow returns newest first; latestByFlow filters by status
// patch edits charter text and per-item fields/status; unknown item ids are ignored
// setItemDraftJob records the job id on exactly that item
// setStatus flips the plan; get reflects every mutation
```

Write them as real tests — e.g.:

```ts
test("create is idempotent on outlineJobId", async () => {
  const store = createSeedPlanStore(configHandle(), undefined);
  const first = await store.create(newPlan({ outlineJobId: "job-1" }));
  const second = await store.create(newPlan({ outlineJobId: "job-1" }));
  assert.equal(second.id, first.id);
});
```

with a local `newPlan(overrides)` fixture returning a valid `NewSeedPlan`.

- [ ] **Step 3: Run to verify failure** — `npm test -w @magpie/api`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement** the in-memory store + factory in `seed-plan-store.ts`, the Postgres store in `postgres-seed-plan-store.ts` (row⇄domain mapping, `crypto.randomUUID()` ids, `ON CONFLICT (outline_job_id) DO NOTHING` + re-select for idempotent create), wire `seedPlans: createSeedPlanStore(config, pool)` into `apps/api/src/context.ts`, add `seedPlanId?: string` to `Proposal` in core and plumb the `seed_plan_id` column through the proposal store exactly where `provenance` is mapped.

- [ ] **Step 5: Write the Postgres integration test** — `postgres-seed-plan-store.test.ts`, `RUN_PG_INTEGRATION`-gated, mirroring `postgres-gap-cluster-store.test.ts`: same behavioural cases as Step 2 against the real table, plus one assert that migration 0051 applied (`seed_plans` exists, `proposals.seed_plan_id` exists).

- [ ] **Step 6: Run to verify pass** — `npm test -w @magpie/api && npm run test:db && npm run typecheck && npm run lint`. Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -am "feat(db,api): seed_plans table + store, proposals.seed_plan_id"` and push.

---

### Task 4: API — outline service rework + plan creation on completion

**Files:**
- Modify: `apps/api/src/features/seed/service.ts` (rewrite `outlineFlowSeed`; add `createSeedPlanFromCompletedJob`)
- Modify: `apps/api/src/features/seed/schema.ts` (`outlineBodySchema` drops `topic`)
- Modify: `apps/api/src/features/seed/routes.ts` (outline route body)
- Modify: `apps/api/src/features/retrieve/service.ts` (add `listExistingDocuments` next to `describeExistingDocuments` ~line 110)
- Modify: `apps/api/src/features/jobs/service.ts` (wire the new completion handler into the fan-out, after `createSeedProposalFromCompletedJob` ~line 319)
- Test: `apps/api/src/features/seed/service.test.ts`, `apps/api/src/features/seed/routes.test.ts`

**Interfaces:**
- Consumes: `SeedPlanStore` (Task 3), `outlineFlowSeedInputSchema/OutputSchema` (Task 1), `hashSourceDescriptors` from `apps/api/src/scheduling/patrol-hash.ts`, `projectSourceDescriptors` from `../../platform/source-descriptors.js`.
- Produces:

```ts
// features/retrieve/service.ts — whole-flow doc list (path+heading, no scoring):
export function listExistingDocuments(ctx: AppContext, flowId: string, limit = 200): ExistingDocumentContext[]

// features/seed/service.ts
export async function outlineFlowSeed(
  ctx: AppContext,
  flowId: string,
  request: { notes?: string; origin: "manual" | "auto" }
): Promise<{ ok: true; jobId: string; reused: boolean } | { ok: false; code: string }>

export async function createSeedPlanFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<SeedPlan | undefined>

// exported for the bootstrap guard (Task 6):
export async function findInFlightOutlineJob(ctx: AppContext, flowId: string): Promise<JobView | undefined>
```

- [ ] **Step 1: Write the failing service tests**

In `apps/api/src/features/seed/service.test.ts` (follow the file's existing test-context construction):

```ts
// outlineFlowSeed enqueues with sources, charter/persona/routingSummary from
// flow config, existingDocuments from the index, origin passed through, and
// no topic anywhere in the input.
// outlineFlowSeed returns { reused: true } with the in-flight job's id when an
// outline job for the same flow is already created/retry/active/blocked.
// createSeedPlanFromCompletedJob: creates a proposed plan from a completed
// outline job (items get uuids + proposed status; charter = input.charter when
// set, else output.proposedCharter with charterProposed=true; sourceHash =
// hashSourceDescriptors(input.sources); idempotent on job id).
// createSeedPlanFromCompletedJob supersedes an older proposed plan for the flow.
// createSeedPlanFromCompletedJob returns undefined for other job types and
// unparsable output.
```

Write each as a real node:test case; for the completion-handler cases build the `JobView` fixture the way `apps/api/src/features/proposals/service.test.ts:1552` does for `createSeedProposalFromCompletedJob`.

- [ ] **Step 2: Run to verify failure** — `npm test -w @magpie/api`. Expected: FAIL.

- [ ] **Step 3: Implement**

`features/retrieve/service.ts`:

```ts
// Whole-flow document inventory for the seed planner: every destination doc's
// path + title, unscored (the planner needs the full structure, not a top-k for
// a query). Bounded to keep the prompt sane on huge KBs.
export function listExistingDocuments(ctx: AppContext, flowId: string, limit = 200): ExistingDocumentContext[] {
  const scope = resolveRepositoryScope(ctx, flowId);
  if (!scope.ok) {
    return [];
  }
  const filter = scope.repositoryIds ? new Set(scope.repositoryIds) : undefined;
  return ctx.stores.knowledgeIndex
    .listDocuments()
    .filter((doc) => !filter || filter.has(doc.repositoryId))
    .slice(0, limit)
    .map((doc) => ({ path: doc.path, heading: doc.metadata.title || doc.path }));
}
```

`features/seed/service.ts` — replace `outlineFlowSeed`:

```ts
// Find an in-flight (non-terminal) outline job for this flow so a second
// propose click / bootstrap tick reuses it instead of double-planning.
export async function findInFlightOutlineJob(ctx: AppContext, flowId: string): Promise<JobView | undefined> {
  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed" });
  return jobs.find((job) => {
    if (!["created", "retry", "active", "blocked"].includes(job.state)) {
      return false;
    }
    const input = job.input as Partial<OutlineFlowSeedJobInput>;
    return input.flowId === flowId;
  });
}
```

(Match `ctx.jobs.list`'s actual `JobListFilters` shape in `apps/api/src/jobs/broker.ts` — pass the state filter server-side if it supports one rather than filtering in JS.)

```ts
// Propose a seed plan for a flow: enqueue the source-grounded outline_flow_seed
// job. No topic — the agent explores the sources and plans the whole flow,
// scoped by the flow's charter when configured. Enqueue-only: the plan row is
// created by createSeedPlanFromCompletedJob when the job lands.
export async function outlineFlowSeed(
  ctx: AppContext,
  flowId: string,
  request: { notes?: string; origin: "manual" | "auto" }
): Promise<{ ok: true; jobId: string; reused: boolean } | { ok: false; code: string }> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, flowId);
  if (!flow) {
    return { ok: false as const, code: "flow_not_found" };
  }
  const inFlight = await findInFlightOutlineJob(ctx, flowId);
  if (inFlight) {
    return { ok: true as const, jobId: inFlight.id, reused: true };
  }
  const input: OutlineFlowSeedJobInput & { provider: AiProviderName } = {
    flowId,
    origin: request.origin,
    notes: request.notes?.trim() || undefined,
    sources: projectSourceDescriptors(deps, flow.sourceIds),
    existingDocuments: listExistingDocuments(ctx, flowId),
    ...(flow.persona ? { persona: flow.persona } : {}),
    ...(flow.charter ? { charter: flow.charter } : {}),
    ...(flow.routingSummary ? { routingSummary: flow.routingSummary } : {}),
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("outline_flow_seed", input);
  logger.info({ jobId: job.id, flowId, origin: request.origin, sources: input.sources.length }, "enqueued outline_flow_seed job");
  return { ok: true as const, jobId: job.id, reused: false };
}
```

Add the completion handler:

```ts
// Completion handler for outline_flow_seed: persist the proposed plan for
// review. Idempotent on the job id (store-level unique on outline_job_id).
// A fresh proposed plan supersedes an older still-proposed plan for the flow —
// the newer exploration reflects newer sources/config.
export async function createSeedPlanFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<SeedPlan | undefined> {
  if (!job || job.type !== "outline_flow_seed") {
    return undefined;
  }
  const parsed = outlineFlowSeedOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<OutlineFlowSeedJobInput>;
  if (!input.flowId) {
    return undefined;
  }
  const previous = await ctx.stores.seedPlans.latestByFlow(input.flowId, "proposed");
  const plan = await ctx.stores.seedPlans.create({
    flowId: input.flowId,
    origin: input.origin ?? "manual",
    charter: input.charter ?? parsed.data.proposedCharter,
    persona: input.persona ?? parsed.data.proposedPersona,
    charterProposed: !input.charter && Boolean(parsed.data.proposedCharter),
    personaProposed: !input.persona && Boolean(parsed.data.proposedPersona),
    items: parsed.data.items,
    rationale: parsed.data.rationale,
    notes: input.notes,
    outlineJobId: job.id,
    sourceHash: hashSourceDescriptors(input.sources ?? [])
  });
  if (previous && previous.id !== plan.id) {
    await ctx.stores.seedPlans.setStatus(previous.id, "superseded");
  }
  return plan;
}
```

(Check `hashSourceDescriptors`' exact signature in `apps/api/src/scheduling/patrol-hash.ts` and match it.)

`features/seed/schema.ts`:

```ts
// Body for proposing a seed plan: optional freeform steer only. The planner
// derives scope from the flow's charter/sources — there is no topic.
export const outlineBodySchema = z.object({
  notes: z.string().optional()
});
```

`features/seed/routes.ts` — outline handler: `const { notes } = c.req.valid("json");` → `outlineFlowSeed(ctx, flowId, { notes, origin: "manual" })`; return `c.json({ ok: true, jobId: outcome.jobId, reused: outcome.reused })`.

`features/jobs/service.ts` — in the completion fan-out, after the seed-proposal block (~line 328):

```ts
    await seedService.createSeedPlanFromCompletedJob(ctx, existingJob, resultData);
```

(import `* as seedService from "../seed/service.js"`; plan creation must not throw for foreign job types — it returns undefined — and a real store failure correctly rides the existing 500-replay contract.)

- [ ] **Step 4: Update route tests** — `features/seed/routes.test.ts`: outline route accepts `{ notes }` (and `{}`), rejects nothing for a missing topic (assert `topic` is no longer required), still 404s unknown flows.

- [ ] **Step 5: Run to verify pass** — `npm test -w @magpie/api && npm run typecheck && npm run lint`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(api): topic-less source-grounded outline; completions persist reviewable seed plans"` and push.

---

### Task 5: API — plan review endpoints + plan-driven drafting

**Files:**
- Modify: `apps/api/src/features/seed/service.ts` (add `listSeedPlans`, `getSeedPlan`, `patchSeedPlan`, `approveSeedPlan`, `dismissSeedPlan`; rework `draftSeedItem`; DELETE `seedFlow`)
- Modify: `apps/api/src/features/seed/schema.ts` (add `seedPlanPatchSchema`; delete `seedBodySchema`)
- Modify: `apps/api/src/features/seed/routes.ts` (new routes; delete `POST /:flowId/seed`)
- Modify: `apps/api/src/app.ts` (~line 114: mount a `seedPlanRoutes` sub-app at `/seed-plans` if the plan routes are not flow-prefixed)
- Modify: `apps/api/src/features/proposals/service.ts` (`createSeedProposalFromCompletedJob` ~line 1481: carry `seedPlanId`)
- Test: `apps/api/src/features/seed/service.test.ts`, `routes.test.ts`, `apps/api/src/features/proposals/service.test.ts`

**Interfaces:**
- Produces:

```ts
// service.ts
export async function listSeedPlans(ctx: AppContext, flowId: string): Promise<SeedPlan[]>
export async function getSeedPlan(ctx: AppContext, planId: string): Promise<SeedPlan | undefined>
export async function patchSeedPlan(ctx, planId, patch: SeedPlanPatchBody):
  Promise<{ ok: true; plan: SeedPlan } | { ok: false; code: "plan_not_found" | "plan_not_editable" }>
export async function approveSeedPlan(ctx, planId):
  Promise<{ ok: true; plan: SeedPlan; jobIds: string[] } | { ok: false; code: "plan_not_found" | "plan_not_approvable" | "coverage_required" }>
export async function dismissSeedPlan(ctx, planId):
  Promise<{ ok: true; plan: SeedPlan } | { ok: false; code: "plan_not_found" | "plan_not_dismissable" }>
```

HTTP surface (all `requireScopes("manage:jobs")` + `assertCan(ctx, c, "manage", plan.flowId)`; cross-flow/unknown ids read as 404):

| Route | Behaviour |
|---|---|
| `GET /api/flows/:flowId/seed-plans` | list, newest first |
| `GET /api/seed-plans/:id` | one plan |
| `PATCH /api/seed-plans/:id` | edit charter/persona/items — 409 `plan_not_editable` unless `proposed` |
| `POST /api/seed-plans/:id/approve` | approve + enqueue drafts; idempotent replay |
| `POST /api/seed-plans/:id/dismiss` | 409 unless `proposed` |

- [ ] **Step 1: Write the failing service tests**

Real node:test cases in `features/seed/service.test.ts`:

```ts
// approveSeedPlan: flips remaining proposed items to approved, enqueues one
//   draft_seed_document per approved item with charter/persona/seedPlanId +
//   flow sources/destination, records draftJobId per item, sets plan approved.
// approveSeedPlan skips dismissed items entirely.
// approveSeedPlan is replay-safe: re-approving enqueues ONLY items lacking a
//   draftJobId (simulate a mid-loop failure by pre-setting one item's job id).
// approveSeedPlan rejects when any approved item has empty coverage
//   ({ ok: false, code: "coverage_required" }) and enqueues nothing.
// approveSeedPlan on a dismissed/superseded plan → plan_not_approvable.
// patchSeedPlan edits charter text and item coverage while proposed; 409 code
//   plan_not_editable once approved.
// dismissSeedPlan flips proposed → dismissed; anything else → plan_not_dismissable.
```

And in `proposals/service.test.ts`: extend the `createSeedProposalFromCompletedJob` cases — a draft job whose input carries `seedPlanId: "plan-1"` produces a proposal with `seedPlanId === "plan-1"`.

- [ ] **Step 2: Run to verify failure** — `npm test -w @magpie/api`. Expected: FAIL.

- [ ] **Step 3: Implement the service**

Rework `draftSeedItem` (keep the existing flow/source/destination resolution and dedupe/trim of coverage) to take the plan:

```ts
async function draftSeedItem(ctx: AppContext, plan: SeedPlan, item: SeedPlanItem): Promise<string> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, plan.flowId);
  const input: DraftSeedDocumentJobInput & { provider: AiProviderName } = {
    flowId: plan.flowId,
    title: item.title?.trim() || undefined,
    targetPath: item.targetPath?.trim() || undefined,
    coverage: [...new Set(item.coverage.map((point) => point.trim()).filter((point) => point.length > 0))],
    questions: item.questions?.length ? item.questions : undefined,
    sources: projectSourceDescriptors(deps, flow?.sourceIds),
    destinationId: flow?.destinationId || defaultDestinationId(deps),
    charter: plan.charter,
    persona: plan.persona,
    seedPlanId: plan.id,
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("draft_seed_document", input);
  return job.id;
}
```

`approveSeedPlan`:

```ts
export async function approveSeedPlan(ctx: AppContext, planId: string) {
  const plan = await ctx.stores.seedPlans.get(planId);
  if (!plan) {
    return { ok: false as const, code: "plan_not_found" as const };
  }
  // "approved" is re-enterable so a mid-loop enqueue failure is recovered by
  // re-approving: items that already carry a draftJobId are skipped below.
  if (plan.status !== "proposed" && plan.status !== "approved") {
    return { ok: false as const, code: "plan_not_approvable" as const };
  }
  const toDraft = plan.items.filter((item) => item.status !== "dismissed");
  if (toDraft.some((item) => !item.coverage.some((point) => point.trim().length > 0))) {
    return { ok: false as const, code: "coverage_required" as const };
  }
  await ctx.stores.seedPlans.patch(plan.id, {
    items: toDraft.filter((item) => item.status === "proposed").map((item) => ({ id: item.id, status: "approved" as const }))
  });
  await ctx.stores.seedPlans.setStatus(plan.id, "approved");
  const jobIds: string[] = [];
  for (const item of toDraft) {
    if (item.draftJobId) {
      continue;
    }
    const jobId = await draftSeedItem(ctx, { ...plan, status: "approved" }, item);
    await ctx.stores.seedPlans.setItemDraftJob(plan.id, item.id, jobId);
    jobIds.push(jobId);
  }
  const updated = await ctx.stores.seedPlans.get(plan.id);
  logger.info({ planId: plan.id, flowId: plan.flowId, enqueued: jobIds.length }, "approved seed plan: enqueued draft_seed_document jobs");
  return { ok: true as const, plan: updated ?? plan, jobIds };
}
```

(Status is set to `approved` *before* the enqueue loop deliberately: a mid-loop crash leaves an approved plan with partial `draftJobId`s, and re-approving completes the remainder — the tested replay path. `patch`/`dismiss`/`list`/`get` are thin wrappers enforcing the status guards above.)

Delete `seedFlow` and `seedBodySchema`; add `seedPlanPatchSchema`:

```ts
export const seedPlanPatchSchema = z.object({
  charter: z.string().optional(),
  persona: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        targetPath: z.string().optional(),
        coverage: z.array(z.string().min(1)).optional(),
        questions: z.array(z.string()).optional(),
        status: z.enum(["proposed", "approved", "dismissed"]).optional()
      })
    )
    .optional()
});
// The service/provider-facing type for PATCH bodies (referenced by Tasks 5 and 7):
export type SeedPlanPatchBody = z.infer<typeof seedPlanPatchSchema>;
```

Routes: keep `GET /:flowId/seed-plans` inside the existing flow-prefixed `seedRoutes` app; add a second exported `seedPlanRoutes(ctx)` Hono app for the `/seed-plans/*` routes and mount it in `app.ts` next to the seed mount (`api.route("/seed-plans", seedPlanRoutes(ctx))`). Every plan-scoped route loads the plan first, 404s when missing, then `assertCan(ctx, c, "manage", plan.flowId)` — the cross-flow-as-404 convention holds because unknown ids 404 before any authz signal.

`proposals/service.ts` (~1509): in `createSeedProposalFromCompletedJob`, read `seedPlanId` off the input partial and pass it into `ctx.stores.proposals.create({ ..., seedPlanId: input.seedPlanId, ... })`.

- [ ] **Step 4: Update the route tests** — replace the old `POST /:flowId/seed` coverage with: plan list/get 200 + 404s, PATCH guard (409 after approve), approve returns `jobIds` and 409s on dismissed, dismiss flow. Follow the file's existing auth fixtures.

- [ ] **Step 5: Run to verify pass** — `npm test -w @magpie/api && npm run build && npm run typecheck && npm run lint`. Expected: PASS. Also `npm run deadcode` — deleting `seedFlow` must not leave orphaned exports.

- [ ] **Step 6: Commit** — `git commit -am "feat(api): seed-plan review endpoints; approval drives plan-scoped drafting; drop raw seed endpoint"` and push.

---

### Task 6: `seed_bootstrap` job — sparse-flow auto-trigger

**Files:**
- Modify: `packages/jobs/src/types.ts` (JOB_TYPES ~line 3: add `"seed_bootstrap"` after `"verify_gap_closure"`)
- Modify: `packages/jobs/src/schemas.ts` (input/output schemas next to the patrol schemas ~line 554)
- Modify: `packages/jobs/src/catalog.ts` (definition next to the other maintenance jobs ~line 118)
- Modify: `apps/api/src/scheduling/task-registry.ts` (`flowTaskTemplates` ~line 53)
- Modify: `apps/api/src/features/seed/service.ts` (`runSeedBootstrap`), `routes.ts` (`POST /:flowId/seed-bootstrap/run`)
- Modify: `apps/api/src/platform/config.ts` (env knob `SEED_BOOTSTRAP_MAX_DOCS`, default 3 — follow the `AI_MAX_INFLIGHT_JOBS` parse pattern)
- Modify: `apps/watcher/src/http-client.ts` (interface ~line 61 + impl ~line 260) and `apps/watcher/src/runners/maintenance.ts`
- Test: `packages/jobs/src/catalog.test.ts`, `apps/api/src/features/seed/service.test.ts`, `apps/api/src/scheduling/task-registry.test.ts` (if present), `apps/watcher/src/runners/maintenance.test.ts` (follow existing runner-test fixtures)

**Interfaces:**

```ts
// packages/jobs/src/schemas.ts
export const seedBootstrapInputSchema = z.object({ flowId: z.string() });
export const seedBootstrapOutputSchema = z.object({
  enqueued: z.boolean(),
  // Why the tick no-oped: no_sources | kb_populated | plan_pending |
  // outline_in_flight | seed_proposals_open | dismissed_unchanged
  reason: z.string().optional(),
  outlineJobId: z.string().optional()
});

// catalog.ts
seed_bootstrap: define("seed_bootstrap", "maintenance", schemas.seedBootstrapInputSchema, schemas.seedBootstrapOutputSchema, 60 * 60),

// watcher http-client
runSeedBootstrap(flowId: string, signal?: AbortSignal): Promise<{ enqueued: boolean; reason?: string; outlineJobId?: string }>
// → POST /api/flows/{flowId}/seed-bootstrap/run  (empty JSON body)
```

- [ ] **Step 1: Write the failing tests**

`packages/jobs/src/catalog.test.ts`: extend whichever cases enumerate maintenance types/queues (grep the file for `verify_gap_closure` and mirror) — `seed_bootstrap` routes to capability `maintenance`, queue name `seed_bootstrap`, retry 2. Any count assertions (25 types → 26) get updated here.

`features/seed/service.test.ts` — the guard matrix, one case per guard, in the order the service checks them:

```ts
// runSeedBootstrap → { enqueued: false, reason: "no_sources" } for a flow with no sources
// → kb_populated when listExistingDocuments(ctx, flowId).length >= the configured max (default 3)
// → plan_pending when a proposed plan exists
// → outline_in_flight when findInFlightOutlineJob finds one
// → seed_proposals_open when an open proposal carries a seedPlanId for this flow
// → dismissed_unchanged when the latest dismissed plan's sourceHash equals the current hash
// → { enqueued: true, outlineJobId } (origin "auto") when every guard passes
// → enqueues again when the latest dismissed plan's hash differs from current sources
```

`apps/watcher/src/runners/maintenance.test.ts`: `seed_bootstrap` is supported, calls `api.runSeedBootstrap` with the input flowId, returns the parsed output; throws without a flowId.

- [ ] **Step 2: Run to verify failure** — `npm test -w @magpie/jobs && npm test -w @magpie/api && npm test -w @magpie/watcher`. Expected: FAIL.

- [ ] **Step 3: Implement**

`features/seed/service.ts`:

```ts
// Sparse-flow auto-seeding tick (thin orchestration endpoint body). Checks the
// guards in cheapest-first order and proposes a plan only when the flow has
// sources, a near-empty KB, and no pending/duplicate/vetoed planning work.
// Enqueue-and-return: unlike the patrols it never bounded-waits — the plan
// lands via createSeedPlanFromCompletedJob. Dismissal is sticky per source
// config: a human "no" is re-litigated only when the sources change.
export async function runSeedBootstrap(
  ctx: AppContext,
  flowId: string
): Promise<{ ok: true; enqueued: boolean; reason?: string; outlineJobId?: string } | { ok: false; code: "flow_not_found" }> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, flowId);
  if (!flow) {
    return { ok: false as const, code: "flow_not_found" as const };
  }
  const sources = projectSourceDescriptors(deps, flow.sourceIds);
  if (sources.length === 0) {
    return { ok: true as const, enqueued: false, reason: "no_sources" };
  }
  if (listExistingDocuments(ctx, flowId).length >= ctx.config.get().seedBootstrapMaxDocs) {
    return { ok: true as const, enqueued: false, reason: "kb_populated" };
  }
  if (await ctx.stores.seedPlans.latestByFlow(flowId, "proposed")) {
    return { ok: true as const, enqueued: false, reason: "plan_pending" };
  }
  if (await findInFlightOutlineJob(ctx, flowId)) {
    return { ok: true as const, enqueued: false, reason: "outline_in_flight" };
  }
  const openProposals = await sameFlowOpenProposals(ctx, flowId);
  if (openProposals.some((proposal) => proposal.seedPlanId)) {
    return { ok: true as const, enqueued: false, reason: "seed_proposals_open" };
  }
  const dismissed = await ctx.stores.seedPlans.latestByFlow(flowId, "dismissed");
  if (dismissed && dismissed.sourceHash === hashSourceDescriptors(sources)) {
    return { ok: true as const, enqueued: false, reason: "dismissed_unchanged" };
  }
  const outcome = await outlineFlowSeed(ctx, flowId, { origin: "auto" });
  if (!outcome.ok) {
    return { ok: false as const, code: "flow_not_found" as const };
  }
  return { ok: true as const, enqueued: true, outlineJobId: outcome.jobId };
}
```

(`sameFlowOpenProposals` is in `apps/api/src/scheduling/flow.ts` — check its exact return shape before use. Confirm how `ctx.config.get()` exposes knobs and mirror `AI_MAX_INFLIGHT_JOBS` for `seedBootstrapMaxDocs`.)

Route (in `seedRoutes`, patrol-route style — `requireScopes("manage:jobs")`, `rateLimit(ctx, "trigger")`):

```ts
  app.post("/:flowId/seed-bootstrap/run", requireScopes("manage:jobs"), rateLimit(ctx, "trigger"), async (c) => {
    const flowId = c.req.param("flowId");
    const outcome = await runSeedBootstrap(ctx, flowId);
    if (!outcome.ok) {
      throw new HttpError(404, outcome.code);
    }
    return c.json({ enqueued: outcome.enqueued, reason: outcome.reason, outlineJobId: outcome.outlineJobId });
  });
```

`task-registry.ts` — append to `flowTaskTemplates`:

```ts
  {
    baseKey: "seed-bootstrap",
    typeLabel: "Seed bootstrap · plan a sparse flow",
    description:
      "Checks whether this flow has sources but a near-empty knowledge base. When it does (and no plan is pending, " +
      "in flight, drafting, or recently dismissed for the same sources), it proposes a seed plan by exploring the " +
      "sources — the plan waits on the Seed page for human review; nothing is drafted without approval.",
    defaultCron: "0 * * * *",
    jobType: "seed_bootstrap",
    input: (flowId) => ({ flowId })
  }
```

Watcher: add `"seed_bootstrap"` to `MAINTENANCE_JOB_TYPES`, a `runSeedBootstrap` branch mirroring `runSourceSync` (requires flowId; parse output with `seedBootstrapOutputSchema`), and the http-client method:

```ts
  async runSeedBootstrap(flowId: string, signal?: AbortSignal): Promise<{ enqueued: boolean; reason?: string; outlineJobId?: string }> {
    // mirror runFixPatrol's POST helper usage:
    // POST `/api/flows/${encodeURIComponent(flowId)}/seed-bootstrap/run`, {}
  }
```

- [ ] **Step 4: Run to verify pass** — `npm test -w @magpie/jobs && npm test -w @magpie/api && npm test -w @magpie/watcher && npm run build && npm run typecheck && npm run lint`. Expected: PASS. Grep for job-type count assertions that broke: `grep -rn "25" packages/jobs apps/api/src/features/workers --include="*.test.ts"` and fix deliberately (counts also appear in the dataflow/config web fixtures — check `apps/web` test output).

- [ ] **Step 5: Commit** — `git commit -am "feat(jobs,api,watcher): seed_bootstrap maintenance job auto-proposes plans for sparse flows"` and push.

---

### Task 7: Console — plan-centric `/seed`

**Files:**
- Modify: `apps/web/src/components/ConsoleProvider.tsx` (~735–800: replace `generateOutline`/`seedFlow` with plan operations; export them ~867)
- Rewrite: `apps/web/src/components/SeedPanel.tsx`
- Modify: `apps/web/src/app/seed/page.tsx`
- Test: follow the existing web test conventions (`ls apps/web/src/**/*.test.tsx` — if component tests exist, cover SeedPanel states; if none exist, the build + a run-magpie smoke check in Task 9 is the bar)

**Interfaces:**
- Consumes (Task 5's HTTP surface): `POST /flows/:id/outline {notes?}` → `{jobId, reused}`; `GET /flows/:id/seed-plans` → `{plans: SeedPlan[]}` (match the route's actual envelope); `PATCH /seed-plans/:id`; `POST /seed-plans/:id/approve` → `{plan, jobIds}`; `POST /seed-plans/:id/dismiss`.
- Produces (ConsoleProvider):

```ts
proposeSeedPlan(flowId: string, notes: string): Promise<{ jobId: string; reused: boolean } | undefined>
listSeedPlans(flowId: string): Promise<SeedPlan[] | undefined>
patchSeedPlan(planId: string, patch: SeedPlanPatchBody): Promise<SeedPlan | undefined>
approveSeedPlan(planId: string): Promise<{ plan: SeedPlan; jobIds: string[] } | undefined>
dismissSeedPlan(planId: string): Promise<SeedPlan | undefined>
```

Each follows the existing `apiPost`/`apiGet` + `showMessage`/`errorMessage` pattern (return `undefined` on failure, surface the error). `proposeSeedPlan` does NOT wait for the job: it enqueues, shows "Planning — exploring the flow's sources; the plan will appear here for review when ready.", and the panel polls `listSeedPlans` (reuse the provider's `refresh`/polling conventions; a `waitForJob` loop like the old `generateOutline`'s is fine to keep the UX live, but the panel must render from the *persisted plan*, not the raw job output).

- [ ] **Step 1: Rewrite `SeedPanel`** with three zones (all `ui` primitives — `Surface`, `Field`, `Input`, `Textarea`, `Select`, `Button`, `Chip`, `Badge`, `Row`, `Actions`, `EmptyState`):
  1. **Propose**: flow `Select` + optional steer-notes `Textarea` + "Propose seed plan" `Button` (topic input is gone). Disabled while a plan job is in flight; `reused: true` shows "Already planning this flow…".
  2. **Plans list**: the flow's plans newest-first — status `Badge` (`proposed`/`approved`/`dismissed`/`superseded`), origin `Chip` (`manual`/`auto`), created date; click selects.
  3. **Review**: for a `proposed` plan — an editable **charter block** at the top (`Textarea` for charter, `Input` for persona; when `charterProposed`/`personaProposed`, show the hint *"Proposed from the sources — to make this permanent, copy it into this flow's `charter`/`persona` in `KNOWLEDGE_FLOWS`."* with a copy-to-clipboard `Chip`), then the item cards (reuse the existing `DraftSeedItem` raw-multiline editing helpers `toDraft`/`toSeedItem`/`linesToArray` — extend `DraftSeedItem` with `id` and `status`, with per-item Approve/Dismiss `Chip` toggles), a **Save edits** button (PATCH), **Approve plan** (approve → show enqueued-count hint) and **Dismiss plan** buttons. For an `approved` plan, render read-only with per-item drafting state (item has `draftJobId` → "drafting/proposed" — link to `/proposals`).
- [ ] **Step 2: Wire the provider functions** in `ConsoleProvider.tsx` (delete `generateOutline`/`seedFlow`, export the five new functions) and update `seed/page.tsx` to pass them.
- [ ] **Step 3: Validate** — `npm run build -w @magpie/web && npm run typecheck && npm run lint`, plus web tests if step 0 found any. Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(web): plan-centric seed page with charter review"` and push.

---

### Task 8: MCP — `kb_outline`/`kb_seed` rework

**Files:**
- Modify: `apps/mcp/src/main.ts` (tool definitions ~lines 132–200; dispatch ~342–350)
- Modify: `apps/mcp/src/kb-client.ts` (`generateOutline` ~438; `seedFlow` ~395)
- Test: apps/mcp's existing tests for tool dispatch/client (grep `kb_outline` in `apps/mcp/src/*.test.ts` and mirror)

**Interfaces:**
- `kb_outline` input: `{ flow: string; notes?: string }` (topic removed). Behaviour: POST `/flows/:id/outline`, wait for the job (existing `waitForOutlineJob`), then fetch `GET /flows/:id/seed-plans` and return the plan whose `outlineJobId` matches — `{ planId, charter?, charterProposed, persona?, personaProposed, items, rationale }`. Description: *"Propose a seed plan for a flow by exploring its source repositories — no topic needed. Returns the persisted plan (documents + proposed charter) for review; nothing is drafted. Approve with kb_seed, or review/edit in the console."*
- `kb_seed` input: `{ plan: string }` (a plan id). Behaviour: POST `/seed-plans/:id/approve`, return `{ planId, jobIds }`. Description: *"Approve a seed plan (from kb_outline or the console): drafts one document per approved item straight into the proposal → pull-request pipeline. Edit or partially dismiss items in the console first if needed."*

- [ ] **Step 1: Update the failing client/dispatch tests first** (whatever exists — tool listing snapshots, argument validation), then run `npm test -w @magpie/mcp` locally per the memory note (never as part of a full root `npm test` in a sandbox — the JWKS test hangs).
- [ ] **Step 2: Implement** both tool schemas, descriptions, dispatch, and the two client functions (`generateOutline` drops `topic`, resolves the plan via the list endpoint; `seedFlow` → `approveSeedPlan(args)` posting the approve route). Keep the existing poll/timeout envs (`OUTLINE_POLL_INTERVAL_MS`/`OUTLINE_TIMEOUT_MS`).
- [ ] **Step 3: Validate** — `npm test -w @magpie/mcp && npm run build && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(mcp): kb_outline proposes plans; kb_seed approves them"` and push.

---

### Task 9: Docs, orientation skill, end-to-end smoke

**Files:**
- Modify: `docs/ai-jobs.md` (outline contract, `seed_bootstrap`), `docs/api.md` (seed-plan endpoints; remove the raw seed route), `docs/architecture.md` (seeding section), `docs/mcp.md` (tool changes)
- Modify: `.claude/skills/magpie-orientation/SKILL.md` (§1 source-grounded set is now **six** job types incl. `outline_flow_seed`; §2.13 seeding rewritten around plans/charter/bootstrap; §3 job catalog: **26** types, **10** non-provider rows + the new table row; migration count 0001–0051; `/seed` page description)
- Modify: `.claude/skills/run-magpie/SKILL.md` only if it names the seed flow's steps

- [ ] **Step 1: Update every doc** listed above; sweep for stale claims with `grep -rn "topic" docs/ai-jobs.md docs/api.md docs/mcp.md | grep -i seed` and `grep -rn "25 job types\|Five job types" docs .claude/skills`.
- [ ] **Step 2: Full validation sweep** — `npm run build && npm run typecheck && npm run lint && npm run format:check && npm run deadcode`, then per-workspace tests (`-w @magpie/jobs`, `-w @magpie/api`, `-w @magpie/watcher`, `-w @magpie/prompts`, `-w @magpie/web`, `-w @magpie/mcp`), then `npm run test:db`. Expected: all PASS.
- [ ] **Step 3: Live smoke (run-magpie skill)** — launch the stack (Postgres → migrate → API → Watcher ×2 → Web), then: propose a plan for a sparse flow from `/seed` (no topic field visible), watch the outline job land, review the plan (charter proposal shows the copy-to-config hint), approve one item, see the draft job → proposal appear with the plan linked. Trigger `POST /api/flows/:id/seed-bootstrap/run` manually and confirm a `plan_pending` no-op response while the first plan awaits review.
- [ ] **Step 4: Commit + push** — `git commit -am "docs: self-seeding flows (plans, charter, seed_bootstrap)"`.

---

## Self-Review Notes (kept for the executor)

- **Spec coverage:** charter/persona config + proposal loop (Tasks 1, 2, 4, 7); source-grounded whole-flow planning (Tasks 1–2); persisted plans + review gate (Tasks 3–5); sparse-flow auto-trigger incl. sticky dismissal (Task 6); drafting carries charter/persona + plan linkage (Tasks 1, 5); console (Task 7); MCP (Task 8); docs (Task 9). Legacy raw-seed endpoint removal: Task 5.
- **Deliberate orderings:** Task 1 pulls the outline-service signature rework forward if typecheck demands it (Step 4) — honest compile fixes over stubs. `approveSeedPlan` sets status before enqueueing (replay-safe partial approve, tested).
- **Known count-assertions to touch:** JOB_TYPES 25→26 (catalog tests, possibly workers/dataflow fixtures); source-grounded set 5→6 (source-workspace comment, source-map service set, orientation skill); migrations 0050→0051.
