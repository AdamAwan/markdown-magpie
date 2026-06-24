# Verify lens (fix-patrol) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the fix-patrol no-op lens slot with the **verify** lens — for each patrolled document, judge its claims against its source material and record a finding (run through the reconcile gate) when a claim is unprovable; stay silent on healthy docs.

**Architecture:** A new `verify_document` provider AI job judges one document + its sources. `runFixPatrol` (API) runs the verify lens over the selected batch by enqueuing one `verify_document` job per doc and bounded-waiting (`runJobToCompletion`, exactly as `gap-reconciler.ts` does for the reshape job). Findings are recorded on the `PatrolRun`. No corrective PR yet.

**Tech Stack:** TypeScript ESM, npm workspaces (`@magpie/core`, `@magpie/jobs`, `@magpie/prompts`, `@magpie/api`, `@magpie/watcher`), zod, pg, Hono, Node built-in test runner.

## Global Constraints

- TypeScript ESM: local imports use the `.js` suffix; `@magpie/*` imports do not.
- knip runs **strict** (`npm run deadcode`): an export consumed only within its own file is flagged — de-export or inline; never relax the config.
- Run workspace tests with `npm test -w @magpie/<pkg>` (root-cwd `node --test` resolves `@magpie/*` to stale `dist`).
- Pre-PR gates, all green: `npm test`, `npm run typecheck`, `npm run deadcode`.
- UK English in copy and comments.
- A `verify_document` AI job input excludes `provider`; the schema adds it via `ProviderInput<T>`, matching `SourceChangeSyncJobInput` (provider is added at enqueue).
- The verify lens is **conservative**: a doc is healthy unless the sources actively fail to support a claim; healthy ⇒ no finding, no intent.
- One bad/timed-out doc must never abort the patrol tick (per-doc try/catch, mirroring source-sync's per-source isolation).

---

### Task 1: `verify_document` job contract (core types + jobs schema + catalog)

**Files:**
- Modify: `packages/core/src/index.ts` (add types near `SourceDataContext` ~line 408 and `PatrolRun` ~line 627)
- Modify: `packages/jobs/src/schemas.ts` (header import + new schemas after `syncSourceChangesGeneratePlanOutputSchema` ~line 242)
- Modify: `packages/jobs/src/types.ts` (`JOB_TYPES`)
- Modify: `packages/jobs/src/catalog.ts` (`definitions`, `aiJobTypes`)
- Test: `packages/jobs/src/catalog.test.ts`, `packages/jobs/src/schemas.test.ts`

**Interfaces:**
- Produces (core): `UnprovableClaim { claim: string; reason: string }`; `VerifyDocumentJobInput { path: string; content: string; sources: SourceDataContext[] }`; `VerifyDocumentJobOutput { verdict: "healthy" | "unprovable"; claims: UnprovableClaim[] }`; `VerifyFinding { path: string; claims: UnprovableClaim[]; decision: "open-new" | "fold" | "defer"; intoProposalId?: string }`; `PatrolRun.findings: VerifyFinding[]`.
- Produces (jobs): `verifyDocumentInputSchema`, `verifyDocumentOutputSchema`; job type `"verify_document"` (provider capability, 10-min expiry).

- [ ] **Step 1: Add the core types**

In `packages/core/src/index.ts`, immediately after the `SourceDataContext` interface (the block ending `}` around line 408), add:

```ts
// One claim in a knowledge-base document the verify lens could not substantiate
// against the document's source material, with the model's reason.
export interface UnprovableClaim {
  claim: string;
  reason: string;
}

// Input to the verify_document AI job: one knowledge-base document plus the source
// material to check it against. `provider` is added at enqueue (see @magpie/jobs).
export interface VerifyDocumentJobInput {
  path: string;
  content: string;
  sources: SourceDataContext[];
}

// The verify lens's verdict for one document: "healthy" (claims empty) or
// "unprovable" with the specific claims the sources fail to support.
export interface VerifyDocumentJobOutput {
  verdict: "healthy" | "unprovable";
  claims: UnprovableClaim[];
}
```

Then, immediately **before** the `export interface PatrolRun {` block (~line 627), add:

```ts
// A verify-lens result recorded on a patrol run: the document, the claims the
// sources could not substantiate, and what the reconcile gate decided to do with
// the emitted intent. `intoProposalId` is set only when the gate folded it into an
// existing open PR.
export interface VerifyFinding {
  path: string;
  claims: UnprovableClaim[];
  decision: "open-new" | "fold" | "defer";
  intoProposalId?: string;
}
```

And add `findings` to `PatrolRun` (the existing interface), after `selected: string[];`:

```ts
  selected: string[];
  // The verify-lens findings this tick produced (empty when every checked doc was
  // healthy or the patrol ran no lens).
  findings: VerifyFinding[];
  createdAt: string;
```

- [ ] **Step 2: Build core, then add the job schemas**

Add to the `@magpie/core` type import block at the top of `packages/jobs/src/schemas.ts` (alphabetically, after `SummarizeGapJobOutput`):

```ts
  SummarizeGapJobOutput,
  VerifyDocumentJobInput as CoreVerifyDocumentJobInput,
  VerifyDocumentJobOutput
} from "@magpie/core";
```

Then, immediately after `syncSourceChangesGeneratePlanOutputSchema` (~line 242), add:

```ts
export const verifyDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  sources: z.array(sourceDataContextSchema)
}) satisfies z.ZodType<ProviderInput<CoreVerifyDocumentJobInput>>;
export const verifyDocumentOutputSchema = z.object({
  verdict: z.enum(["healthy", "unprovable"]),
  claims: z.array(z.object({ claim: z.string(), reason: z.string() }))
}) satisfies z.ZodType<VerifyDocumentJobOutput>;
```

- [ ] **Step 3: Register the job type and definition**

In `packages/jobs/src/types.ts`, add `"verify_document"` to `JOB_TYPES` immediately after `"sync_source_changes_generate_plan"`.

In `packages/jobs/src/catalog.ts`, add to `definitions` (after the `sync_source_changes_generate_plan` line ~75):

```ts
  verify_document: define("verify_document", "provider", schemas.verifyDocumentInputSchema, schemas.verifyDocumentOutputSchema, 10 * 60),
```

and add `"verify_document"` to the `aiJobTypes` set (after `"sync_source_changes_generate_plan"`, ~line 106).

- [ ] **Step 4: Update catalog.test.ts (RED → GREEN)**

In `packages/jobs/src/catalog.test.ts`, add to the `EXPIRATION_SECONDS` map (after the `sync_source_changes_generate_plan` line):

```ts
  verify_document: 10 * 60,
```

and add a focused test after the `sync_source_changes_generate_plan routes by provider` test:

```ts
test("verify_document routes by provider like other AI work", () => {
  const definition = jobDefinition("verify_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("verify_document", { provider: "codex" }), "verify_document__codex");
  const codexQueues = queueNamesForCapabilities(["codex"]);
  assert.ok(codexQueues.includes("verify_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("verify_document__codex"));
});
```

- [ ] **Step 5: Add schemas.test.ts coverage**

In `packages/jobs/src/schemas.test.ts`, add (import `verifyDocumentInputSchema, verifyDocumentOutputSchema` from `./index.js` if the file imports schemas individually; otherwise reference via the existing import style in that file):

```ts
test("verify_document input round-trips path/content/sources with a provider", () => {
  const ok = verifyDocumentInputSchema.safeParse({
    provider: "codex",
    path: "kb/refunds.md",
    content: "Refunds take 5 days.",
    sources: [{ sourceId: "s1", sourceName: "Billing", kind: "git", path: "refunds.ts", content: "const days = 7;" }]
  });
  assert.equal(ok.success, true);
});

test("verify_document output rejects an unknown verdict and accepts healthy/unprovable", () => {
  assert.equal(verifyDocumentOutputSchema.safeParse({ verdict: "healthy", claims: [] }).success, true);
  assert.equal(
    verifyDocumentOutputSchema.safeParse({ verdict: "unprovable", claims: [{ claim: "5 days", reason: "source says 7" }] }).success,
    true
  );
  assert.equal(verifyDocumentOutputSchema.safeParse({ verdict: "maybe", claims: [] }).success, false);
});
```

- [ ] **Step 6: Run the tests (expect GREEN)**

Run: `npm test -w @magpie/core && npm test -w @magpie/jobs`
Expected: all pass, including the new verify_document tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/jobs/src/schemas.ts packages/jobs/src/types.ts packages/jobs/src/catalog.ts packages/jobs/src/catalog.test.ts packages/jobs/src/schemas.test.ts
git commit -m "feat(jobs): verify_document job contract + core verify types"
```

---

### Task 2: VERIFY_DOCUMENT prompt

**Files:**
- Modify: `packages/prompts/src/catalog.ts`
- Test: `packages/prompts/src/catalog.test.ts`

**Interfaces:**
- Produces: `VERIFY_DOCUMENT: PromptDefinition` (id `"verify-document"`), exported and added to `promptCatalog`.

- [ ] **Step 1: Update the count and order tests (RED)**

In `packages/prompts/src/catalog.test.ts`, change `assert.equal(promptCatalog.length, 12);` to `13`, and add `"verify-document"` to the `catalog ids are in the fixed, documented order` array, immediately after `"source-change-sync"`:

```ts
      "source-change-sync",
      "verify-document",
      "gap-clustering",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/prompts`
Expected: FAIL — count is 12 not 13, and the order array has no `verify-document`.

- [ ] **Step 3: Add the prompt**

In `packages/prompts/src/catalog.ts`, immediately after the `SOURCE_CHANGE_SYNC` definition (before `GAP_CLUSTERING`), add:

```ts
export const VERIFY_DOCUMENT: PromptDefinition = {
  id: "verify-document",
  title: "Verify a document against its sources",
  description:
    "Checks whether a knowledge-base document's claims are still provable against the supplied source material, returning only the claims the sources fail to support. Conservative: silent on healthy documents. Used by the watcher's verify_document job.",
  usedBy: ["watcher · fix-patrol"],
  outputShape: '{ verdict, claims[] }',
  instructions: `You verify a Markdown knowledge-base document against the source material it should be derived from. Decide whether each substantive claim the document makes is still supported by the sources.

Input:
- "path" and "content": the knowledge-base document under review.
- "sources": the source material (files, references) to check the document against.

Rules:
- Return JSON only.
- Be conservative. Flag a claim ONLY when the sources clearly contradict it or clearly fail to support it. When you are unsure, or the sources simply do not mention the claim, treat the document as healthy — do NOT flag it.
- If every claim is supported (or the sources give you nothing to disprove), return verdict "healthy" with an empty claims array.
- Otherwise return verdict "unprovable" and list ONLY the specific unprovable claims, each with a short reason citing what the sources say (or fail to say).
- Do not propose edits or rewrites. You only report.

Return JSON:
{
  "verdict": "healthy | unprovable",
  "claims": [
    { "claim": "string", "reason": "string" }
  ]
}`
};
```

Add `VERIFY_DOCUMENT` to the `promptCatalog` array, immediately after `SOURCE_CHANGE_SYNC`:

```ts
  SOURCE_CHANGE_SYNC,
  VERIFY_DOCUMENT,
  GAP_CLUSTERING,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @magpie/prompts`
Expected: PASS (count 13, order matches, no trailing newline — the instructions end with `}` not a newline).

- [ ] **Step 5: Commit**

```bash
git add packages/prompts/src/catalog.ts packages/prompts/src/catalog.test.ts
git commit -m "feat(prompts): VERIFY_DOCUMENT prompt for the verify lens"
```

---

### Task 3: Watcher wiring (run verify_document via the chat runner)

**Files:**
- Modify: `apps/watcher/src/job-prompts.ts`
- Modify: `apps/watcher/src/runners/chat.ts`
- Test: `apps/watcher/src/job-prompts.test.ts`, `apps/watcher/src/runners/chat.test.ts`

**Interfaces:**
- Consumes: `VERIFY_DOCUMENT` (Task 2); the `verify_document` job type (Task 1).
- Produces: `buildPrompt` handles `verify_document`; `ChatRunner.supports("verify_document")` is true.

- [ ] **Step 1: Add the chat-runner support test (RED)**

In `apps/watcher/src/runners/chat.test.ts`, inside the `declares its provider capability and supports AI job types` test, add after the existing `supports` assertions:

```ts
    assert.ok(runner.supports("verify_document"));
