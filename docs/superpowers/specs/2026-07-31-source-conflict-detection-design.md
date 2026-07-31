# Source-conflict detection

Status: proposed (2026-07-31)

## Problem

Magpie's knowledge base is derived from sources that can disagree with each
other. A security policy states logs are retained for 1 year; the ingest service
enforces 60 days. Both are "the source of truth" to whoever wrote them, and
nobody notices they diverged.

Today Magpie not only fails to surface that — it actively hides it.
`verify_document` has exactly two verdicts, `healthy | unprovable`
(`packages/jobs/src/schemas.ts`, `verifyDocumentOutputSchema`), and its prompt
explicitly lumps the two failure modes together: a clear case is "a claim the
sources clearly contradict or clearly fail to support"
(`packages/prompts/src/catalog.ts`, `VERIFY_DOCUMENT`). Every unprovable claim
routes through the verify lens into `correct_document`
(`apps/api/src/scheduling/verify-lens.ts`).

So when the sources disagree, the current behaviour is:

1. The patrol verifies a KB doc claiming 1-year retention.
2. The agent reads the ingest code, finds 60 days, flags the claim unprovable.
3. `correct_document` rewrites the doc to 60 days and opens a PR.

Magpie has silently picked a winner between two sources — inventing an
authority it does not have — and may flip the doc back on a later patrol when
the agent happens to read the policy first. The underlying disagreement, which
is the thing a human actually needs to fix, is never reported.

## Goal / non-goals

**Goal.** Detect disagreements *between sources* — within a single source or
across sources — while fact-checking KB documents; record them in a reviewable
register; annotate the affected document so it stops silently asserting a
disputed value; and repair the document automatically once the sources agree
again.

**Non-goals.**

- **Magpie never adjudicates.** It does not choose which source is right, and it
  does not ask a human to choose. Conflicts are resolved by humans changing the
  *sources*; Magpie observes the convergence.
- **No unanchored source sweep.** Detection is anchored on claims the KB already
  makes. A disagreement about a topic no document covers is out of scope — see
  "Deferred".
- **No new job types.** The whole loop is built from `verify_document` (extended)
  and `correct_document` (reused). See "Why no new job type".
- **No auto-merge.** Annotation and repair are proposals like any other: PR,
  human merge.

## Concept

A **source conflict** is two or more source locations that make incompatible
statements about the same fact, discovered while checking a claim a KB document
makes.

This splits what `verify_document` can currently only lump together:

| finding | meaning | routing |
|---|---|---|
| **unprovable** | sources are silent, or agree the document is wrong | `correct_document`, unchanged |
| **conflicted** | sources disagree *with each other* | register + annotation; no correction |

Granularity is **per claim**, not per document. A document with one stale claim
and one conflicted claim gets the stale claim corrected normally and the
conflicted claim annotated. One unresolved conflict never freezes the rest of a
document.

Intra-source and cross-source conflicts are the same thing with different
`sourceId`s on the positions; nothing downstream distinguishes them beyond
display.

## Lifecycle

```
detect ──▶ annotate (PR, human merge) ──▶ wait ──▶ notice ──▶ repair (PR, human merge)
   │                                        │         │
   │                              humans fix the   sources
   │                              actual source    now agree
   └── register entry: open       contradiction    (positive signal)
```

1. **Detect.** The correctness patrol's `verify_document` pass finds the
   disagreement. A register entry opens.
2. **Annotate.** A proposal adds a conflict marker to the document's affected
   section. On merge, the document no longer asserts a disputed value without
   saying so.
3. **Wait.** The conflict sits `open`. Someone fixes the policy, or the code, in
   the source repositories. Magpie does nothing.
4. **Notice.** A later patrol re-verifies the document and re-checks the topic.
   The agent reports explicitly that the sources now agree, and on what.
5. **Repair.** The register entry auto-resolves; the marker is stripped and
   `correct_document` restates the agreed value. PR, human merge.

## Job contract: `verify_document`

