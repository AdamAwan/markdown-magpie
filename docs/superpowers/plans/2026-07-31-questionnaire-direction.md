# Questionnaire Direction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator set one free-text "direction" per questionnaire (e.g. *"where ambiguous, assume the question is about the company and not the product"*) that steers how every question in it is interpreted, including questions whose answers would otherwise be inherited from earlier questionnaires.

**Architecture:** A nullable `direction` column on `questionnaires`, set at creation and immutable. It rides the `answer_question_batch` job input into the watcher, where it is appended to the answer system prompt (after the flow persona) and to the reconcile system prompt. The free verbatim-reuse fast path is gated on the candidate's questionnaire having the *identical* direction; a mismatch falls through to the existing reconcile step, which now judges candidates against the direction.

**Tech Stack:** TypeScript (ESM/NodeNext), Node ≥22.13, npm workspaces, Hono (API), Zod (job + request schemas), Postgres + pgvector, React 19 / Next.js (web), `node:test` + `node:assert/strict`.

**Spec:** [2026-07-31-questionnaire-direction-design.md](../specs/2026-07-31-questionnaire-direction-design.md)

## Global Constraints

- Never cast through `unknown` or `any` to silence types. Fix the types.
- Validate as you go: after each task run `npm run build`, the relevant `npm test -w <pkg>`, `npm run typecheck`, `npm run lint`. Don't batch.
- Run `npm run verify` before pushing. Knip runs in STRICT mode — an `export` on a symbol used only within its own file is a CI failure; drop the `export` rather than relaxing config.
- Run workspace tests as `npm test -w <pkg>` from the repo root, never `node --test` with the root as cwd (`@magpie/*` would resolve to stale `dist`).
- `apps/web` tests must be run through Git Bash (`bash -lc`), not PowerShell — the test script uses a Unix env-var prefix.
- Commit after every task. Conventional-commit prefixes (`feat:`, `docs:`, `test:`).
- Direction max length is **2000** characters. Trimmed on input; all-whitespace normalises to absent.
- New prompt text lives in `packages/prompts/src/catalog.ts` — never inline a prompt string in a runner.
- Any new field on the job input must be declared in **both** `packages/core` (`AnswerQuestionJobInput`) and `packages/jobs/src/schemas.ts` (`answerQuestionInputSchema`), or the broker strips it.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/prompts/src/catalog.ts` | `DIRECTION_GROUNDING_GUARD`, `withDirection()`, reconcile criterion line |
| `packages/core/src/index.ts` | `direction?` on `AnswerQuestionJobInput`, `Questionnaire`, `QuestionnaireSummary` |
| `packages/jobs/src/schemas.ts` | `direction?` on `answerQuestionInputSchema` |
| `apps/watcher/src/runners/generative.ts` | Apply direction to answer + reconcile system prompts |
| `packages/db/migrations/0061_questionnaire_direction.sql` | `questionnaires.direction` column |
| `apps/api/src/stores/questionnaire-store.ts` | Contract + in-memory store: create with direction, return it from matches |
| `apps/api/src/stores/postgres-questionnaire-store.ts` | Same for Postgres |
| `apps/api/src/features/questionnaires/reconcile.ts` | `directionMatches` gate + normalisation helper |
| `apps/api/src/features/questionnaires/schema.ts` | `direction` on the create request schema |
| `apps/api/src/features/questionnaires/service.ts` | Thread direction through create, match gating, and the drip |
| `apps/api/src/platform/answer-question.ts` | `direction` option on `buildAnswerQuestionInput` |
| `apps/api/src/features/questionnaires/export.ts` | Direction line in the markdown export |
| `apps/web/src/components/QuestionnaireCreateList.tsx` | Direction input on the create form |
| `apps/web/src/components/QuestionnaireDetail.tsx` | Show the direction on the worksheet |
| `apps/web/src/components/ConsoleProvider.tsx` | `createQuestionnaire` handler carries direction |
| `apps/mcp/src/main.ts`, `apps/mcp/src/kb-client.ts` | `direction` on create tool + worksheet view |
| `docs/questionnaires.md`, `docs/mcp.md`, `docs/api.md` | Spec + surface docs |

---

### Task 1: Prompt helper and reconcile criterion

**Files:**
- Modify: `packages/prompts/src/catalog.ts:170-188` (RECONCILE_ANSWER), `:828-838` (after `withPersona`)
- Test: `packages/prompts/src/catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `withDirection(baseInstructions: string, direction?: string): string` and `DIRECTION_GROUNDING_GUARD: string`, both exported from `@magpie/prompts`.

- [ ] **Step 1: Write the failing test**

Append to `packages/prompts/src/catalog.test.ts`:

```ts
test("withDirection appends the direction and its grounding guard", () => {
  const out = withDirection("BASE", "Assume the company, not the product.");
  assert.match(out, /^BASE/);
  assert.ok(out.includes("Assume the company, not the product."));
  assert.ok(out.includes(DIRECTION_GROUNDING_GUARD));
});

test("withDirection returns the base unchanged for an absent or blank direction", () => {
  assert.equal(withDirection("BASE"), "BASE");
  assert.equal(withDirection("BASE", ""), "BASE");
  assert.equal(withDirection("BASE", "   \n  "), "BASE");
});

test("withDirection composes after withPersona so the direction lands last", () => {
  const out = withDirection(withPersona("BASE", "Terse and formal."), "Company, not product.");
  assert.ok(out.indexOf("Terse and formal.") < out.indexOf("Company, not product."));
});

test("RECONCILE_ANSWER tells the model a different reading is not reusable", () => {
  assert.ok(RECONCILE_ANSWER.instructions.includes("different reading"));
});
```

Add `withDirection`, `DIRECTION_GROUNDING_GUARD` to the existing import from `./catalog.js` at the top of that file (and `withPersona` / `RECONCILE_ANSWER` if not already imported).

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w @magpie/prompts
```

Expected: FAIL — `withDirection is not a function` / `DIRECTION_GROUNDING_GUARD` undefined.

- [ ] **Step 3: Implement**

In `packages/prompts/src/catalog.ts`, immediately after `withPersona` (which ends at line 838):

```ts
// Appends a questionnaire's answering direction to a base prompt. Mirrors
// withPersona in shape and in its guard: a direction settles how an ambiguous
// question should be READ (company vs product, corporate vs hosted service) and
// how the answer is framed — it is never a source of facts, and never a licence
// to answer beyond the retrieved context. Applied AFTER the persona so that
// where the two pull against each other the questionnaire operator wins.
export const DIRECTION_GROUNDING_GUARD =
  "The direction above settles how to read an ambiguous question and how to frame the answer. " +
  "It never overrides the grounding rules: it supplies no facts of its own, and it never licenses " +
  "a claim the retrieved context does not contain.";

export function withDirection(baseInstructions: string, direction?: string): string {
  const trimmed = direction?.trim();
  return trimmed
    ? `${baseInstructions}\n\nAnswering direction (how to read these questions):\n${trimmed}\n\n${DIRECTION_GROUNDING_GUARD}`
    : baseInstructions;
}
```

In `RECONCILE_ANSWER.instructions`, insert this line immediately after the `- fresh:` bullet (before `UNTRUSTED_CONTENT_CONTRACT`):

```ts
    "If an answering direction is given above, judge the candidates against it: a candidate that answers a different reading of the question than the direction implies is not reused, however accurate it is on its own terms — adapt it, or answer fresh.",
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -w @magpie/prompts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/prompts/src/catalog.ts packages/prompts/src/catalog.test.ts && git commit -m "feat(prompts): add withDirection and a direction-aware reconcile criterion"
```

---

### Task 2: Job contract carries the direction

**Files:**
- Modify: `packages/core/src/index.ts:836` (`AnswerQuestionJobInput`)
- Modify: `packages/jobs/src/schemas.ts:114-135` (`answerQuestionInputSchema`)
- Test: `packages/jobs/src/catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AnswerQuestionJobInput.direction?: string`, preserved by the broker.

- [ ] **Step 1: Write the failing test**

Append to `packages/jobs/src/catalog.test.ts`:

```ts
test("answer_question input schema preserves the questionnaire direction", () => {
  const parsed = answerQuestionInputSchema.parse({
    provider: "claude-cli",
    question: "Where is data stored?",
    flows: [{ id: "security", name: "Security" }],
    direction: "Where ambiguous, assume the company and not the product.",
    expectedOutput: "answer_result"
  });
  assert.equal(parsed.direction, "Where ambiguous, assume the company and not the product.");
});
```

Import `answerQuestionInputSchema` from `./schemas.js` in that test file if it isn't already imported. If `"claude-cli"` is not a valid `providerSchema` value, use whichever literal the neighbouring tests in this file already use.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w @magpie/jobs
```

Expected: FAIL — `direction` is stripped, so `parsed.direction` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/core/src/index.ts`, inside `AnswerQuestionJobInput` (next to `candidates`):

```ts
  // The owning questionnaire's answering direction (immutable, set at creation).
  // Steers how an ambiguous question is read; see docs/questionnaires.md.
  direction?: string;
```

In `packages/jobs/src/schemas.ts`, inside `answerQuestionInputSchema` immediately after `candidates`:

```ts
  // The questionnaire's answering direction. Declared so the broker preserves
  // it from the enqueued input (the schema-stripping gotcha).
  direction: z.string().optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -w @magpie/jobs && npm run typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/jobs/src/schemas.ts packages/jobs/src/catalog.test.ts && git commit -m "feat(jobs): carry the questionnaire direction on answer_question input"