```

- [ ] **Step 2: Add a buildPrompt test (RED)**

In `apps/watcher/src/job-prompts.test.ts`, add a test (mirror the file's existing `buildPrompt` test style; construct a minimal `JobView` with `type: "verify_document"`):

```ts
test("buildPrompt uses the verify-document instructions for a verify_document job", () => {
  const job = {
    id: "j", type: "verify_document", queueName: "verify_document__codex", deadLetter: false,
    state: "active", input: { path: "kb/a.md", content: "x", sources: [] }, retryCount: 0, retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", expireInSeconds: 600
  } as JobView;
  const prompt = buildPrompt(job);
  assert.ok(prompt.includes("verify a Markdown knowledge-base document"));
  assert.ok(prompt.includes('"path"'));
});
```

(If `job-prompts.test.ts` lacks the `JobView`/`buildPrompt` imports, add `import type { JobView } from "@magpie/jobs";` and `import { buildPrompt } from "./job-prompts.js";`.)

- [ ] **Step 3: Run both tests (expect FAIL)**

Run: `npm test -w @magpie/watcher`
Expected: FAIL — `supports("verify_document")` is false and `buildPrompt` falls through to the generic prompt (no verify text).

- [ ] **Step 4: Implement the wiring**

In `apps/watcher/src/runners/chat.ts`, add `"verify_document"` to the `CHAT_JOB_TYPES` set (after `"sync_source_changes_generate_plan"`).

In `apps/watcher/src/job-prompts.ts`: add `VERIFY_DOCUMENT` to the `@magpie/prompts` import, and add a case to `buildPrompt` before the `default`:

```ts
    case "verify_document":
      return `${VERIFY_DOCUMENT.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
```

