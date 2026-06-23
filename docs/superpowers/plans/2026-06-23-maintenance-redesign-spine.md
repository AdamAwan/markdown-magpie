# Maintenance Redesign — Reconcile Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the lens-agnostic `ChangeIntent` vocabulary and a pure reconcile-gate decision function (`open-new` / `fold` / `defer` / `drop`), plus the adapter that turns existing proposals into the gate's input — the spine every later maintenance lens (gap, source-sync, the two patrols) will route through.

**Architecture:** Three small, side-effect-free modules in `apps/api/src/scheduling/`, mirroring the existing pure-logic style of `gap-reconciler-lineage.ts` (deterministic, throw-on-misuse, unit-tested offline). No DB schema changes, no behaviour change to the running reconciler. This plan builds and proves the decision logic in isolation; wiring it into `reconcileGaps` is the explicit follow-up (see "Out of scope" and "Next plan").

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node built-in test runner (`node --import tsx --test`), run via the `@magpie/api` workspace. Types sourced from `@magpie/core` (`Proposal`).

## Global Constraints

- **ESM imports** — every local import uses a `.js` suffix (e.g. `from "./intent.js"`), matching the rest of `apps/api/src`.
- **Pure modules** — the files in this plan must not import stores, `AppContext`, the network, or the DB. Pure functions only, like `gap-reconciler-lineage.ts`.
- **Deterministic** — given the same inputs, the gate returns the same decision. All tie-breaks are explicit (overlap-count desc, then `proposalId` ascending). No `Date.now()`/`Math.random()`.
- **Touchability definition (this plan):** a PR is *touchable* iff its proposal status is one of `draft | ready | branch-pushed | pr-opened` — i.e. open and not yet `merged | rejected | superseded`. The design doc's finer "open **and un-approved**" refinement is **deferred**: review/approval state is not tracked today (the snapshot PR record carries only `merged` + `state`). Until it is, every still-open PR is treated as touchable. Document this inline.
- **Empty targets:** the `gap` lens does not know its target file until the `draft_markdown_proposal` job assigns `targetPath`. An intent with an empty `targets` array therefore cannot be reconciled by file-set and the gate returns `open-new`. Pre-draft gap de-duplication stays cluster-based (status quo). Document this inline.

## Out of scope (deliberately deferred to the next plan)

- Calling the gate inside `reconcileGaps` / acting on `fold` and `defer` (mutating or holding back a real PR).
- The LLM-driven fold (re-drafting an open PR to absorb a new intent).
- Routing `source_change_sync` and the future patrols through the gate.
- Tracking PR approval state to make `defer` fire in practice.
- Retiring `trigger_scheduled_crunch`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/api/src/scheduling/intent.ts` (create) | The shared vocabulary: `MaintenanceLens`, `ChangeIntent`. No logic. |
| `apps/api/src/scheduling/intent.test.ts` (create) | Guards the lens list / shape. |
| `apps/api/src/scheduling/reconcile-gate.ts` (create) | `sharedTargets`, `OpenPullRequestSummary`, `ReconciliationDecision`, `decideReconciliation`, `openPullRequestSummaries`. The decision core. |
| `apps/api/src/scheduling/reconcile-gate.test.ts` (create) | Exhaustive decision-table coverage. |

---

## Task 1: Intent vocabulary

**Files:**
- Create: `apps/api/src/scheduling/intent.ts`
- Test: `apps/api/src/scheduling/intent.test.ts`

**Interfaces:**
- Produces:
  - `type MaintenanceLens = "gap" | "source-sync" | "verify" | "dedupe" | "split" | "complete"`
  - `const MAINTENANCE_LENSES: readonly MaintenanceLens[]`
  - `interface ChangeIntent { lens: MaintenanceLens; flowId?: string; targets: string[]; evidence: string[]; rationale: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/scheduling/intent.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAINTENANCE_LENSES, type ChangeIntent } from "./intent.js";

test("the six maintenance lenses are declared", () => {
  assert.deepEqual(
    [...MAINTENANCE_LENSES].sort(),
    ["complete", "dedupe", "gap", "source-sync", "split", "verify"]
  );
});

