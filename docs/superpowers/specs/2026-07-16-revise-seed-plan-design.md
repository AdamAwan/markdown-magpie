# Revise a seed plan with a natural-language instruction

## Problem

A seed plan is proposed by the source-grounded `outline_flow_seed` job: the agent
explores a flow's source repositories and returns the complete list of documents
its knowledge base should hold (each item = title, target path, coverage points,
motivating questions), plus a run-scoped charter/persona when the flow lacks them.
The persisted `SeedPlan` is reviewed on the Seed page and, on approval, fans out to
one `draft_seed_document` per item.

Today the only ways to change a proposed plan are:

1. **Hand-edit each field** — tedious for a change that touches many items
   ("don't mention X" everywhere it appears).
2. **Re-run the outline** — re-explores the sources from scratch and *supersedes*
   the current plan with a potentially different structure, throwing away the shape
   the reviewer already likes.

We want a third option: give a **sweeping natural-language instruction** and have
Magpie reshape the *existing* plan in place — reductive/reframing edits across all
items — without re-exploring the sources.

## Goal

On a **proposed** plan's review pane, the reviewer types an instruction (e.g.
"don't mention X", "merge the two API docs", "reorder so onboarding comes first")
and Magpie rewrites the plan's items — and, when the instruction implies it, the
run-scoped charter/persona — in place. The plan keeps its id and stays selected;
its items just change. Instructions compose across rounds because each revision
operates on the plan's current persisted state.

## Non-goals (this iteration)

