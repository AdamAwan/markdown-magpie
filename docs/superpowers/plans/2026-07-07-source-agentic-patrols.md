# Source-Agentic Patrols + Demolition (Increment 3) Implementation Plan

> **STATUS — IN PROGRESS (2026-07-07).** Task-by-task execution on branch
> `claude/source-agentic-increment-3-zc9tyw`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the patrol maintenance jobs (`verify_document` / `correct_document` /
`improve_document` — the ones that today consume the shared source corpus via
`sourcesRef` → `api.getSourceCorpus`) onto the source-agentic grounding model, then
demolish the entire legacy corpus pipeline: `collectSourceContext` and the sampler
file-walk, `sourcesRef`, `getSourceCorpus` (endpoint, client method, cache), the corpus
store (in-memory + Postgres + table), and the `SourceDataContext` type.

**Architecture:** Increments 1–2 shipped all the machinery — `SourceDescriptor`
(`packages/core/src/index.ts:795`), `sourceDescriptorSchema` (`packages/jobs/src/schemas.ts:137`),
`projectSourceDescriptors` (`apps/api/src/platform/source-descriptors.ts`),
`prepareSourceWorkspaces`/`hasFsSources`/`sourceDescriptorsOf`
(`apps/watcher/src/source-workspace.ts`), `source-tools.ts`, `buildSourceGroundedPrompt`
(`apps/watcher/src/job-prompts.ts:121`), `runSourceAgentJob`
(`apps/watcher/src/runners/source-agent.ts`), and the dispatch branches in
`CliRunner.run()` (`runners/cli.ts:105-120`) and `ChatRunner.run()` (`runners/chat.ts:29-46`).
This increment is a contract swap on the three patrol child jobs plus the demolition the
spec defers to here: (1) `sources: SourceDescriptor[]` replaces `sourcesRef: string` on
their inputs; (2) the patrol tick projects descriptors instead of sampling a corpus, and
the change gate re-keys onto a descriptor hash; (3) the three prompts gain the exploration
contract; (4) `sourceDescriptorsOf` learns the three types, which lights up the existing
runner dispatch with no new runner code; (5) everything corpus-shaped is deleted and knip
enforces it. Spec: `docs/superpowers/specs/2026-07-06-source-agentic-grounding-design.md`
(increment 3, "Contract: source descriptors", "Error handling"). Reference plans:
`2026-07-06-source-agentic-seeding.md`, `2026-07-06-source-agentic-gap-drafting.md`.

**Tech Stack:** TypeScript ESM/NodeNext, zod, node:test, plain SQL migration
(`packages/db/migrations`, custom migrator).

## Global Constraints

- ESM/NodeNext: relative imports need explicit `.js` extensions, even from `.ts`.
- Never cast through `unknown`/`any` to silence types; no hacky workarounds.
- Tests: `node:test`, colocated `*.test.ts`. Run via `npm test -w <workspace>` (never
  root-cwd `node --test`). Cross-package type changes need `npm run build` before
  dependent workspace tests.
- knip runs STRICT in CI (`npm run deadcode`): de-export/delete anything unused, never
  relax `knip.json`.
- `npm run format:check` is NOT a CI gate and fails repo-wide under the lockfile'd
  prettier; do NOT `prettier --write` the repo. CI gates
  (`.github/workflows/verify.yml`): build, typecheck, lint (0 errors), test, deadcode.
- `npm run build` emits stray `.js`/`.d.ts` artifacts into `src/` (untracked). Commit by
  EXPLICIT paths — never `git add -A` blindly after a build — and `git clean -n` those
  artifacts before trusting a local `deadcode` run.
- Commit and push after every task. UK English in docs and prompts.
- **Scope:** `dedupe_documents` and `split_document` do NOT migrate — they compare the
  document against destination neighbours, never against sources (no `sourcesRef` on
  their inputs). `outline_flow_seed` remains destination-grounded and unchanged.
- In-flight verify/correct/improve jobs enqueued with the old `sourcesRef` shape will
  fail schema validation after deploy — acceptable (single-operator; the next patrol
  tick re-enqueues). Same stance increments 1–2 took.

## Design decision — the change gate loses source-content sensitivity (recorded)

The patrol change gate (#163) skips a doc when its content hash AND `sourcesHash` match
the last checked state. Today `sourcesHash = hashSourceCorpus(sampledFiles)` — a source
edit that reached the ≤24-file sample re-armed every doc's gate. After this increment
there is no corpus snapshot to fingerprint (the agent explores live checkouts at job
runtime), so `sourcesHash` becomes `hashSourceDescriptors(descriptors)`: the gate re-arms
when the **document body** changes or the flow's **source configuration** changes (a
source added/removed/re-pointed/re-scoped). A source-content-only change no longer busts
the gate. This is accepted because (a) the old signal was already a 24-file sample of the
first three sources — statistically blind on real codebases, the exact failure this
feature kills; (b) verification now reads the live checkout, so *when* a check runs it is
always against current source truth; (c) the first post-deploy tick re-checks everything
once (prior corpus-based hashes can never equal a descriptor hash). If freshness against
source churn is wanted later, a time-based re-arm is the follow-up, not a corpus revival.