```

---

### Task 3: Watcher applies the direction

**Files:**
- Modify: `apps/watcher/src/runners/generative.ts:147` (reconcile call site), `:169-195` (`reconcileWithCandidates`), `:282` (system prompt)
- Test: `apps/watcher/src/runners/generative.test.ts` (create if absent — check `git ls-files apps/watcher/src/runners` first and follow the neighbouring runner test's harness)

**Interfaces:**
- Consumes: `withDirection` (Task 1), `input.direction` (Task 2).
- Produces: nothing new; behaviour only.

- [ ] **Step 1: Write the failing test**

The watcher tests drive a runner with a fake `ChatProvider`. Capture the `system` string of each `complete()` call and assert the direction reached both paths:

```ts
test("answer_question puts the questionnaire direction in the answer system prompt", async () => {
  const systems: string[] = [];
  const model = fakeChatProvider((request) => {
    systems.push(request.system);
    return answerJson({ answer: "Stored in the EU.", confidence: "high" });
  });
  await runAnswerJob({
    model,
    input: {
      question: "Where is data stored?",
      flows: [{ id: "security", name: "Security" }],
      direction: "Assume the company, not the product."
    }
  });
  assert.ok(systems.some((s) => s.includes("Assume the company, not the product.")));
});

test("reconcile sees the questionnaire direction too", async () => {
  const systems: string[] = [];
  const model = fakeChatProvider((request) => {
    systems.push(request.system);
    return reconcileJson({ verdict: "reused", basisItemIds: ["item-1"], answer: "" });
  });
  await runAnswerJob({
    model,
    input: {
      question: "Where is data stored?",
      flows: [{ id: "security", name: "Security" }],
      direction: "Assume the company, not the product.",
      candidates: [{ itemId: "item-1", question: "Where is data held?", answer: "In the EU." }]
    }
  });
  assert.ok(systems.some((s) => s.includes("Assume the company, not the product.")));
});
```

Use the existing helpers in the watcher test-support directory rather than the invented `fakeChatProvider` / `runAnswerJob` / `answerJson` / `reconcileJson` names above if equivalents already exist — read a neighbouring runner test first and match its harness exactly.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w @magpie/watcher
```

Expected: FAIL — the direction is absent from every captured system prompt.

- [ ] **Step 3: Implement**

Import `withDirection` alongside the existing `withPersona` import in `generative.ts`.

At line 282, replace:

```ts
  const system = withPersona(ANSWER_QUESTION.instructions, routedFlow?.persona);
```

with:

```ts
  // Persona first (how we sound), direction second (what these questions are
  // about) — so where a flow persona and a questionnaire direction disagree,
  // the direction is nearer the end of the prompt and the operator wins.
  const system = withDirection(withPersona(ANSWER_QUESTION.instructions, routedFlow?.persona), input.direction);
```

Give `reconcileWithCandidates` a `direction` parameter and use it. Change the signature to:

```ts
async function reconcileWithCandidates(
  model: ChatProvider,
  question: string,
  candidates: AnswerCandidate[],
  sections: RetrievedSection[],
  direction: string | undefined,
  signal: AbortSignal
): Promise<ReconcileDecision | undefined> {
```

and inside it:

```ts
  const response = await model.complete({
    system: withDirection(RECONCILE_ANSWER.instructions, direction),
```

Update the call site at line 147:

```ts
  const decision = await reconcileWithCandidates(model, input.question, candidates, seed, input.direction, signal);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -w @magpie/watcher && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/runners && git commit -m "feat(watcher): apply the questionnaire direction to answer and reconcile prompts"
```

---

### Task 4: Migration and store support

**Files:**
- Create: `packages/db/migrations/0061_questionnaire_direction.sql`
- Modify: `apps/api/src/stores/questionnaire-store.ts:17` (contract `create`), `:26-39` (`matchApproved`, `matchApprovedTopN` return types), `:117-125` (`summarize`), `:134-158` (in-memory `create`), `:179-...` (in-memory matches)
- Modify: `apps/api/src/stores/postgres-questionnaire-store.ts:19-25` (`QuestionnaireRow`), `:78-125` (`create`), `:127-150` (`get`), `:152-...` (`list`), `:203-261` (both match queries)
- Modify: `packages/core/src/index.ts:382-405` (`Questionnaire`, `QuestionnaireSummary`)
- Test: `apps/api/src/stores/questionnaire-store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Questionnaire.direction?: string`, `QuestionnaireSummary.direction?: string`
  - `QuestionnaireStore.create(input: { name: string; flowId: string; questions: string[]; direction?: string })`
  - `matchApproved(...): Promise<{ item: QuestionnaireItem; similarity: number; direction?: string } | undefined>`
  - `matchApprovedTopN(...): Promise<Array<{ item: QuestionnaireItem; similarity: number; direction?: string }>>`

  In every case `direction` is the **owning questionnaire's** direction, absent when unset.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/stores/questionnaire-store.test.ts` (follow the file's existing setup helpers for creating and approving an item):

```ts
test("create stores a direction and matches report the donor questionnaire's direction", async () => {
  const store = new InMemoryQuestionnaireStore();
  const donor = await store.create({
    name: "donor",
    flowId: "security",
    questions: ["Where is data stored?"],
    direction: "Assume the company, not the product."
  });
  assert.equal((await store.get(donor.id))?.direction, "Assume the company, not the product.");

  const itemId = donor.items[0].id;
  await store.setItemEmbeddings([{ itemId, embedding: [1, 0, 0], model: "test-model" }]);
  await store.approveItem(itemId, [], false);

  const matches = await store.matchApprovedTopN("security", [1, 0, 0], "test-model", 3);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].direction, "Assume the company, not the product.");

  const single = await store.matchApproved("security", [1, 0, 0], "test-model");
  assert.equal(single?.direction, "Assume the company, not the product.");
});

test("create without a direction leaves it absent", async () => {
  const store = new InMemoryQuestionnaireStore();
  const created = await store.create({ name: "plain", flowId: "security", questions: ["q"] });
  assert.equal((await store.get(created.id))?.direction, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w @magpie/api
```