- **No source re-reading.** The revision reshapes the plan *text*; it does not open
  the source repositories. This is what makes it "not from scratch" and cheap. Any
  instruction that genuinely needs new grounded material (e.g. "add a document about
  Y that isn't in the plan") is out of scope: the prompt is told to leave the plan
  unchanged and explain why in the rationale. Adding optional source grounding is a
  clean follow-up (see "Future seam").
- **No history / diff view.** Revision is in place; there is no before/after audit
  trail. (Re-running the outline still supersedes and keeps its own row, unchanged.)
- **Only proposed plans.** A plan that has been approved or dismissed cannot be
  revised, matching the existing edit guard.

## Architecture

A new queue-only job, `revise_seed_plan`, following the queue-only AI rule: the API
never calls a chat model inline — it enqueues; the watcher claims the job, calls the
provider, and posts the result back for a completion handler to persist.

Unlike `outline_flow_seed`, the revise job is **not source-grounded** — its input
carries no `sources` descriptors. It therefore rides the plain generative path
(`buildPrompt` → `runGenerativeJob`'s default branch), exactly like the other
non-agentic chat jobs.

### End-to-end flow

1. **Request.** `POST /api/seed-plans/:id/revise { instruction }`. The seed service
   loads the plan, 404s if missing, authorizes `manage` on the plan's flow, and
   409s if the plan is not `proposed` (same shape as `patchSeedPlan`). It then
   enqueues `revise_seed_plan` and returns `{ jobId }`. Enqueue-only — mirrors
   `outlineFlowSeed`.

2. **Job input** carries the current plan snapshot so the model has everything it
   needs without a store read from the watcher:
   - `flowId`, `planId` (read back at completion to link the result to the plan,
     the `seedPlanId` precedent),
   - `instruction`: the reviewer's sweeping change,
   - `currentPlan`: `{ items: SeedItem[]; charter?; persona?; rationale }`.

3. **Watcher** runs the `REVISE_SEED_PLAN` prompt against the chat provider and
   returns JSON validated against the output contract.

4. **Completion handler** `reviseSeedPlanFromCompletedJob(ctx, job, output)` (wired
   next to `createSeedPlanFromCompletedJob` in `apps/api/src/features/jobs/service.ts`,
   ~line 353; a no-op for other job types). It:
   - parses the output against `reviseSeedPlanOutputSchema`; returns on mismatch,
   - loads the plan by `input.planId`; returns if missing,
   - **applies only if the plan is still `proposed`** (a concurrent approve/dismiss
     wins — the stale revision is dropped, logged, and discarded),
   - replaces the plan's items with the returned items (fresh uuids, all `proposed`)
     and updates `rationale`, and `charter`/`persona` when the output includes them,
   - keeps `id`, `flowId`, `origin`, `outlineJobId`, `sourceHash`, and the
     `charterProposed`/`personaProposed` provenance flags unchanged.

### Item identity

The plan is still `proposed`, so no item carries a `draftJobId` yet and nothing
downstream references item ids. Replacing items wholesale with fresh ids is therefore
safe and simplest; there is no need to diff-match returned items to existing ids.

## Data & contracts

### `@magpie/core`

```ts
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

// Output: the reshaped plan. items reuse the SeedItem shape (coverage may be empty
// in raw model output; approval separately enforces non-empty). charter/persona are
// returned only when the instruction changed them.
export interface ReviseSeedPlanJobOutput {
  items: SeedItem[];
  rationale: string;
  charter?: string;
  persona?: string;
}
```

### `@magpie/jobs`

- Add `"revise_seed_plan"` to `JOB_TYPES` (types.ts).
- `catalog.ts`: `define("revise_seed_plan", "provider", reviseSeedPlanInputSchema,
  reviseSeedPlanOutputSchema, 10 * 60)`. It is interactive/AI work but **not** a
  bootstrap/interactive-outline type — no membership in the seed-bootstrap or
  `INTERACTIVE_AI_JOB_TYPES` sets.
- `schemas.ts`: `reviseSeedPlanInputSchema` (provider + the input fields above,
  reusing `seedItemSchema` for `currentPlan.items`) and `reviseSeedPlanOutputSchema`
  (reusing `seedItemSchema` for `items`), each `satisfies z.ZodType<…>` against the
  core types. No `sources` field — deliberately, so the prompt renders through the
  non-grounded path.

Wiring is done via the **`add-a-job-type`** skill so the capability gate, queue
routing, and enqueue/consumption points are all covered.

### `@magpie/prompts`

Add `REVISE_SEED_PLAN` to the catalog and register it in `promptCatalog`; map it in
the watcher's `JOB_INSTRUCTIONS` (`revise_seed_plan: REVISE_SEED_PLAN.instructions`).
Contract sketch:

- You are given an existing seed plan (`currentPlan`) and an `instruction`.
- Return the **same plan reshaped** to satisfy the instruction: remove/soften/reframe
  coverage, merge/split/reorder items, drop items, adjust titles/paths, and — when the
  instruction implies it — trim/reword the `charter`/`persona`.
- Do **not** invent new grounded facts or coverage the plan did not already contain.
  You have no access to the source repositories in this task.
- If the instruction asks for genuinely new material that would require reading the
  sources, leave the items unchanged and say so in `rationale`.
- Return JSON only, matching the output shape. UK English.

### Store — `SeedPlanStore`

One new method:

```ts
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

It mints fresh `proposed` item ids like `create` does, sets `rationale`, and applies
`charter`/`persona` when present, bumping `updatedAt`. Implemented in both
`InMemorySeedPlanStore` and the postgres store. Status-transition rules (only while
`proposed`) stay in the service, as with the other store methods.

## API

New route on the plan-scoped router (`seedPlanRoutes`, under `/api/seed-plans`):

```
POST /:id/revise   body: { instruction: string (non-empty) }
```

- `requireScopes("manage:jobs")`, load-then-authorize `manage` on the plan's flow
  (the cross-flow-as-404 convention).
- 404 unknown plan; 409 when not `proposed`; 400 on empty instruction.
- Returns `{ jobId }`.

Service functions in `features/seed/service.ts`:

- `requestSeedPlanRevision(ctx, planId, instruction)` — guard + enqueue.
- `reviseSeedPlanFromCompletedJob(ctx, job, output)` — completion handler above.

## UI (`SeedPanel`)

Within the review pane, shown **only while `reviewable`** (plan is `proposed`), add a
"Revise with instructions" block below the item list, near Save/Approve/Dismiss:

- a `Textarea` for the instruction + a "Revise" button (disabled while busy or a
  revise/plan job is in flight or the instruction is blank),
- on click: **auto-save the current pane edits first** (reuse the existing
  `onPatch` path) so in-progress edits are included in what gets reshaped, then call
  a new `onRevise(planId, instruction)` handler that POSTs to `/revise` and returns
  `{ jobId }`,
- poll for the plan to update in place, reusing the existing `planningJobId` machinery
  generalised to also track a revise job: when the plan's `updatedAt` advances (or a
  short poll returns the plan with changed items), re-hydrate the same selected plan.
  The pane stays on the plan; only the items/charter/persona/rationale change.

`ConsoleProvider` gains an `onRevise` handler and a `SeedPlanRevise` request type,
alongside the existing seed handlers.

## Error handling

- Not-`proposed` plan → 409 at request time; and defensively dropped at completion
  time if it transitioned after enqueue.
- Model returns empty/unparseable output → the job fails the output contract
  (schema-validated in `parseJobOutput`) like any other job; the plan is left
  untouched, and the watcher's normal retry/dead-letter path applies.
- Auto-save failure before enqueue → surface the error and do not enqueue.

## Testing

- **store**: `revise` replaces items with fresh proposed ids, updates
  rationale/charter/persona, leaves other fields intact; unknown id → `undefined`.
- **schemas**: `revise_seed_plan` input/output round-trip; broker-strip protection
  for the optional `charter`/`persona` on the output (they must survive).
- **service**: `reviseSeedPlanFromCompletedJob` applies when `proposed`; ignores
  approved/dismissed plans, other job types, missing plan, and unparsable output.
  `requestSeedPlanRevision` guards status and enqueues with the right input.
- **routes**: auth (cross-flow 404), 409 when not proposed, 400 empty instruction,
  happy path returns `jobId`.
- **watcher**: prompt/runner fixture — a deterministic provider reply reshapes a
  fixture plan and validates against the output contract via the generic path.
- **web**: `SeedPanel` shows the revise block only while proposed, auto-saves then
  calls `onRevise`, and re-hydrates the same plan when the revision lands.

## Future seam

To later support additive, source-grounded revisions, add an opt-in variant that
carries `sources` (+ `existingDocuments`) on the input so the job renders through
`buildSourceGroundedPrompt` and runs on an agentic tier — reusing the same store
`revise` method, completion handler, route, and UI block. Nothing in this iteration
blocks that: the boundary is simply "does the input carry sources".
