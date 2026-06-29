# Knowledge-base maintenance redesign

**Status:** Proposal · **Date:** 2026-06-23 · **Author:** Adam

This document replaces the current `crunch` / `gaps-to-pull-requests` / `source-change-sync`
scheduled-job design with a model organised around two axes the original design ignored:
**what triggers the work**, and **how much data the work needs to look at**.

The companion file [`maintenance-redesign.html`](maintenance-redesign.html) is a visual
walk-through of the same model.

---

## 1. The problem

We have four scheduled jobs today:

| Job | Trigger | Scope of data | Verdict |
| --- | --- | --- | --- |
| `source_change_sync` | source commit | diff + ≤6 matching docs | well-scoped |
| `gaps-to-pull-requests` | every 10 min | gap clusters | mostly fine |
| `refresh_pull_requests` | every 5 min | open PRs | plumbing, fine |
| `trigger_scheduled_crunch` | daily 02:00 | **all docs** | the god-job |

The pain — "a confusing stream of PRs" — comes almost entirely from **crunch**. It has
no scope (it ingests the entire knowledge base) and no single responsibility: a whole-KB
crunch can fill gaps, deduplicate, fact-check and expand docs all in one run. That means it
competes with the gap job, competes with itself, and emits PRs nobody can reason about.

The root cause isn't "too many jobs". It's that the work was never decomposed along the two
axes that matter. Crunch is really **five different jobs wearing one coat**.

---

## 2. The reframe: trigger × scope

Every maintenance action is one of two trigger types:

- **Event-driven** — the world changed. A question exposed a gap; a source commit landed.
  Cheap, immediate, naturally bounded.
- **Patrol** — nothing changed, but the KB rots on its own: claims drift, files bloat,
  duplicates accrue, docs stay thin. This is what crunch was *trying* to be.

The key realisation: **no maintenance concern needs the whole KB at once.** Each has a
small, natural scope.

| Want | Lens | Trigger | Scope it actually needs |
| --- | --- | --- | --- |
| Fill gaps (not in isolation) | **gap** | event: question→gap | the gap + sibling gaps + open PRs |
| Don't rot (source changed) | **source-sync** | event: commit | diff + docs citing that area |
| Don't rot (claims still true?) | **verify** | patrol | **one file** + its cited sources |
| Tidy: duplication / contradiction | **dedupe** | patrol | one file + its *k* nearest neighbours |
| Tidy: too big / wrong responsibilities | **split** | patrol | one file (+ neighbours) |
| Completeness ("what else?") | **complete** | patrol | one file / one topic |

The whole-KB crunch dissolves into **patrol lenses**, each operating on **one file or one
small neighbourhood** at a time. Even `dedupe` — the only inherently cross-file lens — never
goes O(n²): it takes the file under patrol and compares only its *k* nearest neighbours via
the existing KB search.

---

## 3. The architecture

### Key terms

- **Flow** — the top-level partition. Each flow has its own gap catalog, clusters, scheduled
  tasks and snapshot. Everything below happens *within* a flow; the gate never reasons across
  flows.
- **File-set** — the concrete set of KB document paths a single PR writes to or deletes
  (`writes[].path` + `deletes[]`), inside one flow. It is a property of an individual PR, not
  something you configure. Two PRs "overlap" when their file-sets share any path.

```
flow  (e.g. billing-kb)
 └── many docs
      └── a PR touches some subset of them   ← that subset is the "file-set"
```

Keying on the **file-set** is deliberate. Keying on the *flow* would be too coarse — only one
open PR per flow at a time, serialising all maintenance. Keying on a *single file* is too
fine — real edits span files (a `split` moves content into a new doc; a `dedupe` reconciles
two docs), so the unit must be "the set of files this change spans".

Separate **finding work** from **deciding to publish**, and put one shared gate between them.

```
gap ─────────┐
source-sync ─┤
fix-patrol ──┼──►  RECONCILE GATE  ──►  one PR per file-set
improve-patrol ─┘   (fold-on-overlap)
```

Two rules carry the whole design:

1. **A signal is not a PR.** Every lens emits a *change intent*
   (`{ targets, lens, evidence, rationale }`), never a branch directly.
2. **One open PR per file-set.** A PR is keyed by the files it touches. A new intent that
   targets a file already covered by an open PR *folds into it* (see §5) — it can never spawn
   a competitor. This single invariant structurally eliminates both duplication and conflict.