Expected: FAIL — `direction` is not a known property.

- [ ] **Step 3: Implement**

Create `packages/db/migrations/0061_questionnaire_direction.sql`:

```sql
-- Per-questionnaire answering direction (docs/questionnaires.md): free text set
-- at creation that steers how ambiguous questions are read. Immutable by design
-- — answering starts on create, so an edit would leave one questionnaire holding
-- answers written under two different directions. NULL means no direction.
ALTER TABLE questionnaires ADD COLUMN direction text;
```

In `packages/core/src/index.ts`, add to both `Questionnaire` and `QuestionnaireSummary`:

```ts
  // Free-text steer set at creation, applied to every answer this questionnaire
  // produces. Absent when none was given.
  direction?: string;
```

In `questionnaire-store.ts`:
- `create` input type gains `direction?: string`.
- Both match return types gain `direction?: string`, with a contract comment: *the owning questionnaire's direction, so the caller can gate verbatim reuse on an exact match.*
- In-memory `create`: build the questionnaire with `...(input.direction ? { direction: input.direction } : {})`.
- In-memory `matchApproved` / `matchApprovedTopN`: the loop already looks up `this.questionnaires.get(item.questionnaireId)`; spread `...(questionnaire.direction ? { direction: questionnaire.direction } : {})` into the returned object.
- `summarize`: pass `...(questionnaire.direction ? { direction: questionnaire.direction } : {})` through.

In `postgres-questionnaire-store.ts`:
- `QuestionnaireRow` gains `direction: string | null`.
- `create`: `INSERT INTO questionnaires (id, name, flow_id, direction) VALUES ($1, $2, $3, $4) RETURNING *` with `input.direction ?? null` as `$4`; add `...(row.direction !== null ? { direction: row.direction } : {})` to the returned object.
- `get` and `list`: both `SELECT *` / `SELECT q.*`, so the column arrives already — add the same spread to their mapped results.
- Both match queries: add `q.direction` to the SELECT list, widen the row generic to `ItemRow & { similarity: number; direction: string | null }`, and spread `...(row.direction !== null ? { direction: row.direction } : {})` into each result.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w @magpie/api && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run the Postgres-backed store tests**

```bash
npm run test:db
```