- [ ] **Step 5: Run the tests (expect GREEN)**

Run: `npm test -w @magpie/watcher`
Expected: PASS (the pre-existing Windows-only `publication.test.ts` separator failure may remain on Windows; it passes on CI Linux — ignore it).

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/src/job-prompts.ts apps/watcher/src/runners/chat.ts apps/watcher/src/job-prompts.test.ts apps/watcher/src/runners/chat.test.ts
git commit -m "feat(watcher): run verify_document through the chat runner"
```

---

### Task 4: Persist findings on the patrol run (stores + migration)

**Files:**
- Modify: `apps/api/src/stores/patrol-store.ts`
- Modify: `apps/api/src/stores/postgres-patrol-store.ts`
- Create: `packages/db/migrations/0028_patrol_findings.sql`
- Test: `apps/api/src/stores/patrol-store.test.ts`, `apps/api/src/stores/postgres-patrol-store.test.ts`

**Interfaces:**
- Consumes: `VerifyFinding` (Task 1).
- Produces: `PatrolRunInput.findings?: VerifyFinding[]`; both stores persist/return `PatrolRun.findings` (defaulting to `[]`).

- [ ] **Step 1: Add the in-memory findings test (RED)**

In `apps/api/src/stores/patrol-store.test.ts`, add:

```ts
test("createRun records and returns findings, defaulting to an empty array", async () => {
  const store = new InMemoryPatrolStore();
  const withFindings = await store.createRun({
    trigger: "scheduled", universeCount: 1, selectedCount: 1, selected: ["a.md"],
    findings: [{ path: "a.md", claims: [{ claim: "c", reason: "r" }], decision: "open-new" }]
  });
  assert.equal((await store.getRun(withFindings.id))?.findings.length, 1);
  const noFindings = await store.createRun({ trigger: "scheduled", universeCount: 0, selectedCount: 0, selected: [] });
  assert.deepEqual((await store.getRun(noFindings.id))?.findings, []);
});
```

- [ ] **Step 2: Run it (expect FAIL — TS error: `findings` not on `PatrolRunInput`)**

Run: `npm test -w @magpie/api`
Expected: FAIL (compile error or missing `findings`).

- [ ] **Step 3: Implement in-memory findings**

In `apps/api/src/stores/patrol-store.ts`: import the type — change `import type { PatrolRun } from "@magpie/core";` to `import type { PatrolRun, VerifyFinding } from "@magpie/core";`. Add to `PatrolRunInput`:

```ts
  selected: string[];
  findings?: VerifyFinding[];
}
```

In `InMemoryPatrolStore.createRun`, add `findings` to the run object (after `selected: input.selected,`):

```ts
      selected: input.selected,
      findings: input.findings ?? [],
      createdAt: new Date().toISOString()