File-path overlap is only a cheap **pre-filter** that decides *whether* two changes meet. The
actual resolution — fold the new intent in, rewrite the affected sections, or decide they're
genuinely independent — is done by the **LLM** at fold time, with both the open PR's diff and
the new intent's evidence in context. We never attempt a mechanical text merge; the model
produces the reconciled document. That is also what makes the soft *topic* overlap safe (§5).

The current gap reconciler already implements rule 1 (clusters → proposals). The redesign
**generalises that gate** so source-sync and the patrols flow through it too, instead of each
publishing its own branch/PR independently.

---

## 4. Job inventory (after)

Four fuzzy jobs become five sharp ones, split by trigger and scope:

| Job | Type | Trigger | Scope | Lenses | Emits |
| --- | --- | --- | --- | --- | --- |
| **gap** | event | question→gap | gap + siblings + open PRs | gap | intent |
| **source-sync** | event | source commit | diff + citing docs | (push) | intent |
| **fix-patrol** | patrol | rolling cursor | 1 file + *k* neighbours | verify, dedupe, split | intent |
| **improve-patrol** | patrol | rolling cursor (slower) | 1 file / topic | complete | intent |
| **reconcile + publish** | — | every N min | open intents + open PRs | — | PRs |

`trigger_scheduled_crunch` is **retired**. `refresh_pull_requests` is unchanged.

### Two patrols, not one

Correctness and growth feel similar but behave oppositely, so they are **separate jobs**:

- **fix-patrol** is *conservative*. It speaks only when something is demonstrably **wrong**:
  a claim it can't prove, a real duplicate/contradiction, a file that has outgrown its
  responsibility. Silent on healthy files. (Covers "don't rot" + "keep tidy".)
- **improve-patrol** is *proactive*. It grows docs that are fine-but-thin.
  (Covers "what else should we know?".)

Splitting them lets us run them at different cadences and, crucially, **label them
differently**: a fix-patrol PR fixes a demonstrable problem (quick to approve), while an
improve-patrol PR makes an editorial call (needs a real read). Both still go through human
review before merging to main — see §8 — they're just easy to triage apart. Crunch mixed
these, which is a large part of why its output felt untrustworthy: you couldn't tell a "this
is wrong" PR from a "here's more stuff" PR.

### The patrol trigger

Not "all docs daily". A **rolling cursor**: each tick, pick the *N* least-recently-checked
files (or files past a staleness threshold) and run the lenses on them. This rotates through
the whole KB over days with bounded cost per tick, and naturally re-visits files as they age.

---

## 5. The reconcile gate in detail

For each incoming intent, the gate looks at existing open intents **and** open PRs, keyed by
file/topic, and decides:

| Situation | Action |
| --- | --- |
| No overlap | open a new PR |
| Overlaps an open, **touchable** PR | **fold into it** (default) |
| Overlaps an open PR that's approved / merging | **defer** to next round |
| Already covered / superseded | drop |

The gap case you already designed is just the `gap`-lens specialisation: similar gaps fold
together and raise urgency; an existing unmerged PR receives the new gap as supporting
evidence rather than spawning a rival.

### Overlap is detected cheaply, resolved by an LLM

Overlap detection has two layers:

- **Hard signal — file-set overlap.** Two PRs share a document path. Structural, exact, cheap.
- **Soft signal — topic overlap.** Two PRs touch *different* files about the same subject
  (`refunds.md` vs `partial-refunds.md`). Caught with the same *k*-nearest-neighbour search the
  dedupe lens uses. Heuristic, not exact.

Either signal only decides that two changes *might* collide. The **LLM does the actual
resolution** — given the open PR's current diff and the new intent's evidence, it either
rewrites the affected sections into one coherent change, attaches the new intent as evidence,
or rules them independent. Because a model is always in the loop, the soft topic signal can be
generous (better to ask the model "do these collide?" once too often than to ship two rival
PRs) and we never risk a bad mechanical merge.

### Fold-on-overlap guard rail

Folding mutates an open PR. That's fine **while the PR is un-approved**. Once a reviewer has
approved it (or it is mid-merge), a new overlapping intent must **not** mutate it — that would
silently invalidate the review. The rule is therefore **"fold if touchable, else defer"**, not
"always fold". Touchability is a property of the PR state (open & un-approved), checked at
fold time.

---

## 6. Why source-sync stays separate from verify

They look like the same "staleness" concern but pull in opposite directions:

- **source-sync** is the *push*: a commit landed, propagate it to the docs that cite that
  area. Event-driven, fast, small. We can watch commits as they merge, so it stays focused.