Expected: PASS. (Requires `DOCKER_HOST` pointed at the Docker Desktop Linux-engine pipe on Windows. If Docker is unavailable, note it and let CI's DB job cover this.)

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0061_questionnaire_direction.sql packages/core/src/index.ts apps/api/src/stores && git commit -m "feat(api): persist a per-questionnaire answering direction"
```

---

### Task 5: Direction matching, and threading it through create and the drip

This task changes `isFastPathReusable`'s arity, which breaks its only caller. Matcher and caller therefore land in **one commit** — write both test sets, implement both, then verify and commit once.

**Files:**
- Modify: `apps/api/src/features/questionnaires/reconcile.ts`
- Modify: `apps/api/src/features/questionnaires/service.ts:27-112` (`createQuestionnaire`), `:135-198` (`topUpDrip`)
- Modify: `apps/api/src/platform/answer-question.ts:41-74` (`buildAnswerQuestionInput`)
- Modify: `apps/api/src/features/questionnaires/schema.ts:9-13`
- Test: `apps/api/src/features/questionnaires/reconcile.test.ts`, `apps/api/src/features/questionnaires/service.test.ts`

**Interfaces:**
- Consumes: store `direction` on matches (Task 4), `AnswerQuestionJobInput.direction` (Task 2).
- Produces:
  - `isFastPathReusable(candidateCount: number, decision: ReuseDecision, directionMatches: boolean): boolean` and `directionsMatch(a: string | undefined, b: string | undefined): boolean`, both exported from `./reconcile.js`
  - `createQuestionnaire(ctx, input: { name: string; flowId: string; questions: string[]; direction?: string })`
  - `buildAnswerQuestionInput` gains a `direction?: string` option

- [ ] **Step 1: Write the failing matcher test**

Replace the body of `apps/api/src/features/questionnaires/reconcile.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { directionsMatch, isFastPathReusable } from "./reconcile.js";

test("fast-path needs one candidate, a passing reuse check, and a matching direction", () => {
  assert.equal(isFastPathReusable(1, { reuse: true }, true), true);
  assert.equal(isFastPathReusable(1, { reuse: true }, false), false);
  assert.equal(isFastPathReusable(2, { reuse: true }, true), false);
  assert.equal(
    isFastPathReusable(
      1,
      { reuse: false, reason: { kind: "new_content", sectionId: "", path: "", heading: "" } },
      true
    ),
    false
  );
  assert.equal(isFastPathReusable(0, { reuse: true }, true), false);
});

test("directionsMatch treats absent, empty and whitespace as the same no-direction", () => {
  assert.equal(directionsMatch(undefined, undefined), true);
  assert.equal(directionsMatch(undefined, ""), true);
  assert.equal(directionsMatch("  \n ", undefined), true);
  assert.equal(directionsMatch("", "   "), true);
});

test("directionsMatch compares exactly after trimming", () => {
  assert.equal(directionsMatch("Company, not product.", "  Company, not product.  "), true);
  assert.equal(directionsMatch("Company, not product.", "Company not product."), false);
  assert.equal(directionsMatch("Company, not product.", undefined), false);
  assert.equal(directionsMatch(undefined, "Company, not product."), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -w @magpie/api
```

Expected: FAIL — `directionsMatch` is not exported; `isFastPathReusable` takes two arguments.

- [ ] **Step 3: Implement the matcher**

Replace `apps/api/src/features/questionnaires/reconcile.ts` with:

```ts
import type { ReuseDecision } from "./reuse-check.js";

// Two directions are the same steer only if their text is identical after
// trimming. Absent, empty and all-whitespace all normalise to "no direction",
// so a questionnaire without a direction reuses freely from other undirected
// ones — i.e. behaviour before this feature. Deliberately exact: guessing that
// two differently-worded directions mean the same thing is the failure mode
// this feature exists to remove, and a mismatch is cheap (it falls through to
// the reconcile step, not to a fresh answer).
export function directionsMatch(a: string | undefined, b: string | undefined): boolean {
  return (a?.trim() ?? "") === (b?.trim() ?? "");
}

// Free verbatim reuse is allowed ONLY for the unambiguous case: exactly one
// matched candidate whose cited sources are unchanged, nothing newer is
// relevant, AND the candidate was answered under the same direction — a
// candidate written under a different steer may answer a different reading of
// the question, which only the reconcile step can judge. Any other shape
// (0 candidates, 2+, a changed single, a direction mismatch) goes to the
// grounded reconcile step. See 2026-07-17-questionnaire-trust-design.md §1.2
// and 2026-07-31-questionnaire-direction-design.md part 3.
export function isFastPathReusable(
  candidateCount: number,
  decision: ReuseDecision,
  directionMatches: boolean
): boolean {
  return candidateCount === 1 && decision.reuse && directionMatches;
}
```

- [ ] **Step 4: Do NOT run the API suite or commit yet**

The arity change breaks `service.ts`'s call site, so the tree does not typecheck until Step 9 of this task. Continue straight to Step 5 — this task commits once, at the end, with a green tree.

- [ ] **Step 5: Write the failing service test**

Append to `apps/api/src/features/questionnaires/service.test.ts`. Extend the existing `createApprovedDonor` helper with an optional `direction` passed through to `createQuestionnaire`, then:

```ts
test("a matching direction still fast-paths verbatim reuse", async () => {
  const ctx = embeddingAxisContext();
  await createApprovedDonor(ctx, {
    question: "Does the ISO 27001 certificate cover you?",
    answer: "Yes, ISO 27001 since 2021.",
    direction: "Assume the company, not the product."
  });
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "reuse",
    flowId: "security",
    questions: ["Are you ISO 27001 certified?"],
    direction: "Assume the company, not the product."
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  assert.equal(item?.outcome, "reused");
  assert.equal(item?.answer, "Yes, ISO 27001 since 2021.");
});

test("a different direction sends a single candidate to reconcile instead of reusing it", async () => {
  const ctx = embeddingAxisContext();
  const donorItemId = await createApprovedDonor(ctx, {
    question: "Does the ISO 27001 certificate cover you?",
    answer: "Yes, ISO 27001 since 2021.",
    direction: "Assume the product, not the company."
  });
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "directed",
    flowId: "security",
    questions: ["Are you ISO 27001 certified?"],
    direction: "Assume the company, not the product."
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const itemId = created.questionnaire.items[0].id;
  const item = await ctx.stores.questionnaires.itemById(itemId);
  assert.notEqual(item?.outcome, "reused");
  assert.deepEqual(await ctx.stores.questionnaires.reconcileCandidateIds(itemId), [donorItemId]);
});

test("the drip puts the direction on the enqueued answer job", async () => {
  const ctx = flowContext();
  const created = await questionnaires.createQuestionnaire(ctx, {
    name: "directed",
    flowId: "security",
    questions: ["Where is data stored?"],
    direction: "Assume the company, not the product."
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const item = await ctx.stores.questionnaires.itemById(created.questionnaire.items[0].id);
  const job = await jobForLog(ctx, item?.questionLogId);
  assert.equal((job?.input as { direction?: string }).direction, "Assume the company, not the product.");
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
npm test -w @magpie/api
```

Expected: FAIL — `direction` is not accepted by `createQuestionnaire`, and the job input has no `direction`.

- [ ] **Step 7: Implement the threading**

`schema.ts` — add to `createQuestionnaireSchema`, with a comment explaining the cap and immutability:

```ts
  // Free-text steer for how these questions should be read (immutable once set,
  // docs/questionnaires.md). Trimmed; a blank value normalises to absent so ""
  // and NULL are never distinguishable downstream.
  direction: z.string().trim().max(2000).optional()
```

`answer-question.ts` — add to the `options` type:

```ts
    // The owning questionnaire's answering direction (questionnaire mode only).
    // Absent for live asks and gap-closure re-asks.
    direction?: string;
```

and to the returned object, next to `candidates`:

```ts
    ...(options.direction ? { direction: options.direction } : {}),
```

`service.ts`:

- Widen the input type: `input: { name: string; flowId: string; questions: string[]; direction?: string }`.
- Normalise once, right after the questions check:

```ts
  // Blank normalises to absent so "" and NULL are indistinguishable everywhere
  // downstream — the fast-path direction comparison depends on it.
  const direction = input.direction?.trim() ? input.direction.trim() : undefined;
```

- Pass it to the store: `await ctx.stores.questionnaires.create({ name: input.name, flowId: input.flowId, questions, ...(direction ? { direction } : {}) })`.
- In the reconcile-enabled branch, replace the fast-path check:

```ts
          if (above.length === 1) {
            const decision = await checkReuse(deps, above[0]!.item, item.question);
            if (isFastPathReusable(1, decision, directionsMatch(direction, above[0]!.direction))) {
```

- In the legacy branch (`reconcileEnabled === false`), the reuse decision must respect the direction too — otherwise it bypasses this feature entirely. Replace the `if (decision.reuse) { ... } else { ... }` block with:

```ts
        if (decision.reuse && directionsMatch(direction, match.direction)) {
          await ctx.stores.questionnaires.markReused(item.id, {
            itemId: match.item.id,
            answer: match.item.answer ?? "",
            // The ORIGINAL generation time carries forward — the freshness
            // baseline for the next questionnaire's newcomer check.
            answeredAt: match.item.answeredAt ?? ""
          });
        } else if (!decision.reuse) {
          // Stays pending for the drip; the worksheet explains the change.
          await ctx.stores.questionnaires.markChanged(item.id, decision.reason);
        }
        // Reusable but differently directed: leave it pending so the drip
        // answers it fresh under THIS questionnaire's direction. No change
        // reason — nothing about the knowledge base changed.
```

- Import `directionsMatch` alongside `isFastPathReusable`.
- In `topUpDrip`, `questionnaire` is already loaded — add to the `buildAnswerQuestionInput` call:

```ts
      ...(questionnaire.direction ? { direction: questionnaire.direction } : {}),
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm test -w @magpie/api && npm run typecheck && npm run lint
```

Expected: PASS — both the reconcile matcher tests and the three service tests.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/features/questionnaires apps/api/src/platform/answer-question.ts && git commit -m "feat(api): gate fast-path reuse on a matching direction and thread it through the drip"
```

---

### Task 6: Route acceptance and markdown export

**Files:**
- Modify: `apps/api/src/features/questionnaires/export.ts:9-27`
- Test: `apps/api/src/features/questionnaires/export.test.ts`, `apps/api/src/features/questionnaires/routes.test.ts`

**Interfaces:**
- Consumes: `createQuestionnaireSchema.direction` (Task 5), `Questionnaire.direction` (Task 4).
- Produces: nothing new. `routes.ts` needs **no** change — `zValidator` passes the whole validated body to `createQuestionnaire`, which now accepts `direction`.

- [ ] **Step 1: Write the failing tests**

Append to `export.test.ts`:

```ts
test("markdown export records the direction under the title", () => {
  const questionnaire = makeQuestionnaire({ direction: "Assume the company, not the product." });
  const md = exportQuestionnaire(questionnaire, "md");
  assert.ok(md.includes("> Direction: Assume the company, not the product."));
  assert.ok(md.indexOf("> Direction:") < md.indexOf("## 1."));
});

test("markdown export omits the direction line when none is set", () => {
  assert.ok(!exportQuestionnaire(makeQuestionnaire({}), "md").includes("Direction:"));
});
```

Use the file's existing questionnaire fixture helper; if it builds the object inline, add a local `makeQuestionnaire(overrides: Partial<Questionnaire>)` that spreads the overrides over the existing shape.

Append to `routes.test.ts` (following that file's app/auth harness):

```ts
test("POST /api/questionnaires accepts and echoes a direction", async () => {
  const response = await postQuestionnaire({
    name: "Directed",
    flowId: "security",
    questions: ["Where is data stored?"],
    direction: "Assume the company, not the product."
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { questionnaire: { direction?: string } };
  assert.equal(body.questionnaire.direction, "Assume the company, not the product.");
});

test("POST /api/questionnaires rejects an over-long direction", async () => {
  const response = await postQuestionnaire({
    name: "Directed",
    flowId: "security",
    questions: ["q"],
    direction: "x".repeat(2001)
  });
  assert.equal(response.status, 400);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w @magpie/api
```

Expected: FAIL — no direction line in the export; the 201 body has no `direction`.

- [ ] **Step 3: Implement**

In `export.ts`, change `toMarkdown`'s opening:

```ts
function toMarkdown(questionnaire: Questionnaire): string {
  const lines: string[] = [`# ${questionnaire.name}`, ""];
  // Provenance: a reviewer needs to know which reading these answers took.
  if (questionnaire.direction) {
    lines.push(`> Direction: ${questionnaire.direction}`, "");
  }
```

CSV is unchanged — the direction is a per-document fact, not a per-row one.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w @magpie/api && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/questionnaires && git commit -m "feat(api): accept a direction on create and record it in the markdown export"
```

---

### Task 7: Console create form and worksheet display

**Files:**
- Modify: `apps/web/src/components/QuestionnaireCreateList.tsx`
- Modify: `apps/web/src/components/QuestionnaireDetail.tsx`
- Modify: `apps/web/src/components/ConsoleProvider.tsx` (the `createQuestionnaire` handler)
- Modify: `apps/web/src/app/questionnaires/page.tsx` (if it declares the `onCreate` prop type inline)
- Test: `apps/web/src/components/QuestionnaireDetail.test.tsx`

**Interfaces:**
- Consumes: API `direction` (Task 6).
- Produces: `onCreate: (name: string, flowId: string, questions: string[], direction?: string) => Promise<{ id: string } | undefined>`.

- [ ] **Step 1: Write the failing test**

The web harness fires `onChange` for `<select>` but **not** for text inputs/textareas, so do not unit-test typing into the direction field. Test the display side only, in `QuestionnaireDetail.test.tsx`:

```ts
test("shows the questionnaire direction when one is set", async () => {
  const { container } = renderDetail(makeQuestionnaire({ direction: "Assume the company, not the product." }));
  assert.ok(container.textContent?.includes("Assume the company, not the product."));
});

test("shows no direction block when none is set", async () => {
  const { container } = renderDetail(makeQuestionnaire({}));
  assert.ok(!container.textContent?.includes("Direction"));
});
```

Match the file's existing render helper and fixture names.

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash -lc "npm test -w @magpie/web"
```

Expected: FAIL — the direction text is not rendered.

- [ ] **Step 3: Implement**

`QuestionnaireCreateList.tsx`:
- Widen the prop: `onCreate: (name: string, flowId: string, questions: string[], direction?: string) => Promise<{ id: string } | undefined>;`
- Add state: `const [direction, setDirection] = useState("");`
- In `submitCreate`, pass `direction.trim() || undefined` as the fourth argument and clear it (`setDirection("")`) alongside the other resets on success.
- Add the field between "Flow" and "Questions":

```tsx
        <Field label="Direction (optional)">
          <Textarea
            rows={2}
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            placeholder="Where ambiguous, assume the question is about the company and not the product."
          />
        </Field>
```

`ConsoleProvider.tsx`: widen `createQuestionnaire` to take `direction?: string` and include it in the POST body only when set.

`QuestionnaireDetail.tsx`: above the item list (near the existing `StatBanner`), render when set:

```tsx
      {questionnaire.direction ? <DirectionNote>Direction: {questionnaire.direction}</DirectionNote> : null}
```

with a small `styled.div` using `theme.color.surfaceMuted` / `theme.space.md`, matching the neighbouring styled components in the file.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bash -lc "npm test -w @magpie/web" && npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src && git commit -m "feat(web): set a questionnaire direction on create and show it on the worksheet"
```

---

### Task 8: MCP surface

**Files:**
- Modify: `apps/mcp/src/main.ts:216-244` (`kb_questionnaire_create` input schema)
- Modify: `apps/mcp/src/kb-client.ts:653-690` (`QuestionnaireView`, `createQuestionnaire`, and `readQuestionnaire`'s mapping)
- Test: `apps/mcp/src/kb-client.test.ts` (or whichever test file already covers the questionnaire client — check `git ls-files apps/mcp/src`)

**Interfaces:**
- Consumes: API `direction` (Task 6).
- Produces: optional `direction` on the `kb_questionnaire_create` tool input; `QuestionnaireView.direction?: string`.

- [ ] **Step 1: Write the failing test**

```ts
test("kb_questionnaire_create forwards an optional direction", async () => {
  const captured = captureFetch({ questionnaire: { id: "q1", name: "n", flowId: "f", status: "open", items: [] } });
  await createQuestionnaire({
    name: "n",
    flow: "f",
    questions: ["q"],
    direction: "Assume the company, not the product."
  });
  assert.equal(captured.body.direction, "Assume the company, not the product.");
});

test("the questionnaire view carries the direction back", async () => {
  captureFetch({
    questionnaire: { id: "q1", name: "n", flowId: "f", status: "open", direction: "Company, not product.", items: [] }
  });
  const view = await getQuestionnaire({ questionnaire: "q1" });
  assert.equal(view.direction, "Company, not product.");
});
```

Match the existing test file's fetch-stub helper rather than the invented `captureFetch` name.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w @magpie/mcp
```

Expected: FAIL — `direction` is not forwarded and not on the view.

- [ ] **Step 3: Implement**

`main.ts` — add to the `kb_questionnaire_create` properties (leave `required` unchanged, so it stays optional):

```ts
        direction: {
          type: "string",
          description:
            "Optional steer for how ambiguous questions should be read, applied to every answer in the batch " +
            "(e.g. 'where ambiguous, assume the question is about the company and not the product'). " +
            "Set at creation and cannot be changed afterwards."
        }
```

Also extend the tool description with: *"An optional `direction` steers how ambiguous questions are read."*

`kb-client.ts`:
- Add `direction?: string;` to `QuestionnaireView` with a comment: *the steer these answers were produced under — echoed back so the caller can see which reading was taken.*
- `createQuestionnaire`: read `const direction = optionalStringArgument(args, "direction");` and include it in the POST body only when set.
- In `readQuestionnaire`, carry `direction` through from the API payload the same way `name`/`status` are carried.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w @magpie/mcp && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src && git commit -m "feat(mcp): accept and echo a questionnaire direction"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/questionnaires.md` (Lifecycle clauses, Configuration, Code map, Provenance)
- Modify: `docs/mcp.md` (M25 input schema section, ~:210-259)
- Modify: `docs/api.md` (questionnaire create payload, ~:56-58)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update `docs/questionnaires.md`**

Read the file first and follow its existing clause-ID convention exactly (`Q<n>`, continuing from the highest existing id). Add clauses covering:

- A questionnaire MAY carry a `direction`: free text ≤2000 chars, set at creation, immutable. Blank normalises to absent.
- The direction is appended to the answer system prompt after the flow persona, and to the reconcile system prompt. It steers interpretation and framing only; it never supplies facts and never licenses an ungrounded claim (`DIRECTION_GROUNDING_GUARD`).
- Verbatim fast-path reuse requires the candidate's questionnaire to carry an *identical* direction (exact match after trimming, absent/empty/whitespace equivalent). A mismatch falls through to the reconcile step; under `QUESTIONNAIRE_RECONCILE_ENABLED=0` a mismatch instead leaves the item pending so the drip answers it fresh.
- The markdown export records the direction under the title; CSV does not.

Add to the Code map: `packages/prompts/src/catalog.ts` (`withDirection`), `apps/api/src/features/questionnaires/reconcile.ts` (`directionsMatch`), migration `0061`. Add to Known limits the three limits from the spec. Add a Provenance line pointing at the design doc and this plan.

- [ ] **Step 2: Update `docs/mcp.md` and `docs/api.md`**

Add the optional `direction` field to the documented `kb_questionnaire_create` input schema (M25) and to the documented `POST /api/questionnaires` request body, in both cases noting the 2000-char cap and that it is set at creation only.

- [ ] **Step 3: Verify the docs match the code**

Re-read each clause you wrote against the file it describes. Any clause you cannot point at a line of code for is wrong — fix it.

- [ ] **Step 4: Commit**

```bash
git add docs && git commit -m "docs: document the questionnaire answering direction"
```

---

### Task 10: Full verification and PR

- [ ] **Step 1: Run the full gate**

```bash
npm run verify
```

Expected: `format:check`, `lint`, `deadcode` (knip), `typecheck` all green. Knip has no autofix — if it reports an unused export, remove the `export` keyword rather than relaxing the config. `npm run verify:fix` handles prettier/eslint.

- [ ] **Step 2: Run every affected workspace's tests**

```bash
npm test -w @magpie/prompts && npm test -w @magpie/jobs && npm test -w @magpie/api && npm test -w @magpie/watcher && npm test -w @magpie/mcp
```

```bash
bash -lc "npm test -w @magpie/web"
```

Expected: all PASS. Note any pre-existing Windows-only failures (the watcher `publication.test` path assertion, `cli.test`'s stdin case) rather than trying to fix them.

- [ ] **Step 3: Run the DB-backed tests**

```bash
npm run test:db
```

Expected: PASS, including migration `0061`.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin claude/questionnaire-answer-direction-518532
```

Draft the PR title and body, show them for review before creating, then open the PR against `main`. Body should state the problem (ambiguous questionnaire questions answered against the wrong reading), the four design decisions from the spec's decision table, and the fact that behaviour is byte-for-byte unchanged when no direction is set.

---

## Self-Review

**Spec coverage:** Part 1 (data model) → Tasks 4, 5. Part 2.1 (helper) → Task 1. 2.2 (composition) → Task 3. 2.3 (job contract) → Task 2. 2.4 (reconcile) → Tasks 1, 3. 2.5 (trust boundary) → Task 1 (system prompt, no `wrapUntrusted`). Part 3 (reuse + legacy path) → Tasks 4, 5. Part 4: API → Task 6; web → Task 7; MCP → Task 8; export → Task 6. Testing section → distributed across every task. Documentation → Task 9.

**Ordering note:** Task 5 deliberately spans the matcher and its caller in a single commit — changing `isFastPathReusable`'s arity breaks `service.ts`, so splitting them would leave a commit that doesn't typecheck. Every other task's commit is independently green.

**Type consistency:** `direction` is the field name everywhere (DB column, core types, job input, request schema, MCP arg). The two helpers are `withDirection` (prompts) and `directionsMatch` (API); the boolean parameter is `directionMatches`. Store match results expose `direction`, never `donorDirection` or similar.