test("a ChangeIntent carries lens, targets, evidence and rationale", () => {
  const intent: ChangeIntent = {
    lens: "gap",
    targets: [],
    evidence: ["users keep asking how refunds settle"],
    rationale: "recurring unanswered question"
  };
  assert.equal(intent.lens, "gap");
  assert.deepEqual(intent.targets, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="maintenance lenses"`
Expected: FAIL — cannot find module `./intent.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/scheduling/intent.ts

// The maintenance lenses, each a distinct reason a knowledge-base change is
// warranted. Event-driven lenses (gap, source-sync) fire when the world changes;
// patrol lenses (verify, dedupe, split, complete) fire on a rolling cursor. Every
// lens emits a ChangeIntent rather than a PR directly; the reconcile gate decides
// whether that intent opens a new PR or folds into an open one. See
// docs/maintenance-redesign.md.
export const MAINTENANCE_LENSES = [
  "gap",
  "source-sync",
  "verify",
  "dedupe",
  "split",
  "complete"
] as const;

export type MaintenanceLens = (typeof MAINTENANCE_LENSES)[number];

// A proposed knowledge-base change, before it becomes a PR. `targets` are the doc
// paths the change would write to or delete; it is empty when the target file is
// not yet known (a gap whose file the draft job decides later — see the plan's
// Global Constraints).
export interface ChangeIntent {
  lens: MaintenanceLens;
  flowId?: string;
  targets: string[];
  evidence: string[];
  rationale: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="maintenance lenses|ChangeIntent carries"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/intent.ts apps/api/src/scheduling/intent.test.ts
git commit -m "feat(reconcile): add ChangeIntent + MaintenanceLens vocabulary"
```

---

## Task 2: File-set overlap helper

**Files:**
- Create: `apps/api/src/scheduling/reconcile-gate.ts`
- Test: `apps/api/src/scheduling/reconcile-gate.test.ts`

**Interfaces:**
- Produces: `function sharedTargets(a: string[], b: string[]): string[]` — the intersection of two file-sets, de-duplicated, preserving the order of `a`. Two changes "overlap" when this is non-empty.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/scheduling/reconcile-gate.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedTargets } from "./reconcile-gate.js";

test("sharedTargets returns the intersection in a's order", () => {
  assert.deepEqual(
    sharedTargets(["kb/refunds.md", "kb/credits.md"], ["kb/credits.md", "kb/refunds.md"]),
    ["kb/refunds.md", "kb/credits.md"]
  );
});

test("sharedTargets is empty when file-sets are disjoint", () => {
  assert.deepEqual(sharedTargets(["kb/a.md"], ["kb/b.md"]), []);
});

test("sharedTargets de-duplicates and ignores empty sets", () => {
  assert.deepEqual(sharedTargets(["kb/a.md", "kb/a.md"], ["kb/a.md"]), ["kb/a.md"]);
  assert.deepEqual(sharedTargets([], ["kb/a.md"]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="sharedTargets"`
Expected: FAIL — cannot find module `./reconcile-gate.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/scheduling/reconcile-gate.ts

// The intersection of two file-sets, de-duplicated and in `a`'s order. Two changes
// overlap (and so must be reconciled rather than raised as rival PRs) exactly when
// this is non-empty.
export function sharedTargets(a: string[], b: string[]): string[] {
  const inB = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of a) {
    if (inB.has(path) && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="sharedTargets"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/reconcile-gate.ts apps/api/src/scheduling/reconcile-gate.test.ts
git commit -m "feat(reconcile): add sharedTargets file-set overlap helper"
```

---

## Task 3: The reconcile-gate decision

**Files:**
- Modify: `apps/api/src/scheduling/reconcile-gate.ts`
- Test: `apps/api/src/scheduling/reconcile-gate.test.ts`

**Interfaces:**
- Consumes: `ChangeIntent` (Task 1), `sharedTargets` (Task 2).
- Produces:
  - `interface OpenPullRequestSummary { proposalId: string; targets: string[]; touchable: boolean }`
  - `type ReconciliationDecision = { kind: "open-new" } | { kind: "fold"; intoProposalId: string } | { kind: "defer"; behindProposalId: string } | { kind: "drop"; reason: string }`
  - `function decideReconciliation(intent: ChangeIntent, openPrs: OpenPullRequestSummary[]): ReconciliationDecision`

**Decision rules** (the table from `docs/maintenance-redesign.md` §5):
- Intent has no `targets` → `open-new` (cannot reconcile by file yet; see Global Constraints).
- No open PR overlaps the intent's file-set → `open-new`.
- One or more *touchable* open PRs overlap → `fold` into the best one.
- Open PRs overlap but **none** is touchable → `defer` behind the best one.
- "best" = most shared targets; ties broken by `proposalId` ascending (deterministic).
- `drop` is **not** produced by this function — it is owned upstream (a frozen/superseded cluster never reaches the gate). The variant exists for the shared vocabulary; a test pins that the gate never returns it.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to apps/api/src/scheduling/reconcile-gate.test.ts
import {
  decideReconciliation,
  type OpenPullRequestSummary
} from "./reconcile-gate.js";
import type { ChangeIntent } from "./intent.js";

const intent = (targets: string[], lens: ChangeIntent["lens"] = "verify"): ChangeIntent => ({
  lens,
  targets,
  evidence: [],
  rationale: "test"
});
const pr = (
  proposalId: string,
  targets: string[],
  touchable = true
): OpenPullRequestSummary => ({ proposalId, targets, touchable });

test("opens a new PR when nothing overlaps", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [pr("p1", ["kb/b.md"])]);
  assert.deepEqual(d, { kind: "open-new" });
});

test("opens a new PR when the intent has no known targets", () => {
  const d = decideReconciliation(intent([], "gap"), [pr("p1", ["kb/a.md"])]);
  assert.deepEqual(d, { kind: "open-new" });
});

test("folds into an overlapping touchable PR", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [pr("p1", ["kb/a.md"], true)]);
  assert.deepEqual(d, { kind: "fold", intoProposalId: "p1" });
});