```

- [ ] **Step 4: Run it (expect GREEN for the in-memory test)**

Run: `npm test -w @magpie/api -- --test-name-pattern "createRun records and returns findings"`
Expected: PASS. (If the runner doesn't support that flag in this repo, run `npm test -w @magpie/api` and confirm the new test passes.)

- [ ] **Step 5: Add the migration**

Create `packages/db/migrations/0028_patrol_findings.sql`:

```sql
-- Verify-lens findings recorded on each fix-patrol run (path + unprovable claims +
-- the reconcile gate's decision). Defaults to an empty array so existing rows and
-- lens-less runs are valid.
ALTER TABLE patrol_runs
  ADD COLUMN findings jsonb NOT NULL DEFAULT '[]'::jsonb;
```

- [ ] **Step 6: Implement Postgres findings**

In `apps/api/src/stores/postgres-patrol-store.ts`:
- Import: `import type { PatrolRun, VerifyFinding } from "@magpie/core";`
- In `createRun`, change the INSERT to include `findings`:

```ts
    const result = await this.pool.query<PatrolRunRow>(
      `
        INSERT INTO patrol_runs (id, flow_id, trigger, universe_count, selected_count, selected, findings)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [id, runFlowId(input.flowId), input.trigger, input.universeCount, input.selectedCount, JSON.stringify(input.selected), JSON.stringify(input.findings ?? [])]
    );
```

- In `PatrolRunRow`, add `findings: VerifyFinding[];` after `selected: string[];`.
- In `mapRunRow`, add `findings: row.findings ?? [],` after `selected: row.selected,`.

- [ ] **Step 7: Add the Postgres findings assertion**

In `apps/api/src/stores/postgres-patrol-store.test.ts`, extend the `createRun` block (after the existing `selected` assertion) — pass findings and read them back:

```ts
  const run = await store.createRun({
    flowId: "billing",
    trigger: "scheduled",
    universeCount: 5,
    selectedCount: 2,
    selected: ["a.md", "b.md"],
    findings: [{ path: "a.md", claims: [{ claim: "c", reason: "r" }], decision: "open-new" }]
  });
  assert.deepEqual((await store.getRun(run.id))?.selected, ["a.md", "b.md"]);
  assert.equal((await store.getRun(run.id))?.findings.length, 1);
```

(This test is skipped unless `DATABASE_URL` is set; it runs against the migrated schema on CI / `npm run test:db`.)

- [ ] **Step 8: Run the API store tests (expect GREEN)**

Run: `npm test -w @magpie/api`
Expected: the patrol-store tests pass; the postgres-patrol-store test is skipped locally (no `DATABASE_URL`).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/stores/patrol-store.ts apps/api/src/stores/postgres-patrol-store.ts packages/db/migrations/0028_patrol_findings.sql apps/api/src/stores/patrol-store.test.ts apps/api/src/stores/postgres-patrol-store.test.ts
git commit -m "feat(patrol): persist verify findings on the patrol run"
```

---

### Task 5: The verify lens module

**Files:**
- Create: `apps/api/src/scheduling/verify-lens.ts`
- Test: `apps/api/src/scheduling/verify-lens.test.ts`

**Interfaces:**
- Consumes: `decideReconciliation`, `openPullRequestSummaries` (`reconcile-gate.js`); `sameFlowOpenProposals` (`flow.js`); `ChangeIntent` (`intent.js`); core verify types.
- Produces: `verifyIntent(flowId, path, claims): ChangeIntent`; `type VerifyDocumentFn = (ctx, input) => Promise<VerifyDocumentJobOutput | undefined>`; `runVerifyLens(ctx, { flowId, documents, sources, verifyDocument }): Promise<VerifyFinding[]>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/scheduling/verify-lens.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { VerifyDocumentJobOutput } from "@magpie/core";
import { makeTestContext } from "../test-support/context.js";
import { runVerifyLens, verifyIntent, type VerifyDocumentFn } from "./verify-lens.js";

const HEALTHY: VerifyDocumentJobOutput = { verdict: "healthy", claims: [] };
const UNPROVABLE: VerifyDocumentJobOutput = {
  verdict: "unprovable",
  claims: [{ claim: "Refunds take 5 days", reason: "source says 7" }]
};

function fixedVerifier(byPath: Record<string, VerifyDocumentJobOutput>): VerifyDocumentFn {
  return async (_ctx, input) => byPath[input.path] ?? HEALTHY;
}

test("verifyIntent builds a verify intent targeting the document with claims as evidence", () => {
  const intent = verifyIntent("billing", "kb/a.md", UNPROVABLE.claims);
  assert.equal(intent.lens, "verify");
  assert.equal(intent.flowId, "billing");
  assert.deepEqual(intent.targets, ["kb/a.md"]);
  assert.deepEqual(intent.evidence, ["Refunds take 5 days"]);
});

test("a healthy verdict produces no finding", async () => {
  const ctx = makeTestContext();
  const findings = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({})
  });
  assert.deepEqual(findings, []);
});