Second decision: the verify/correct/improve **queue expirations rise 10 → 15 minutes**
(matching the draft jobs — agentic exploration runs up to `MAGPIE_AGENTIC_TIMEOUT_MS`,
default 10 min, and needs queue headroom), but the patrol tick's bounded wait on
`verify_document` stays pinned at 10 minutes via an explicit `deadlineMs`. Without the
pin, `runJobToCompletion`'s default deadline follows `expireInSeconds` to 15 minutes —
the entire maintenance POST envelope (`DEFAULT_MAINTENANCE_TIMEOUT_MS`,
`apps/watcher/src/http-client.ts:126`) — so one hung verify would abort the whole tick
instead of being skipped.

---

### Task 1: Contract swap + API patrol rewire (one green commit)

The core/jobs contract change and the API-side rewiring land together: removing
`sourcesRef` from the core inputs breaks `apps/api` compilation until the patrol service
is rewired, and rewiring the patrol service makes `collectSourceContext` and
`hashSourceCorpus` dead, which knip would flag — so both die here too. This is the
"become deletable exactly when patrols migrate" moment; everything corpus-*store*-shaped
survives until Task 4.

**Files:**
- Modify: `packages/core/src/index.ts` (~679–688 `VerifyDocumentJobInput`, ~697–709
  `CorrectDocumentJobInput`, ~757–765 `ImproveDocumentJobInput`)
- Modify: `packages/jobs/src/schemas.ts` (~349–354 verify, ~360–368 correct, ~410–417
  improve)
- Modify: `packages/jobs/src/schemas.test.ts` (~24–34, ~164), `packages/jobs/src/catalog.test.ts`
- Modify: `packages/jobs/src/catalog.ts` (~104–108: verify/correct/improve expirations)
- Modify: `apps/api/src/scheduling/patrol-hash.ts` + `patrol-hash.test.ts`
- Modify: `apps/api/src/scheduling/verify-lens.ts` (~36, 58, 72) + `verify-lens.test.ts`
- Modify: `apps/api/src/features/patrol/service.ts`
- Delete: `apps/api/src/platform/source-context.ts` (no test file exists for it)
- Modify tests: `apps/api/src/features/patrol/service.test.ts`,
  `apps/api/src/features/jobs/service.test.ts` (~456, 489, 838),
  `apps/api/src/features/proposals/service.test.ts` (~1531, 1700)

**Interfaces:**
- Produces (Tasks 2–4 consume): `VerifyDocumentJobInput.sources: SourceDescriptor[]`,
  `CorrectDocumentJobInput.sources`, `ImproveDocumentJobInput.sources` (each replaces
  `sourcesRef: string`); updated zod schemas; `hashSourceDescriptors(sources)` in
  `patrol-hash.ts`.
- Consumes: `SourceDescriptor` / `sourceDescriptorSchema` / `projectSourceDescriptors`
  (increment 1, unchanged).

- [x] **Step 1: Write the failing schema test**

In `packages/jobs/src/catalog.test.ts`, next to the seed/proposal descriptor tests, add:

```ts
it("patrol child-job inputs carry source descriptors, not a corpus ref", () => {
  const sources = [
    { id: "src-1", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" },
    { id: "src-2", name: "Agent knowledge", kind: "agent" }
  ];
  const verify = { provider: "openai-compatible", path: "kb/a.md", content: "# A", sources };
  const correct = {
    provider: "openai-compatible",
    path: "kb/a.md",
    content: "# A",
    claims: [{ claim: "x", reason: "y" }],
    sources
  };
  const improve = { provider: "openai-compatible", path: "kb/a.md", content: "# A", sources };
  assert.equal(verifyDocumentInputSchema.safeParse(verify).success, true);
  assert.equal(correctDocumentInputSchema.safeParse(correct).success, true);
  assert.equal(improveDocumentInputSchema.safeParse(improve).success, true);
  const legacy = { provider: "openai-compatible", path: "kb/a.md", content: "# A", sourcesRef: "hash" };
  assert.equal(verifyDocumentInputSchema.safeParse(legacy).success, false);
  assert.equal(improveDocumentInputSchema.safeParse(legacy).success, false);
});
```

Import the three schemas at the top of the file if not present. Run
`npm run build && npm test -w packages/jobs` → the new test FAILS (schemas still require
`sourcesRef`).

- [x] **Step 2: Change the core types**

In `packages/core/src/index.ts`, replace the three `sourcesRef: string;` fields. For
`VerifyDocumentJobInput` (~679–688), also rewrite the interface comment (it describes the
content-addressed corpus, which is going away):

```ts
// Input to the verify_document AI job: one knowledge-base document plus references
// to the flow's configured sources to check it against. The executing agent
// explores those checkouts directly (see the source-agentic grounding spec);
// git/local descriptors resolve to read-only workspaces on the watcher, while
// internet/agent render as prompt notes only. `provider` is added at enqueue
// (see @magpie/jobs).
export interface VerifyDocumentJobInput {
  path: string;
  content: string;
  sources: SourceDescriptor[];
}
```

For `CorrectDocumentJobInput` and `ImproveDocumentJobInput`, replace their `sourcesRef`
field (and its `#163` comment) with:

```ts
  // References to the flow's configured sources the repair/expansion is grounded
  // in — the executing agent explores these checkouts directly (see
  // VerifyDocumentJobInput). Replaces the old shared-corpus reference.
  sources: SourceDescriptor[];
```