### Output

A new `conflicts[]` array alongside the existing `claims[]`. `verdict` stays
`healthy | unprovable` — it describes *the document's* health, and a document
can have a stale claim and a source conflict at once. Each claim lands in
exactly one array, and `verdict === "unprovable"` iff `claims` is non-empty. A
document whose only finding is a conflict is `healthy` with a non-empty
`conflicts`.

```ts
export interface SourceConflictPosition {
  sourceId: string;
  path: string;
  statement: string;   // what this location actually says
  lines?: string;      // "L10-L20"
}

export interface DetectedSourceConflict {
  topic: string;       // "log retention period"
  summary: string;     // what the disagreement is
  anchor: string;      // slugified heading path of the KB section the claim lives under
  claim: string;       // the document claim that surfaced it
  positions: SourceConflictPosition[];  // min 2
}
```

`anchor` uses the same `(documentId, anchor)` section identity as claim
provenance and citation-usage tracking, so the marker lands in the right section
and survives rewrites the same way provenance claims do.

### Input

A `knownConflicts` field carrying the document's currently-open register
entries, advisory in the same way `citedClaims` is:

```ts
knownConflicts?: Array<{ id: string; topic: string; summary: string }>;
```

### Resolution signal

The agent must return an explicit verdict on every `knownConflicts` entry:

```ts
export interface ResolvedSourceConflict {
  id: string;
  agreedStatement: string;  // what the sources now uniformly say
}
```

**Absence is not resolution.** `VERIFY_DOCUMENT` runs under
`CONSERVATIVE_CONTRACT`, so silence is the agent's default behaviour, not
evidence. Auto-resolving on "not reported this tick" would close live conflicts
whenever the agent simply didn't look. A conflict resolves only on a positive
`resolvedConflicts` entry, which also supplies the ground truth the repair needs.

A `knownConflicts` entry that is neither re-reported in `conflicts` nor listed in
`resolvedConflicts` stays `open`, untouched.

### Schema declaration

`conflicts`, `resolvedConflicts` and `knownConflicts` must be declared in
`packages/jobs/src/schemas.ts`. The broker strips undeclared output fields before
the API sees them — the trap `mapUpdates`, `uncoveredPoints` and `provenance`
have each hit.

## Prompt changes

`VERIFY_DOCUMENT` gains rules to separate the two failure modes:

- *Sources disagree with the document* (all sources agree with each other, the
  document is out of date) → `claims`, as today.
- *Sources disagree with each other* → `conflicts`.

Under the existing conservative contract, a conflict is reportable only when
**both sides were actually read** — each position must carry a real path from a
file the agent opened. A conflict may never be raised from a reference-only
(`internet` / `agent`) source, which cannot be checked.

The prompt also gains the `knownConflicts` → `resolvedConflicts` contract: check
each known conflict first, report it still-conflicted or resolved-with-agreed-
statement, and treat an already-annotated claim as known rather than novel.

`UNTRUSTED_CONTENT_CONTRACT` continues to apply — position `statement` text is
quoted source content, and it flows into a document body at annotation time, so
it is untrusted throughout.

## The conflict marker

Annotation is a **deterministic markdown edit performed by the API**, not an AI
job. The marker is inserted immediately after the target section's heading:

```markdown
<!-- magpie:conflict id=<conflictId> -->
> **Unresolved source conflict.** Sources disagree on the log retention period:
> one states 1 year, another enforces 60 days. This document does not resolve
> the disagreement.
<!-- /magpie:conflict -->
```

Constraints:

- **No source paths or source names in the marker.** Internal repository paths
  must never appear in published content (#214) — the verify prompt already
  flags inline source-path citations as a defect regardless of accuracy. The
  marker states *that* sources disagree and *what the competing values are*; the
  evidence, with paths, lives only in the register.
- **Insert-only.** The original prose is left intact. Neutralising the sentence
  would require an AI rewrite; a callout naming both values directly above the
  claim is honest, and retrieval returns the callout with the section anyway.
  (Considered and rejected: an `annotate_conflict` AI job that rewrites the
  section — more cost, a hallucination surface, and a new job type, to remove a
  value the callout already contradicts in place.)
- **Machine-recognisable.** The HTML-comment delimiters render invisibly and
  give the repair step an exact, deterministic removal target.

## Loop hazard

Annotating changes the document's content, which re-arms the change gate, so the
patrol re-verifies and the agent reads its own marker. Two rules prevent a
re-annotation loop:

- The agent receives the conflict as a `knownConflicts` entry and reports it as
  known (upsert, bumping `seenCount`), never as novel.
- Annotation is idempotent by conflict id: a document already carrying
  `<!-- magpie:conflict id=X -->` is never annotated for X again, enforced in
  code rather than relying on the model.

This is the part most likely to misbehave in production and gets an explicit
test.

## Change-gate exemption

`hashSourceDescriptors` documents the trade plainly: "A source-content-only
change no longer busts the gate" (`apps/api/src/scheduling/patrol-hash.ts`). The
gate re-arms on document content or source *configuration* changes only.

That is fatal to step 4 of the lifecycle. Once annotated, the document is stable
and the source descriptors are stable, so the patrol skips it on every future
tick. The policy gets fixed and Magpie never looks again.

**Documents with at least one open conflict are exempt from the change gate**
and are always re-checked on their patrol turn. The exemption is self-limiting:
it applies only to the small set of documents where a source-content change is
precisely the awaited event. It does not alter `checkedPaths` accounting — a
document that fails or times out is still not recorded as checked (#163).

## Data model

Migration `0061_source_conflicts.sql`.

| column | notes |
|---|---|
| `id` | |
| `flow_id` | nullable, matching the rest of the patrol path |
| `document_path` | the KB document the claim lives in |
| `anchor` | section the marker was placed in |
| `topic`, `summary`, `claim` | |
| `positions` | jsonb, `SourceConflictPosition[]` |
| `status` | `open \| resolved \| dismissed` |
| `fingerprint` | dedupe key, unique per flow |
| `first_seen_at`, `last_seen_at`, `seen_count` | |
| `annotated_proposal_id` | nullable, the annotation proposal |
| `resolved_at`, `agreed_statement`, `dismissal_note` | |

### Fingerprint and dedupe

The patrol re-verifies documents on a rolling cursor, so the same conflict is
re-detected repeatedly. Detection **upserts** on fingerprint: bump `last_seen_at`
and `seen_count` rather than inserting.

`fingerprint = sha256(flowId, documentPath, sorted(sourceId:path pairs),
normalisedTopic)`, with `flowId` folded in as a sentinel string rather than left
null — Postgres treats NULLs as distinct in a unique index, which would silently
defeat dedupe on the unscoped flow.

Two properties matter more than precision here:

- **A dismissed conflict re-detected stays dismissed.** Bump `seen_count`, do not
  reopen, do not re-annotate. Without this the register refills with judgements
  you already made and stops being read.
- Topic wording varies between runs, so the topic is normalised (lowercased,
  whitespace-collapsed) and contributes only alongside the position paths. Mild
  over-splitting is acceptable — a duplicate row is dismissable; a collapsed
  distinct conflict is invisible.

## Lens routing

`runVerifyLens` (`apps/api/src/scheduling/verify-lens.ts`) splits the verdict:

- `claims` continue through `decideReconciliation` into the corrective path,
  entirely unchanged.
- `conflicts` are upserted into the register and, where newly annotatable,
  produce an annotation proposal. They never enter the reconcile gate — an
  annotation targets a section no corrective proposal is competing for, and
  routing it through the gate would let an unrelated open PR defer the marker
  indefinitely.
- `resolvedConflicts` mark their entries resolved and enqueue the repair.

`checkedPaths` and change-gate hashing are otherwise untouched. Conflict
outcomes are recorded in the tick's `MaintenanceRun` details so the run audit
shows them.

## Repair

Both terminal transitions strip the marker deterministically; they differ in
whether the prose needs rewriting.

**Resolved** (sources agreed). Strip the marker block, then enqueue
`correct_document` with the stripped content and a single claim carrying the
`agreedStatement` as its reason. `correct_document` explores the sources and
restates the value, emitting provenance for its diff as it already does. No new
job type, and the resulting PR is an ordinary corrective proposal.

**Dismissed** (a human says it is not a real conflict). Strip the marker only.
The document's original assertion stands, so there is nothing to rewrite and no
AI call.

## Why no new job type

Every piece of the loop maps onto existing machinery: detection extends a job
that is already reading the sources for exactly this purpose, annotation and
marker-stripping are deterministic markdown edits, and repair is what
`correct_document` already does. The vestigial `detect_contradiction` job type
(declared in `packages/jobs/src/types.ts` and `catalog.ts`, enqueued by nothing,
with no dedicated prompt — a leftover of the retired whole-KB Crunch) is
**deleted** as part of this work. Leaving a dead job type named after the concept
being implemented properly is a trap for the next reader. `suggest_consolidation`
is equally dead but unrelated, and is left alone.

## API

- `GET /api/source-conflicts` — flow and status filters. Scope `read:knowledge`.
- `PATCH /api/source-conflicts/:id` — `{ status: "dismissed", note }`. Scope
  `manage:knowledge`.

Flow-scoped capability checks apply, and a cross-flow id reads as 404, not 403,
per `docs/authorization.md`.

There is deliberately no route to resolve a conflict by hand: resolution is
evidence-based and comes from the sources. A human who disagrees dismisses.

## Console

A dedicated `/conflicts` nav section (`apps/web/src/lib/sections.ts`), reviewed
like gaps. Each row shows the topic and summary, every position side by side
(source, path, statement), the document and section it surfaced under, status,
and first/last seen with `seenCount`. Actions: Dismiss with a note.

Built from the existing UI primitives with colocated Emotion `styled` — no
stylesheet. Scope-gated server-side and rendered unconditionally, per the
console's existing pattern.

## Testing

Unit:

- **Regression for the silent rewrite**: a conflicted claim must not appear in
  the `correct_document` claim list, and must not produce a corrective intent.
- Per-claim granularity: a document with one stale and one conflicted claim
  yields both a correction and a register entry.
- Fingerprint dedupe; dismissed-stays-dismissed on re-detection.
- Annotation idempotence: a document already carrying a marker for conflict X is
  not re-annotated.
- Resolution requires a positive signal: a `knownConflicts` entry absent from
  both output arrays stays `open`.
- Marker insertion at the right anchor, and exact strip-back to the original.
- Change-gate exemption: a document with an open conflict is re-checked despite
  unchanged content and descriptors.

Postgres-backed (`RUN_PG_INTEGRATION`): store round-trip, upsert-on-fingerprint,
status transitions.

Plus the job-catalog schema tests for the extended `verify_document` contract.

## Documentation

- `docs/ai-jobs.md` — the extended `verify_document` contract and the
  conflict/unprovable split.
- `docs/source-conflicts.md` — new: the concept, lifecycle, and register.
- `docs/api.md` — the two routes.
- `.claude/skills/magpie-orientation/SKILL.md` — the pipeline feature map, and
  removal of `detect_contradiction` from the job catalog cheat sheet.

## Deferred

**Source-map-driven conflict patrol.** Detection here is anchored on claims the
KB already makes, so a disagreement about a topic no document covers is never
found. The complement is a patrol anchored on `source_map_entries` — Magpie's
accumulated `(sourceId, topic) → paths` index of the sources — walking topics
covered by two or more sources and judging agreement, independent of KB
coverage.

It is deferred on evidence, not principle: its yield depends on how many
source-map topics are held by two or more sources, which is measurable once this
ships. If that number is small it burns hourly agent time for nothing. The
register and its data model are designed to take a second producer without
change.