test("an unprovable verdict with no overlapping PR yields an open-new finding", async () => {
  const ctx = makeTestContext();
  const findings = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({ "a.md": UNPROVABLE })
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "a.md");
  assert.equal(findings[0].decision, "open-new");
  assert.equal(findings[0].claims.length, 1);
});

test("an unprovable verdict overlapping a touchable open PR folds into it", async () => {
  const ctx = makeTestContext();
  await ctx.stores.proposals.create({
    title: "Refunds", gapSummary: "g", targetPath: "a.md", markdown: "m", rationale: "r", evidence: []
  });
  const open = (await ctx.stores.proposals.list(10))[0];
  await ctx.stores.proposals.updateStatus(open.id, "pr-opened");

  const findings = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "a.md", content: "x" }],
    sources: [],
    verifyDocument: fixedVerifier({ "a.md": UNPROVABLE })
  });
  assert.equal(findings[0].decision, "fold");
  assert.equal(findings[0].intoProposalId, open.id);
});

test("a verifier that throws for one doc skips it and still processes the rest", async () => {
  const ctx = makeTestContext();
  const verifyDocument: VerifyDocumentFn = async (_ctx, input) => {
    if (input.path === "bad.md") throw new Error("model exploded");
    return UNPROVABLE;
  };
  const findings = await runVerifyLens(ctx, {
    flowId: undefined,
    documents: [{ path: "bad.md", content: "x" }, { path: "good.md", content: "y" }],
    sources: [],
    verifyDocument
  });
  assert.deepEqual(findings.map((f) => f.path), ["good.md"]);
});
```

> **Note for the implementer:** verify the exact `ctx.stores.proposals.create(...)` argument shape against `apps/api/src/stores/proposal-store.ts` (`InMemoryProposalStore.create`) and the `updateStatus` signature before running; adjust the call in the fold test to match the real store API (the assertion — `decision: "fold"`, `intoProposalId: open.id` — stays). The proposal must end up with `status: "pr-opened"` and `targetPath: "a.md"` so `openPullRequestSummaries` treats it as a touchable open PR.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @magpie/api`
Expected: FAIL — `./verify-lens.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `apps/api/src/scheduling/verify-lens.ts`:

```ts
import type { SourceDataContext, UnprovableClaim, VerifyDocumentJobInput, VerifyDocumentJobOutput, VerifyFinding } from "@magpie/core";
import type { AppContext } from "../context.js";
import type { ChangeIntent } from "./intent.js";
import { decideReconciliation, openPullRequestSummaries } from "./reconcile-gate.js";
import { sameFlowOpenProposals } from "./flow.js";

// Runs the verify check for one document. The default implementation (in the
// patrol service) enqueues a verify_document AI job and bounded-waits for it;
// tests inject a deterministic fake. Returns undefined when the verdict could not
// be obtained (job failed/timed out/malformed) so the lens simply skips that doc.
export type VerifyDocumentFn = (
  ctx: AppContext,
  input: VerifyDocumentJobInput & { flowId: string | undefined }
) => Promise<VerifyDocumentJobOutput | undefined>;

// Builds the verify lens's change intent for the reconcile gate. decideReconciliation
// consumes only `targets`; evidence/rationale are populated for logging and the
// future corrective-PR increment.
export function verifyIntent(flowId: string | undefined, path: string, claims: UnprovableClaim[]): ChangeIntent {
  return {
    lens: "verify",
    flowId,
    targets: [path],
    evidence: claims.map((claim) => claim.claim),
    rationale: `verify: ${claims.length} unprovable claim(s) in ${path}`
  };
}