Keep every other field (`claims`, `destinationId`, `flowId`) unchanged.
`SourceDescriptor` is declared later in the same file — no import needed.

- [x] **Step 3: Update the jobs schemas**

In `packages/jobs/src/schemas.ts`, in each of `verifyDocumentInputSchema` (~353),
`correctDocumentInputSchema` (~365), `improveDocumentInputSchema` (~414), replace
`sourcesRef: z.string(),` with:

```ts
  sources: z.array(sourceDescriptorSchema),
```

`sourceDescriptorSchema` is defined at ~line 137 in this file. The
`satisfies z.ZodType<ProviderInput<...>>` clauses enforce agreement with Step 2.

- [x] **Step 4: Fix the jobs test fixtures and run**

In `packages/jobs/src/schemas.test.ts`: the verify round-trip test (~24–33) and the
"requires a sourcesRef" test (~34) — reshape to `sources` (round-trip a git descriptor;
the "requires" test now asserts a missing `sources` fails). The correct fixture at ~164
swaps `sourcesRef: "corpus-hash"` for `sources: []`.

Run: `npm run build -w packages/core -w packages/jobs && npm test -w packages/jobs && npm test -w packages/core`
Expected: PASS. (Root `npm run build` still fails — apps/api is rewired below.)

- [x] **Step 5: Raise the three queue expirations**

In `packages/jobs/src/catalog.ts` (~104–108), change the `expireInSeconds` argument for
`verify_document`, `correct_document`, and `improve_document` from `10 * 60` to
`15 * 60`, with one comment above the trio:

```ts
  // verify/correct/improve are source-grounded agentic jobs (increment 3): like
  // the draft jobs, exploration runs for minutes (MAGPIE_AGENTIC_TIMEOUT_MS
  // defaults to 10), so the queue must not expire them at a one-shot horizon.
```

`dedupe_documents` / `split_document` stay at `10 * 60` (not source-grounded).

- [x] **Step 6: Re-key the change-gate hash**

In `apps/api/src/scheduling/patrol-hash.ts`, delete `hashSourceCorpus` and its
`SourceDataContext` import; add (keep `hashDocumentContent` untouched; import
`SourceDescriptor` from `@magpie/core`):

```ts
// Hash of the source-descriptor set a flow's lenses are grounded in. Since the
// agentic migration there is no corpus snapshot to fingerprint — the executing
// agent explores live checkouts at job runtime — so the gate re-arms when the
// document body changes or the flow's source *configuration* changes (a source
// added, removed, re-pointed, or re-scoped). A source-content-only change no
// longer busts the gate: an accepted trade-off recorded in the increment-3 plan
// (the old corpus hash only ever saw a 24-file sample anyway, and every check now
// reads current source truth when it runs). Order-independent, and each
// descriptor is digested to fixed length first so no field/row boundary a flat
// join could make ambiguous exists.
export function hashSourceDescriptors(sources: readonly SourceDescriptor[]): string {
  const perSource = sources
    .map((source) =>
      createHash("sha256")
        .update(source.id)
        .update("\0")
        .update(source.kind)
        .update("\0")
        .update(source.name)
        .update("\0")
        .update(source.kind === "git" || source.kind === "internet" ? (source.url ?? "") : "")
        .update("\0")
        .update(source.kind === "local" ? source.path : "")
        .update("\0")
        .update(source.kind === "git" || source.kind === "local" ? (source.subpath ?? "") : "")
        .digest("hex")
    )
    .sort();
  return createHash("sha256").update(perSource.join("")).digest("hex");
}
```

Rewrite `patrol-hash.test.ts`'s corpus tests as descriptor tests: order-independence;
hash changes when a descriptor's `url`/`subpath` changes; empty set is stable; a
field-boundary case (e.g. `name: "ab"`+`url: "c"` vs `name: "a"`+`url: "bc"` must
differ). Keep the `hashDocumentContent` test.

- [x] **Step 7: Re-thread the verify lens**

In `apps/api/src/scheduling/verify-lens.ts`: `runVerifyLens`'s input field
`sourcesRef: string` (~58) becomes `sources: SourceDescriptor[]`; the `verifyDocument`
call (~72) passes `sources: input.sources`; update the function's doc comment (~36) —
the watcher no longer "resolves the corpus once", the agent explores the descriptors'
checkouts per job. Import `SourceDescriptor` (type-only) from `@magpie/core`.
`VerifyDocumentFn` needs no change — it is typed off `VerifyDocumentJobInput`, which
Step 2 already migrated.

In `verify-lens.test.ts`, swap every `sourcesRef: "test-corpus"` input field (~30, 42,
67, 86, 102) for `sources: []` (and rename the field passed to `runVerifyLens`). Where a
test asserts the fn received the ref, assert it received the same `sources` array.

- [x] **Step 8: Rewire the patrol service**

In `apps/api/src/features/patrol/service.ts`:

1. Imports: drop `collectSourceContext` (line 21) and `hashSourceCorpus`; add:

```ts
import { hashDocumentContent, hashSourceDescriptors } from "../../scheduling/patrol-hash.js";
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";
```

2. `defaultVerifyDocument` (~87–106): destructure `sources` instead of `sourcesRef` and
   pin the bounded wait:

```ts
// The bounded wait on one verify job. The queue expiry is 15 min (agentic
// headroom), but the patrol tick runs inside the watcher's 15-minute maintenance
// POST envelope — letting the wait follow the expiry would hand the whole
// envelope to one hung verify. 10 minutes matches the agentic timeout the job
// itself runs under.
const VERIFY_WAIT_BUDGET_MS = 10 * 60_000;

const defaultVerifyDocument: VerifyDocumentFn = async (ctx, { path, content, sources }) => {
  const input = {
    path,
    content,
    sources,
    provider: ctx.config.get().aiProvider
  } satisfies VerifyDocumentJobInput & { provider: AiProviderName };
  let terminal;
  try {
    terminal = await runJobToCompletion(ctx, "verify_document", input, {
      reuseKey: verifyDocumentReuseKey,
      deadlineMs: VERIFY_WAIT_BUDGET_MS
    });
  } catch (error) {
    // ... unchanged ...
```

3. `defaultCorrectDocument` (~118) and `defaultImproveDocument` (~157): `sourcesRef:
   input.sourcesRef` → `sources: input.sources`.

4. In `runFixPatrol` (~261–297): replace the conditional corpus collection + save with an
   unconditional (cheap, pure) projection, and delete the `ctx.stores.sourceCorpus.save`
   block (~283–287) and its comment:

```ts
  // Project the flow's configured sources into the reference-only descriptors the
  // patrol child jobs are grounded in. Projection is cheap and identical for every
  // document in the tick; its hash is the config half of the change gate below.
  const sources = projectSourceDescriptors(ctx.repositoryDeps(), scope.sourceIds);
  const sourcesHash = hashSourceDescriptors(sources);
```

   Update the change-gate comment (~267–273): "…skip the (provider-billed) lenses for any
   document whose body AND the flow's source configuration are identical to the last time
   it was checked…". The `runVerifyLens` call (~292–297) passes `sources` instead of
   `sourcesRef: sourcesHash`; the `correctDocument` call (~307–314) passes `sources`.

5. Same surgery in `runImprovePatrol` (~416–436): unconditional projection + hash, delete
   the corpus save (~433–436), `improveDocument` call passes `sources` (~445).

6. `buildPatrolStamps` and the stamping calls are untouched — `sourcesHash` is still a
   string, now descriptor-keyed. Note in the gate comment that pre-migration cursor rows
   hold corpus-based hashes, so every doc re-checks once after deploy (intended: one full
   re-verify under grounded exploration).

- [x] **Step 9: Update the API test fixtures**

- `apps/api/src/features/patrol/service.test.ts`: the "stores the corpus once and threads
  one resolvable sourcesRef" test (~143–170) becomes "projects descriptors once and
  threads the same `sources` to verify and correct": configure the test flow with at
  least one `git`/`local` source, capture `input.sources` in the verify/correct spies,
  assert they deep-equal the projected descriptors and that
  `ctx.stores.sourceCorpus` was NOT touched (drop any `.save` assertions). Grep the file
  for `sourcesRef|sourceCorpus|corpus` and convert every remaining site.
- `apps/api/src/features/jobs/service.test.ts` (~456, 489, 838) and
  `apps/api/src/features/proposals/service.test.ts` (~1531, 1700): `sourcesRef:
  "test-corpus"` → `sources: []`.

- [x] **Step 10: Delete the sampler**

Delete `apps/api/src/platform/source-context.ts` entirely (its only caller was the patrol
service). Verify first:

```bash
rg -n "collectSourceContext|source-context" apps/ packages/ --glob '*.ts'
```

Expect zero hits outside the file itself before deleting.

- [x] **Step 11: Run everything and commit**

Run: `npm run build && npm test -w packages/jobs && npm test -w apps/api && npm run typecheck && npm run lint && npm run deadcode`
Expected: all PASS. If knip flags anything newly dead here, it should only be corpus
plumbing scheduled for Task 4 that accidentally lost its last consumer early — check the
graph before deleting ahead of plan (the corpus store/routes are still wired into
`app.ts`/`context.ts`, so they must NOT be flagged yet).

```bash
git add packages/core/src/index.ts packages/jobs/src/schemas.ts packages/jobs/src/schemas.test.ts \
  packages/jobs/src/catalog.ts packages/jobs/src/catalog.test.ts \
  apps/api/src/scheduling/patrol-hash.ts apps/api/src/scheduling/patrol-hash.test.ts \
  apps/api/src/scheduling/verify-lens.ts apps/api/src/scheduling/verify-lens.test.ts \
  apps/api/src/features/patrol/service.ts apps/api/src/features/patrol/service.test.ts \
  apps/api/src/features/jobs/service.test.ts apps/api/src/features/proposals/service.test.ts \
  apps/api/src/platform/source-context.ts
git commit -m "feat(patrol): ground verify/correct/improve in source descriptors, drop the sampler"
git push -u origin claude/source-agentic-increment-3-zc9tyw
```

---

### Task 2: Exploration-grounded patrol prompts

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (`VERIFY_DOCUMENT` ~304–331,
  `CORRECT_DOCUMENT` ~333–359, `IMPROVE_DOCUMENT` ~428–457)
- Test: `packages/prompts/src/catalog.test.ts` (fix pinned wording),
  `apps/watcher/src/job-prompts.test.ts` (only if it pins old patrol wording)