- **verify** is the *pull*: re-check whether a doc's claims are still provable, catching drift
  that **didn't** arrive through a tracked commit — renames, non-git sources, slow rot.

They are complementary, and they never collide because both emit intents into the same gate:
if source-sync already has a PR open on a file, verify simply folds in.

---

## 7. What this buys us

- **Crunch dies.** Its four hidden jobs become two honest patrols with bounded scope. No more
  passing the entire KB to the watcher.
- **The PR stream becomes legible.** Every PR is keyed to a file-set and tagged by lens, and
  there is provably never two open PRs fighting over the same file.
- **Each job is independently tunable** — cadence, appetite, auto-merge policy — because
  responsibilities no longer overlap.

---

## 8. Migration sketch

Rough order that keeps the system working throughout. **All six steps are shipped.**

1. ✅ **Introduce the `intent` type** and make `gap-reconciler` emit/consume it explicitly
   (it already does this in all but name).
2. ✅ **Generalise the reconcile gate** to be lens-agnostic; add the touchable/fold/defer logic.
3. ✅ **Route source-sync through the gate** (emit intents instead of publishing branches directly).
4. ✅ **Build fix-patrol** with the rolling cursor + verify/dedupe/split lenses.
5. ✅ **Build improve-patrol** (complete lens) on a slower cursor.
6. ✅ **Retire `trigger_scheduled_crunch`** and its `crunch_*` job types now the patrols cover it.
   The crunch feature, stores, `/crunch` route, web section (repurposed into **Schedules**), and
   the `crunch_runs`/`crunch_settings` tables are gone. The shared plan shape that source-change
   sync reuses was renamed `crunch_plan`/`CrunchPlan` → `maintenance_plan`/`MaintenancePlan` so no
   crunch-named vocabulary remains. `refresh_pull_requests` is unchanged.

The spine — the shared gate plus the intent type — landed in steps 1–2; `gap-reconciler.ts` was
already ~80% of it.

---

## Decisions

- **Folding & merge policy** — *all* patrol lenses (verify/dedupe/split/complete) fold their
  changes into the existing open PR for the file-set. **Nothing merges to main unattended:**
  every PR still goes through human review. fix-patrol and improve-patrol PRs are labelled
  differently so they're easy to triage, but the merge gate is human for both.
- **Don't re-patrol a file already in an open PR** — folding is the resolution when a *new*
  intent meets an open PR, not a per-tick action. A patrol lens reads document content from
  the indexed branch, which still lacks an unmerged PR's edits, so left unchecked it would
  re-propose the same change every tick and re-fold it — spamming `(automated fold-on-overlap)`
  comments and re-publishing the PR endlessly. The gap lens avoids this by freezing the covered
  cluster; the clusterless patrol lenses instead **skip, at selection time, any file already
  covered by an open same-flow proposal** (`flowCoveredPaths` in `apps/api/src/scheduling/flow.ts`,
  applied in both `runFixPatrol` and `runImprovePatrol`). Covered files stay stamped in the
  cursor so they rotate normally and become eligible again once the PR merges and its edits
  reach the index.
- **Cursor fairness** — *oldest N + a random sample*. Each tick takes the N least-recently-
  checked files (exploit: clear the staleness backlog) plus a small random selection of others
  (explore: nothing goes unvisited forever, and load doesn't synchronise into waves). The
  oldest-N share dominates; the random share is the safety net.
- **Neighbourhood size *k*** (dedupe lens) — **adaptive**, not fixed. We don't yet know KB
  scale, so size *k* from the corpus (e.g. relative to flow size and/or a similarity-score
  threshold rather than a hard count) and tune once we have real numbers.

## Follow-on work (post step 6)

- **Generic maintenance-run audit (shipped):** every scheduled task (fix-patrol,
  improve-patrol, gaps→PR) records one `MaintenanceRun` per tick — a uniform,
  queryable execution audit surfaced on the Schedules page. This replaced the
  bespoke `PatrolRun` record. Source-sync's `SourceSyncRun` is the last to migrate;
  that migration is a follow-up once the changeset lifecycle has settled.
- **Scope B (shipped):** source-change-sync now creates first-class Proposals, so
  it folds through the same gate and publishes reviewable PRs like the other lenses.

## Still open

- Exact split between oldest-N and the random sample (e.g. 80/20?) — settle with real volume.
- The concrete adaptivity rule for *k* (score threshold vs. proportion of flow) — same.