// Runs the verify lens over the selected documents: check each against the shared
// source material, and for every "unprovable" verdict emit a verify intent through
// the reconcile gate (same-flow open PRs only) and record a finding. Healthy docs
// are silent. A per-doc failure is logged and skipped — one bad doc never aborts
// the tick.
export async function runVerifyLens(
  ctx: AppContext,
  input: {
    flowId: string | undefined;
    documents: Array<{ path: string; content: string }>;
    sources: SourceDataContext[];
    verifyDocument: VerifyDocumentFn;
  }
): Promise<VerifyFinding[]> {
  const openPrs = openPullRequestSummaries(await sameFlowOpenProposals(ctx, input.flowId));
  const findings: VerifyFinding[] = [];

  for (const document of input.documents) {
    let verdict: VerifyDocumentJobOutput | undefined;
    try {
      verdict = await input.verifyDocument(ctx, {
        path: document.path,
        content: document.content,
        sources: input.sources,
        flowId: input.flowId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "verify failed";
      console.warn(`Verify lens: skipping ${document.path} — ${message}.`);
      continue;
    }

    if (!verdict || verdict.verdict === "healthy" || verdict.claims.length === 0) {
      continue;
    }

    const decision = decideReconciliation(verifyIntent(input.flowId, document.path, verdict.claims), openPrs);
    findings.push({
      path: document.path,
      claims: verdict.claims,
      decision: decision.kind === "fold" ? "fold" : decision.kind === "defer" ? "defer" : "open-new",
      ...(decision.kind === "fold" ? { intoProposalId: decision.intoProposalId } : {})
    });
  }

  return findings;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @magpie/api`
Expected: the five verify-lens tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/verify-lens.ts apps/api/src/scheduling/verify-lens.test.ts
git commit -m "feat(patrol): verify lens — intent builder + gate-aware finding loop"
```

---

### Task 6: Wire the verify lens into runFixPatrol

**Files:**
- Modify: `apps/api/src/features/patrol/service.ts`
- Test: `apps/api/src/features/patrol/service.test.ts`

**Interfaces:**
- Consumes: `runVerifyLens`, `VerifyDocumentFn` (Task 5); `collectSourceContext` (`platform/source-context.js`); `runJobToCompletion` (`features/jobs/service.js`); `verifyDocumentOutputSchema` (`@magpie/jobs`); `selectFlow` (`platform/repositories.js`).
- Produces: `runFixPatrol(ctx, options, deps?)` runs the lens and records `findings` on the run; default `deps.verifyDocument` enqueues `verify_document` and bounded-waits.

- [ ] **Step 1: Update existing service tests to inject a verifier (keep them offline/fast)**

In `apps/api/src/features/patrol/service.test.ts`, add near the top:

```ts
import type { VerifyDocumentFn } from "../../scheduling/verify-lens.js";

// A verifier that reports every document healthy, so the cursor/run tests stay
// offline and fast (the default verifier would enqueue a verify_document job and
// bounded-wait on the never-completing fake broker).
const HEALTHY_DEPS: { verifyDocument: VerifyDocumentFn } = {
  verifyDocument: async () => ({ verdict: "healthy", claims: [] })
};
```

Then pass `HEALTHY_DEPS` as the third argument to **every** `patrol.runFixPatrol(ctx, { ... })` call in the existing tests, e.g.:

```ts
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, HEALTHY_DEPS);
```

(The `unknown_flow` test returns before any verify work, so it may keep or add `HEALTHY_DEPS` — either is fine.)

- [ ] **Step 2: Add the findings test (RED)**

Add to `apps/api/src/features/patrol/service.test.ts`:

```ts
test("runFixPatrol records verify findings for unprovable documents", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md"]);
  const verifyDocument: VerifyDocumentFn = async (_ctx, input) =>
    input.path === "a.md"
      ? { verdict: "unprovable", claims: [{ claim: "stale", reason: "no source" }] }
      : { verdict: "healthy", claims: [] };

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" }, { verifyDocument });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  // Every selected doc is still stamped, regardless of verdict.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.deepEqual(cursor.map((e) => e.docPath).sort(), [...outcome.run.selected].sort());

  // The unprovable doc produced one open-new finding; the healthy one produced none.
  const aFindings = outcome.run.findings.filter((f) => f.path === "a.md");
  assert.equal(aFindings.length, 1);
  assert.equal(aFindings[0].decision, "open-new");
  assert.equal(outcome.run.findings.some((f) => f.path === "b.md"), false);
});
```

- [ ] **Step 3: Run it (expect FAIL)**

Run: `npm test -w @magpie/api`
Expected: FAIL — `runFixPatrol` ignores the third arg / records no findings.

- [ ] **Step 4: Implement the wiring**

Edit `apps/api/src/features/patrol/service.ts`. Update the imports at the top:

```ts
import type { AppContext } from "../../context.js";
import type { PatrolRun, VerifyDocumentJobInput } from "@magpie/core";
import { verifyDocumentOutputSchema } from "@magpie/jobs";
import { selectFlow } from "../../platform/repositories.js";
import { selectPatrolBatch } from "../../scheduling/patrol-cursor.js";
import { runVerifyLens, type VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import { collectSourceContext } from "../../platform/source-context.js";
import { runJobToCompletion } from "../jobs/service.js";
import { type AiProviderName } from "../../platform/providers.js";
```

Change `resolveRepositoryIds` to also return the flow's source ids:

```ts
function resolveRepositoryIds(
  ctx: AppContext,
  flowId: string | undefined
):
  | { ok: true; repositoryIds: string[] | undefined; sourceIds: string[] | undefined }
  | { ok: false; code: "unknown_flow" } {
  if (!flowId) {
    return { ok: true, repositoryIds: undefined, sourceIds: undefined };
  }
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  if (!flow) {
    return { ok: false, code: "unknown_flow" };
  }
  return {
    ok: true,
    repositoryIds: flow.destinationId ? [flow.destinationId] : undefined,
    sourceIds: flow.sourceIds
  };
}
```

Add the default verifier (after the constants, before `runFixPatrol`):

```ts
// Default verify: enqueue a verify_document AI job and bounded-wait for the watcher
// to complete it (mirrors gap-reconciler's reshape job). Returns undefined on any
// non-completion so the lens skips that document rather than failing the tick.
const defaultVerifyDocument: VerifyDocumentFn = async (ctx, { path, content, sources }) => {
  const input = {
    path,
    content,
    sources,
    provider: ctx.config.get().aiProvider
  } satisfies VerifyDocumentJobInput & { provider: AiProviderName };
  let terminal;
  try {
    terminal = await runJobToCompletion(ctx, "verify_document", input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "verify job failed";
    console.warn(`Verify lens: verify_document for ${path} could not run — ${message}.`);
    return undefined;
  }
  if (terminal.state !== "completed") {
    return undefined;
  }
  const parsed = verifyDocumentOutputSchema.safeParse(terminal.output);
  return parsed.success ? parsed.data : undefined;
};
```

Replace the body of `runFixPatrol` (keep the signature change adding `deps`):

```ts
export async function runFixPatrol(
  ctx: AppContext,
  options: { flowId?: string; trigger: PatrolRun["trigger"] },
  deps: { verifyDocument: VerifyDocumentFn } = { verifyDocument: defaultVerifyDocument }
): Promise<FixPatrolOutcome> {
  const scope = resolveRepositoryIds(ctx, options.flowId);
  if (!scope.ok) {
    return scope;
  }

  const documents = ctx.stores.knowledgeIndex
    .listDocuments()
    .filter((doc) => !scope.repositoryIds || scope.repositoryIds.includes(doc.repositoryId));
  const universe = documents.map((doc) => doc.path);

  const cursor = await ctx.stores.patrol.listCursor(options.flowId);
  const checkedAt = new Map(cursor.map((entry) => [entry.docPath, entry.lastCheckedAt]));

  const selected = selectPatrolBatch(universe, checkedAt, {
    batchSize: PATROL_BATCH_SIZE,
    randomCount: PATROL_RANDOM_COUNT
  });

  // Run the verify lens over the selected documents. Source material is the same
  // for every doc in the flow, so collect it once per tick (only when there is at
  // least one doc to check).
  const selectedSet = new Set(selected);
  const selectedDocuments = documents
    .filter((doc) => selectedSet.has(doc.path))
    .map((doc) => ({ path: doc.path, content: doc.content }));
  const sources = selectedDocuments.length > 0 ? await collectSourceContext(ctx.repositoryDeps(), scope.sourceIds) : [];
  const findings = await runVerifyLens(ctx, {
    flowId: options.flowId,
    documents: selectedDocuments,
    sources,
    verifyDocument: deps.verifyDocument
  });

  await ctx.stores.patrol.stampChecked(options.flowId, selected);

  const run = await ctx.stores.patrol.createRun({
    flowId: options.flowId,
    trigger: options.trigger,
    universeCount: universe.length,
    selectedCount: selected.length,
    selected,
    findings
  });
  console.log(
    `Fix-patrol (${options.trigger}) flow=${options.flowId ?? "(default)"}: ` +
      `checked ${selected.length}/${universe.length} document(s), ${findings.length} finding(s); run ${run.id}.`
  );
  return { ok: true, run };
}
```

Remove the now-unused old no-op comment block. Leave `listRuns`/`getRun` unchanged.

- [ ] **Step 5: Run the tests (expect GREEN)**

Run: `npm test -w @magpie/api`
Expected: the new findings test passes and all existing patrol service tests still pass (they inject `HEALTHY_DEPS`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/features/patrol/service.ts apps/api/src/features/patrol/service.test.ts
git commit -m "feat(patrol): run the verify lens over the selected batch in runFixPatrol"
```

---

### Task 7: Surface findingCount on the job output

**Files:**
- Modify: `packages/jobs/src/schemas.ts` (`fixPatrolOutputSchema`)
- Modify: `apps/api/src/features/patrol/routes.ts`
- Modify: `apps/watcher/src/runners/maintenance.ts`
- Modify: `apps/watcher/src/http-client.ts`
- Test: `packages/jobs/src/catalog.test.ts`, `apps/watcher/src/runners/maintenance.test.ts`, `apps/watcher/src/runners/chat.test.ts`, `apps/watcher/src/runners/refresh-pull-requests.test.ts`, `apps/watcher/src/runners/publication.test.ts`

**Interfaces:**
- Produces: `fixPatrolOutputSchema` gains `findingCount: number`; `WatcherApi.runFixPatrol` returns `{ runId; selectedCount; findingCount }`; the `/api/fix-patrol/run` route returns `findingCount`.

- [ ] **Step 1: Update the catalog output test (RED)**

In `packages/jobs/src/catalog.test.ts`, change the `fix_patrol` output assertion to require `findingCount`:

```ts
  assert.ok(jobDefinition("fix_patrol").outputSchema.safeParse({ runId: "r1", selectedCount: 3, findingCount: 1 }).success);
  assert.ok(!jobDefinition("fix_patrol").outputSchema.safeParse({ runId: "r1", selectedCount: 3 }).success);
```

- [ ] **Step 2: Run it (expect FAIL)**

Run: `npm test -w @magpie/jobs`
Expected: FAIL — `findingCount` is not yet required.

- [ ] **Step 3: Add findingCount to the schema**

In `packages/jobs/src/schemas.ts`, update `fixPatrolOutputSchema`:

```ts
export const fixPatrolOutputSchema = z.object({
  runId: z.string(),
  selectedCount: z.number().int(),
  findingCount: z.number().int()
});
```

- [ ] **Step 4: Return findingCount from the route**

In `apps/api/src/features/patrol/routes.ts`, update the `POST /run` response:

```ts
    return c.json({ runId: outcome.run.id, selectedCount: outcome.run.selectedCount, findingCount: outcome.run.findings.length });
```

- [ ] **Step 5: Thread findingCount through the watcher**

In `apps/watcher/src/http-client.ts`, update the `runFixPatrol` interface signature and the `HttpWatcherApi.runFixPatrol` implementation return type to `Promise<{ runId: string; selectedCount: number; findingCount: number }>` (change both the interface member and the method, and the inner `this.post<...>` generic).

In `apps/watcher/src/runners/maintenance.ts`, update `runFixPatrol`:

```ts
  private async runFixPatrol(job: JobView, signal: AbortSignal): Promise<unknown> {
    const flowId = readFlowId(job.input);
    console.log(`fix_patrol[${job.id}]: patrolling flow ${flowId ?? "(default)"}`);
    const { runId, selectedCount, findingCount } = await this.api.runFixPatrol(flowId, signal);
    console.log(`fix_patrol[${job.id}]: checked ${selectedCount} document(s), ${findingCount} finding(s) (run ${runId})`);
    return fixPatrolOutputSchema.parse({ runId, selectedCount, findingCount });
  }
```

- [ ] **Step 6: Update the four WatcherApi test stubs**

In each of `apps/watcher/src/runners/maintenance.test.ts`, `chat.test.ts`, `refresh-pull-requests.test.ts`, `publication.test.ts`, change the `runFixPatrol` stub to include `findingCount`:

```ts
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
```

If `maintenance.test.ts` has a dedicated test asserting the fix_patrol return shape, update its expected object to include `findingCount`.

- [ ] **Step 7: Run the jobs + watcher tests (expect GREEN)**

Run: `npm test -w @magpie/jobs && npm test -w @magpie/watcher`
Expected: PASS (ignore the pre-existing Windows-only `publication.test.ts` path-separator failure; it passes on CI Linux).

- [ ] **Step 8: Commit**

```bash
git add packages/jobs/src/schemas.ts packages/jobs/src/catalog.test.ts apps/api/src/features/patrol/routes.ts apps/watcher/src/runners/maintenance.ts apps/watcher/src/http-client.ts apps/watcher/src/runners/maintenance.test.ts apps/watcher/src/runners/chat.test.ts apps/watcher/src/runners/refresh-pull-requests.test.ts apps/watcher/src/runners/publication.test.ts
git commit -m "feat(patrol): report verify findingCount on the fix_patrol job output"
```

---

### Task 8: Full-suite verification & gate checks

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all workspaces pass (the Windows-only `publication.test.ts` separator failure is the only acceptable local failure; confirm it is unrelated to verify work).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Dead-code (knip strict)**

Run: `npm run deadcode`
Expected: no unused exports. If `verifyIntent`, `VerifyDocumentFn`, or any new type is flagged, confirm it is consumed cross-file (test files count); de-export or inline anything used only within its own file.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore(patrol): verify lens — typecheck/knip fixups"
```

(Skip if nothing changed.)

---

## Self-Review

**Spec coverage:**
- §3.1 verify_document job → Task 1. §3.2 prompt → Task 2. §3.3 watcher wiring → Task 3.
- §3.4 verify lens module → Task 5. §3.5 findings on run + stores + migration → Task 4.
- §3.6 runFixPatrol wiring → Task 6. §3.7 output schema + stubs → Task 7. §5 testing → spread across tasks. §6 gates → Task 8.
- Out-of-scope items (no corrective PR, no per-claim citations, no `lastVerified` write) are honoured: nothing in the tasks generates a changeset/PR or writes doc metadata.

**Placeholder scan:** none — every code step carries concrete code; the one "verify the store API" note (Task 5 Step 1) is a real instruction with the assertion fixed and the shape to confirm named.

**Type consistency:** `VerifyDocumentFn` signature (`(ctx, { path, content, sources, flowId }) => Promise<VerifyDocumentJobOutput | undefined>`) is identical in Task 5 (definition), Task 6 (default impl + injection), and the tests. `VerifyFinding` fields (`path`, `claims`, `decision`, `intoProposalId?`) match across core (Task 1), stores (Task 4), and the lens (Task 5). `findingCount` naming is consistent across Task 7 (schema, route, watcher, stubs). `PatrolRunInput.findings` is optional; `PatrolRun.findings` is required and defaulted to `[]` by both stores.