**Interfaces:** none new — `buildSourceGroundedPrompt` and `buildPrompt` both read
`JOB_INSTRUCTIONS[type]`, so the catalog text is the whole change. Keep each prompt's
`id`, `title`, `usedBy`, `outputShape`, and the `CONSERVATIVE_CONTRACT` interpolation and
JSON output shapes VERBATIM; the change is the grounding language (mirror the
`Grounding:` block of `DRAFT_SEED_DOCUMENT`/`DRAFT_MARKDOWN_PROPOSAL`). UK English.

- [ ] **Step 1: Rewrite `VERIFY_DOCUMENT.instructions`** (update `description` to say
  "…against the flow's source repositories, which the executing agent explores
  directly."):

```ts
  instructions: `You verify a Markdown knowledge-base document against the source repositories it should be derived from. Decide whether each substantive claim the document makes is still supported by the sources.

Input:
- "path" and "content": the knowledge-base document under review.

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them: list directories to learn the structure, search for the terms each claim rests on, open the files that matter, and follow references between files. Do not stop at the first file — corroborate across the codebase and docs before judging a claim.
- Judge every claim against files you actually read. Where a source is listed as reference-only (internet/agent), treat it as supporting context, not something you can check claims against.

Rules:
- Return JSON only.
- ${CONSERVATIVE_CONTRACT} Here a clear case is a claim the sources clearly contradict or clearly fail to support; when you are unsure, or the sources simply do not mention the claim, treat the document as healthy and do NOT flag it.
- If every claim is supported (or the sources give you nothing to disprove), return verdict "healthy" with an empty claims array.
- Otherwise return verdict "unprovable" and list ONLY the specific unprovable claims, each with a short reason citing the source files you checked (or searched and found silent).
- Do not propose edits or rewrites. You only report.

Return JSON:
{
  "verdict": "healthy | unprovable",
  "claims": [
    { "claim": "string", "reason": "string" }
  ]
}`
```

- [ ] **Step 2: Rewrite `CORRECT_DOCUMENT.instructions`** — same pattern: Input block
  keeps `"path"/"content"` and `"claims"`; the `- "sources": the source material…` line
  is replaced by a `Grounding:` block ("You have DIRECT access to the source repositories
  listed in the prompt. Explore them to establish what is actually true for each flagged
  claim… ground every correction in files you actually read and cite their repository
  paths in the rationale."). Rules keep: rewrite-or-remove per claim, never introduce
  unsupported assertions, leave the rest of the document unchanged, one-paragraph
  rationale. Update `description` accordingly.

- [ ] **Step 3: Rewrite `IMPROVE_DOCUMENT.instructions`** — Input keeps
  `"path"/"content"`; replace the `- "sources": …` line with the `Grounding:` block
  ("…search for material that belongs in this document, open the files that matter…
  every addition must be grounded in files you actually read; cite the supporting
  repository paths in the rationale."). Rules keep: conservative clear-case, single
  target, no invention, `{"improved": false}` when nothing source-backed belongs, full
  document in `markdown` when improving. Update `description`.

- [ ] **Step 4: Run and fix pinned assertions**

Run: `npm test -w packages/prompts` — fix any `catalog.test.ts` assertion pinning the old
`"sources"`-input wording. Then `npm run build && npm test -w apps/watcher` — confirm no
`job-prompts.test.ts` assertion pinned the old patrol instructions (its patrol tests
assert on input rendering, not instruction bodies — they should pass untouched until
Task 4).

- [ ] **Step 5: Commit**

```bash
git add packages/prompts/src/catalog.ts packages/prompts/src/catalog.test.ts
git commit -m "feat(prompts): exploration-grounded verify/correct/improve instructions"
git push
```

---

### Task 3: Light up the watcher agentic path for the patrol jobs

**Files:**
- Modify: `apps/watcher/src/source-workspace.ts` (~28–40, `sourceDescriptorsOf`)
- Test: `apps/watcher/src/source-workspace.test.ts` (extend)
- Test: `apps/watcher/src/runners/cli.test.ts`, `apps/watcher/src/runners/chat.test.ts`
  (dispatch proof)

**Interfaces:**
- Consumes: `verifyDocumentInputSchema`, `correctDocumentInputSchema`,
  `improveDocumentInputSchema` from `@magpie/jobs` (Task 1).
- Produces: `sourceDescriptorsOf(job)` returns descriptors for the three patrol child
  types (in addition to the two draft types). The dispatch branches in `CliRunner.run()`
  and `ChatRunner.run()` already call `hasFsSources(sourceDescriptorsOf(job))` — no
  runner edit.

- [ ] **Step 1: Write the failing tests**

In `apps/watcher/src/source-workspace.test.ts`, extend the `sourceDescriptorsOf` block
(match the existing fixture style):

```ts
it("returns descriptors for the patrol child jobs", () => {
  const sources = [{ id: "s1", name: "Repo", kind: "git", url: "https://example.com/r.git" }];
  const verify = { id: "v1", type: "verify_document", input: { provider: "openai-compatible", path: "kb/a.md", content: "# A", sources } } as JobView;
  const correct = { id: "c1", type: "correct_document", input: { provider: "openai-compatible", path: "kb/a.md", content: "# A", claims: [{ claim: "x", reason: "y" }], sources } } as JobView;
  const improve = { id: "i1", type: "improve_document", input: { provider: "openai-compatible", path: "kb/a.md", content: "# A", sources } } as JobView;
  for (const job of [verify, correct, improve]) {
    assert.deepEqual(sourceDescriptorsOf(job).map((s) => s.id), ["s1"]);
  }
});

it("returns [] for a malformed verify_document input and for non-grounded types", () => {
  const malformed = { id: "v2", type: "verify_document", input: { provider: "openai-compatible" } } as JobView;
  assert.deepEqual(sourceDescriptorsOf(malformed), []);
  const dedupe = { id: "d1", type: "dedupe_documents", input: { provider: "openai-compatible", path: "a", content: "x", neighbours: [] } } as JobView;
  assert.deepEqual(sourceDescriptorsOf(dedupe), []);
});
```

Run: `npm run build && npm test -w apps/watcher` → FAIL (patrol types return `[]`).

- [ ] **Step 2: Implement — schema lookup instead of a growing if-chain**

In `apps/watcher/src/source-workspace.ts`, replace `sourceDescriptorsOf` (and extend the
`@magpie/jobs` import):

```ts
import {
  correctDocumentInputSchema,
  draftMarkdownProposalInputSchema,
  draftSeedDocumentInputSchema,
  improveDocumentInputSchema,
  verifyDocumentInputSchema,
  type JobType,
  type JobView
} from "@magpie/jobs";

// The input schema of each source-grounded job type — every input that carries
// `sources: SourceDescriptor[]`. All five arrived with the source-agentic
// grounding increments (seeding, gap drafting, patrols); a type absent here is
// not source-grounded and never routes to the agentic tiers.
function sourceGroundedInputSchema(type: JobType) {
  switch (type) {
    case "draft_seed_document":
      return draftSeedDocumentInputSchema;
    case "draft_markdown_proposal":
      return draftMarkdownProposalInputSchema;
    case "verify_document":
      return verifyDocumentInputSchema;
    case "correct_document":
      return correctDocumentInputSchema;
    case "improve_document":
      return improveDocumentInputSchema;
    default:
      return undefined;
  }
}

// The source descriptors of a source-grounded job, [] for every other job type
// (and for a malformed input — the job then runs the plain one-shot path and
// fails on its own terms rather than here).
export function sourceDescriptorsOf(job: JobView): SourceDescriptor[] {
  const schema = sourceGroundedInputSchema(job.type);
  if (!schema) {
    return [];
  }
  const parsed = schema.safeParse(job.input);
  return parsed.success ? parsed.data.sources : [];
}
```

Run: `npm test -w apps/watcher` → PASS.

- [ ] **Step 3: Dispatch proof in the runner tests**

In `apps/watcher/src/runners/cli.test.ts`'s source-grounded describe block, add one test
mirroring the existing seed/proposal dispatch tests: a `verify_document` job with a
`local`-kind source spawns with cwd = the workspace root and the read-only flags, and the
scripted stdout `{"verdict":"healthy","claims":[]}` parses to the job output. In
`apps/watcher/src/runners/chat.test.ts`, mirror its existing agentic-dispatch test with an
`improve_document` job (scripted model returning
`{"improved": false, "rationale": "nothing source-backed to add"}`), asserting the fake
`prepareWorkspaces` was called (agent path) rather than the generative path. Reuse each
file's existing seams/fixtures.

- [ ] **Step 4: Run and commit**

Run: `npm run build && npm test -w apps/watcher && npm run typecheck && npm run lint && npm run deadcode`
Expected: PASS.

```bash
git add apps/watcher/src/source-workspace.ts apps/watcher/src/source-workspace.test.ts \
  apps/watcher/src/runners/cli.test.ts apps/watcher/src/runners/chat.test.ts
git commit -m "feat(watcher): route the patrol child jobs through the source-agentic path"
git push
```

---

### Task 4: Demolition — the corpus pipeline dies end-to-end

Everything that existed only to move sampled corpus bytes from API to watcher. Order:
watcher consumers → API endpoint/store/wiring → core type → DB migration. knip
(`npm run deadcode`) is the enforcement gate — nothing gets de-exported-but-kept; it is
all deleted.

**Files:**
- Modify: `apps/watcher/src/runners/generative.ts` (~72, 81–97),
  `apps/watcher/src/job-prompts.ts` (~9, 92–112, 140, 144–152),
  `apps/watcher/src/http-client.ts` (~2, 89–95, 154–160, 181–183, 328–342),
  `apps/watcher/src/runners/cli.ts` (the no-op api stub's `getSourceCorpus`, ~287–289)
- Modify tests: `apps/watcher/src/http-client.test.ts`, `apps/watcher/src/job-prompts.test.ts`
  (~51–87), plus every watcher test whose fake `WatcherApi` implements `getSourceCorpus`
  (`runners/publication.test.ts`, `runners/chat.test.ts`, `runners/refresh-flow-snapshot.test.ts`,
  `runners/maintenance.test.ts`, `runners/cli.test.ts` — grep `getSourceCorpus`)
- Delete: `apps/api/src/features/source-corpus/` (routes.ts + routes.test.ts),
  `apps/api/src/stores/source-corpus-store.ts` + `.test.ts`,
  `apps/api/src/stores/postgres-source-corpus-store.ts` + `.test.ts`
- Modify: `apps/api/src/app.ts` (~18, 118), `apps/api/src/platform/stores.ts` (~9, 24,
  118–127), `apps/api/src/context.ts` (~15, 54, 143),
  `apps/api/src/test-support/context.ts` (~17, 64)
- Modify: `packages/core/src/index.ts` (~663–670: delete `SourceDataContext`)
- Create: `packages/db/migrations/0045_drop_source_corpus_snapshot.sql`

- [ ] **Step 1: Watcher — remove the corpus resolution path**

- `runners/generative.ts`: delete `resolveSourceCorpus` and `sourcesRefOf` (~81–97) and
  the `SourceDataContext` import (~35); the prompt line (~70–72) becomes:

```ts
  const prompt = options.buildPromptOverride ? options.buildPromptOverride(job) : buildPrompt(job);
```

- `job-prompts.ts`: `buildPrompt` loses its `sources?` parameter, the
  `SOURCE_MATERIAL_HEADER` const (~92–93), and the corpus branch (~107–110) — it becomes
  instructions + input only. Rewrite its doc comment (the #163 corpus-caching paragraph
  goes). In `buildSourceGroundedPrompt` (~140), the omit list `["sources", "sourcesRef"]`
  becomes `["sources"]`. Trim `omitInputKeys`' comment (~144–146) to the `sources` case.
  Delete the `SourceDataContext` import (~9).
- `http-client.ts`: delete the `getSourceCorpus` interface member + comment (~89–95), the
  implementation (~328–342), `sourceCorpusCache` (~181–183), `SOURCE_CORPUS_CACHE_MAX`
  (~154–160), and the `SourceDataContext` import (~2).
- `runners/cli.ts`: delete the `getSourceCorpus` member of the no-op api stub (~287–289).
- Tests: delete `http-client.test.ts`'s corpus-caching tests; in `job-prompts.test.ts`
  rewrite the verify/improve `buildPrompt` tests (~51–87) — inputs now carry
  `sources: []` and there is no corpus block/second argument (keep the assertions that
  instructions render and input JSON trails); remove `getSourceCorpus` members from every
  fake `WatcherApi` (grep).

Run: `npm run build && npm test -w apps/watcher` → PASS.

- [ ] **Step 2: API — remove endpoint, store, wiring**

- `app.ts`: remove the `sourceCorpusRoutes` import (~18) and mount (~118).
- Delete `apps/api/src/features/source-corpus/` and the four store files
  (`source-corpus-store.ts`, `postgres-source-corpus-store.ts`, both `.test.ts`s).
- `platform/stores.ts`: remove `createSourceCorpusStore` and the two store imports.
- `context.ts`: remove `createSourceCorpusStore` from the import (~15), the
  `sourceCorpus` member of the stores type (~54), and its construction (~143).
- `test-support/context.ts`: remove the `InMemorySourceCorpusStore` import (~17) and the
  `sourceCorpus:` wiring (~64).

Run: `npm run build && npm test -w apps/api` → PASS.

- [ ] **Step 3: Core — delete `SourceDataContext`**

Delete the interface at `packages/core/src/index.ts` ~663–670. Verify first:

```bash
rg -n "SourceDataContext" --glob '*.ts'
```

Expect the definition as the only hit.

- [ ] **Step 4: Migration — drop the snapshot table**

Follow the **write-a-migration** skill (`.claude/skills/write-a-migration/SKILL.md`):
next free prefix is `0045` (confirm with `ls packages/db/migrations/ | tail`). Create
`packages/db/migrations/0045_drop_source_corpus_snapshot.sql`:

```sql
-- The content-addressed source-corpus snapshot store (#163 Part 2) is dead: the
-- patrol jobs now carry source descriptors and the executing agent explores the
-- source checkouts directly (source-agentic grounding, increment 3), so nothing
-- writes or reads source_corpus_snapshot any more. Forward-only cleanup; safe to
-- re-run.
DROP INDEX IF EXISTS source_corpus_snapshot_last_used_idx;
DROP TABLE IF EXISTS source_corpus_snapshot;
```

Validate the ordering guard: `node --test scripts/lib/migration-order.test.mjs`. Run
`npm run test:db` only if the environment has Docker (writing-magpie-tests skill);
otherwise note in the PR that the migration was validated by the ordering guard + CI.

- [ ] **Step 5: The demolition greps (all must be empty)**

```bash
rg -n "sourcesRef|SourceDataContext|collectSourceContext|getSourceCorpus|hashSourceCorpus" --glob '*.ts'
rg -n "sourceCorpus|SourceCorpus|source-corpus|source_corpus" --glob '*.ts'
```

Expected: zero hits for the first; the second may hit only the new migration file's name
in comments if any — otherwise zero. (`docs/` hits are handled in Task 5.)

- [ ] **Step 6: Full gates and commit**

```bash
git status --porcelain   # confirm no stray build artifacts are being committed
npm run build && npm run typecheck && npm run lint && npm test && npm run deadcode
```

Expected: all PASS — knip green proves the demolition left no dead exports.

```bash
git add apps/watcher/src/runners/generative.ts apps/watcher/src/job-prompts.ts \
  apps/watcher/src/http-client.ts apps/watcher/src/runners/cli.ts \
  apps/watcher/src/http-client.test.ts apps/watcher/src/job-prompts.test.ts \
  apps/watcher/src/runners/publication.test.ts apps/watcher/src/runners/chat.test.ts \
  apps/watcher/src/runners/refresh-flow-snapshot.test.ts apps/watcher/src/runners/maintenance.test.ts \
  apps/watcher/src/runners/cli.test.ts \
  apps/api/src/app.ts apps/api/src/platform/stores.ts apps/api/src/context.ts \
  apps/api/src/test-support/context.ts packages/core/src/index.ts \
  packages/db/migrations/0045_drop_source_corpus_snapshot.sql
git rm -r apps/api/src/features/source-corpus
git rm apps/api/src/stores/source-corpus-store.ts apps/api/src/stores/source-corpus-store.test.ts \
  apps/api/src/stores/postgres-source-corpus-store.ts apps/api/src/stores/postgres-source-corpus-store.test.ts
git commit -m "feat!: demolish the source-corpus pipeline (sourcesRef, getSourceCorpus, corpus store)"
git push
```

---

### Task 5: Docs, full validation, PR

**Files:**
- Modify: `docs/ai-jobs.md`, `docs/architecture.md`, `docs/maintenance-redesign.md`
- Modify: `.claude/skills/magpie-orientation/SKILL.md`
- Modify: this plan's STATUS line

- [ ] **Step 1: Docs**

- `docs/ai-jobs.md`: the `verify_document`/`correct_document`/`improve_document` entries —
  inputs now carry `sources: SourceDescriptor[]`; execution is agentic like the draft
  jobs (CLI tier: read-only checkout traversal; HTTP tier: bounded tool loop;
  `MAGPIE_AGENTIC_TIMEOUT_MS`). Remove any description of `sourcesRef`/the corpus
  endpoint.
- `docs/architecture.md`: the watcher/checkout section — patrols now also resolve source
  descriptors to read-only workspaces; the shared source-corpus snapshot store and
  `/api/source-corpus` endpoint are gone. Reference the spec.
- `docs/maintenance-redesign.md` (~172 and the surrounding #163 Part 2 passage): mark the
  corpus-snapshot mechanism as superseded by source-agentic grounding (one short
  paragraph pointing at the spec — do not rewrite the historical doc; also update the
  change-gate description: the source half of the gate is now the descriptor-set hash).
- `.claude/skills/magpie-orientation/SKILL.md`: the "Seeding and gap drafting are agentic
  and source-grounded" bullet — patrols now too; DELETE the "(Patrols still use the old
  sampler until increment 3.)" caveat and name the five source-grounded job types.

- [ ] **Step 2: Full validation + stale-reference sweep**

```bash
npm run build && npm run typecheck && npm run lint && npm test && npm run deadcode
rg -n "sourcesRef|source corpus|source-corpus|sampler" docs/ai-jobs.md docs/architecture.md .claude/skills/magpie-orientation/SKILL.md
```

Expected: gates PASS; grep only hits deliberate historical/superseded-note wording.

- [ ] **Step 3: Commit, push, PR**

```bash
git add docs/ai-jobs.md docs/architecture.md docs/maintenance-redesign.md \
  .claude/skills/magpie-orientation/SKILL.md docs/superpowers/plans/2026-07-07-source-agentic-patrols.md
git commit -m "docs: source-agentic patrols — job contracts, architecture, orientation notes"
git push
```

Open a PR to `main`: title "feat: source-agentic grounding for patrols + corpus
demolition (increment 3)"; body summarises: patrol child jobs carry descriptors; patrol
tick projects them; change gate re-keyed to descriptor hash (trade-off recorded in the
plan); prompts gain the exploration contract; watcher routes the three types through the
existing agentic tiers; corpus pipeline deleted end-to-end incl. the
`source_corpus_snapshot` table (migration 0045); queue expirations 15 min with the verify
bounded wait pinned at 10. Completes the three-increment spec.

---

## Self-Review notes (for the implementer)

- **Spec coverage:** increment 3 = "patrol jobs move over; delete `collectSourceContext`,
  the sampler walk, `SourceContextCache` (already gone in increment 2), `sourcesRef`,
  `getSourceCorpus`, and the corpus store/endpoint. Knip enforces." Task 1 (contract +
  API + sampler deletion), Task 2 (prompts), Task 3 (watcher activation), Task 4
  (demolition + migration), Task 5 (docs/PR).
- **Deliberate non-migrations:** `dedupe_documents`/`split_document` (neighbour-grounded,
  no source material), `outline_flow_seed` (destination-grounded, spec says unchanged).
- **Error handling matches the spec:** fs-backed descriptors that all fail to resolve →
  `prepareSourceWorkspaces` throws → job fails loudly and queue retry applies (existing
  increment-1 behaviour, inherited untouched). Empty `sources` (flow without configured
  sources) → `hasFsSources` false → plain one-shot path, same as the draft jobs.
- **Two recorded trade-offs:** change-gate source-content sensitivity (see the design
  decision section) and the 10-minute pinned verify wait inside the 15-minute maintenance
  envelope.
- **Line numbers are from main at 7c555ca** — verify with a quick grep before editing
  each site.