test("defers behind an overlapping non-touchable PR", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [pr("p1", ["kb/a.md"], false)]);
  assert.deepEqual(d, { kind: "defer", behindProposalId: "p1" });
});

test("prefers the PR with the most shared targets", () => {
  const d = decideReconciliation(intent(["kb/a.md", "kb/b.md"]), [
    pr("p1", ["kb/a.md"]),
    pr("p2", ["kb/a.md", "kb/b.md"])
  ]);
  assert.deepEqual(d, { kind: "fold", intoProposalId: "p2" });
});

test("breaks overlap ties by proposalId ascending", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [
    pr("p2", ["kb/a.md"]),
    pr("p1", ["kb/a.md"])
  ]);
  assert.deepEqual(d, { kind: "fold", intoProposalId: "p1" });
});

test("folds when a touchable and a non-touchable PR both overlap", () => {
  const d = decideReconciliation(intent(["kb/a.md"]), [
    pr("p1", ["kb/a.md"], false),
    pr("p2", ["kb/a.md"], true)
  ]);
  assert.deepEqual(d, { kind: "fold", intoProposalId: "p2" });
});

test("never returns drop", () => {
  for (const prs of [[], [pr("p1", ["kb/a.md"], true)], [pr("p1", ["kb/a.md"], false)]]) {
    assert.notEqual(decideReconciliation(intent(["kb/a.md"]), prs).kind, "drop");
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @magpie/api -- --test-name-pattern="overlap|new PR|folds|defers|prefers|ties|never returns drop"`
Expected: FAIL — `decideReconciliation` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to apps/api/src/scheduling/reconcile-gate.ts
import type { ChangeIntent } from "./intent.js";

// A snapshot of an open PR as the gate sees it: the file-set it touches and
// whether it can still be safely mutated. See openPullRequestSummaries (Task 4)
// for how this is derived from proposals.
export interface OpenPullRequestSummary {
  proposalId: string;
  targets: string[];
  touchable: boolean;
}

// The gate's verdict for one intent. `drop` is part of the shared vocabulary but
// is decided upstream (a superseded/frozen cluster never reaches the gate), so
// decideReconciliation itself never returns it.
export type ReconciliationDecision =
  | { kind: "open-new" }
  | { kind: "fold"; intoProposalId: string }
  | { kind: "defer"; behindProposalId: string }
  | { kind: "drop"; reason: string };

// Decide what to do with an incoming intent given the currently-open PRs in the
// same flow (the caller passes only same-flow PRs). File-path overlap is a cheap
// pre-filter: the actual fold/rewrite is an LLM step performed later by the caller
// (see docs/maintenance-redesign.md §5). An intent with no known targets cannot be
// reconciled by file-set, so it opens a new PR.
export function decideReconciliation(
  intent: ChangeIntent,
  openPrs: OpenPullRequestSummary[]
): ReconciliationDecision {
  if (intent.targets.length === 0) {
    return { kind: "open-new" };
  }

  const overlapping = openPrs
    .map((pr) => ({ pr, overlap: sharedTargets(intent.targets, pr.targets).length }))
    .filter((entry) => entry.overlap > 0);

  if (overlapping.length === 0) {
    return { kind: "open-new" };
  }

  // Most shared targets first; ties by proposalId ascending so the choice is
  // fully deterministic.
  const best = (entries: typeof overlapping) =>
    [...entries].sort((l, r) =>
      l.overlap !== r.overlap
        ? r.overlap - l.overlap
        : l.pr.proposalId < r.pr.proposalId
          ? -1
          : l.pr.proposalId > r.pr.proposalId
            ? 1
            : 0
    )[0].pr;

  const touchable = overlapping.filter((entry) => entry.pr.touchable);
  if (touchable.length > 0) {
    return { kind: "fold", intoProposalId: best(touchable).proposalId };
  }
  // Every overlapping PR is locked (approved / merging). Folding would invalidate
  // a review, so hold this intent for a later round.
  return { kind: "defer", behindProposalId: best(overlapping).proposalId };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @magpie/api -- --test-name-pattern="overlap|new PR|folds|defers|prefers|ties|never returns drop"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/reconcile-gate.ts apps/api/src/scheduling/reconcile-gate.test.ts
git commit -m "feat(reconcile): add lens-agnostic decideReconciliation gate"
```

---

## Task 4: Proposal → gate-input adapter

**Files:**
- Modify: `apps/api/src/scheduling/reconcile-gate.ts`
- Test: `apps/api/src/scheduling/reconcile-gate.test.ts`

**Interfaces:**
- Consumes: `Proposal` from `@magpie/core`; `OpenPullRequestSummary` (Task 3).
- Produces: `function openPullRequestSummaries(proposals: Proposal[]): OpenPullRequestSummary[]` — maps the still-open proposals (status `draft | ready | branch-pushed | pr-opened`) that have a `targetPath` into gate inputs. This is how the future live integration will feed the gate; building it here keeps the spine self-contained and proven against the real `Proposal` shape.

**Note on touchability:** every still-open proposal maps to `touchable: true` today (approval state is untracked — see Global Constraints). The field is set explicitly so that when review tracking lands, only this function changes and the gate is untouched.

- [ ] **Step 1: Write the failing test**

```typescript
// append to apps/api/src/scheduling/reconcile-gate.test.ts
import { openPullRequestSummaries } from "./reconcile-gate.js";
import type { Proposal } from "@magpie/core";

// Minimal Proposal fixtures: only the fields the adapter reads. Cast keeps the
// test focused without reconstructing the whole record.
const proposal = (id: string, status: string, targetPath?: string): Proposal =>
  ({ id, status, targetPath }) as unknown as Proposal;

test("maps open proposals with a target path into summaries", () => {
  const out = openPullRequestSummaries([
    proposal("p1", "pr-opened", "kb/a.md"),
    proposal("p2", "draft", "kb/b.md")
  ]);
  assert.deepEqual(out, [
    { proposalId: "p1", targets: ["kb/a.md"], touchable: true },
    { proposalId: "p2", targets: ["kb/b.md"], touchable: true }
  ]);
});

test("excludes closed proposals and those without a target path", () => {
  const out = openPullRequestSummaries([
    proposal("p1", "merged", "kb/a.md"),
    proposal("p2", "rejected", "kb/b.md"),
    proposal("p3", "superseded", "kb/c.md"),
    proposal("p4", "pr-opened", undefined)
  ]);
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="maps open proposals|excludes closed"`
Expected: FAIL — `openPullRequestSummaries` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to apps/api/src/scheduling/reconcile-gate.ts
import type { Proposal } from "@magpie/core";

// Proposal statuses that are still open and therefore safe to fold into. Mirrors
// isOpenProposal() in gap-reconciler.ts — kept in sync deliberately.
const TOUCHABLE_STATUSES = new Set(["draft", "ready", "branch-pushed", "pr-opened"]);

// Derive the gate's view of the open PRs in a flow from its proposals. Only
// still-open proposals that already know their target file participate; a closed
// (merged/rejected/superseded) proposal is not an open PR, and a proposal with no
// targetPath has no file-set to overlap on. touchable is always true for now —
// approval state is untracked (see the plan's Global Constraints).
export function openPullRequestSummaries(proposals: Proposal[]): OpenPullRequestSummary[] {
  const out: OpenPullRequestSummary[] = [];
  for (const proposal of proposals) {
    if (!TOUCHABLE_STATUSES.has(proposal.status) || !proposal.targetPath) {
      continue;
    }
    out.push({ proposalId: proposal.id, targets: [proposal.targetPath], touchable: true });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="maps open proposals|excludes closed"`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the whole module typechecks and all tests pass**

Run: `npm run typecheck -w @magpie/api && npm test -w @magpie/api -- --test-name-pattern="sharedTargets|overlap|new PR|folds|defers|prefers|ties|never returns drop|maps open proposals|excludes closed|maintenance lenses|ChangeIntent"`
Expected: typecheck clean; all reconcile-spine tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/scheduling/reconcile-gate.ts apps/api/src/scheduling/reconcile-gate.test.ts
git commit -m "feat(reconcile): map open proposals to gate inputs"
```

---

## Next plan (the live integration — not built here)

Once this spine is merged, the follow-up plan wires it in:

1. In `reconcileGaps`/`reconcileClusters` (`apps/api/src/scheduling/gap-reconciler.ts`), build `openPullRequestSummaries(await ctx.stores.proposals.list(...))` (same-flow only, reusing `proposalFlowId`) and run each lens's `ChangeIntent` through `decideReconciliation` instead of the direct `proposalForCluster` → draft path.
2. Implement the `fold` action: an LLM re-draft of the open PR that absorbs the new intent's evidence (new `draft_markdown_proposal` variant or a fold-specific job).
3. Track PR approval state (extend the snapshot PR record + `refresh_pull_requests`) so `touchable` can become `false` and `defer` fires for real.
4. Emit `ChangeIntent`s from `source_change_sync`, then build `fix-patrol` and `improve-patrol` on the rolling cursor.
5. Retire `trigger_scheduled_crunch`.

---

## Self-Review

- **Spec coverage (design doc §3–§5):** `ChangeIntent` = Task 1; "signal is not a PR" / file-set vocabulary = Tasks 1–2; the §5 decision table (`open-new`/`fold`/`defer`, touchable guard) = Task 3; the gate's input derivation = Task 4. The §8 decisions about folding-not-merging and human review are honoured by *not* auto-acting in this plan (integration deferred). `drop`, cursor fairness, and adaptive `k` belong to later lenses and are explicitly out of scope.
- **Placeholder scan:** none — every code and test step is complete.
- **Type consistency:** `ChangeIntent`, `OpenPullRequestSummary`, `ReconciliationDecision`, `decideReconciliation`, `sharedTargets`, `openPullRequestSummaries`, and the `proposalId`/`targets`/`touchable` field names are used identically across Tasks 1–4 and the tests. `TOUCHABLE_STATUSES` matches `isOpenProposal()` in `gap-reconciler.ts:419`.
