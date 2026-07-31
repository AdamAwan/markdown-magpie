# Source conflicts

**Status:** as-built (2026-07-31)

A **source conflict** is a disagreement between two or more source locations about
a fact the knowledge base asserts — within a single source, or across several. A
security policy states logs are retained for 1 year; the ingest service enforces
60 days. Both are authoritative to whoever wrote them, and nothing else in Magpie
notices they diverged.

Magpie never adjudicates a conflict. It records the disagreement, annotates the
affected document so it stops silently asserting a disputed value, and waits for
humans to fix the disagreement **in the sources**. When the sources agree again,
the conflict closes and the document is repaired.

## SC-1 · The distinction that drives everything

`verify_document` reports two different failures, and they route differently:

| finding | meaning | routing |
|---|---|---|
| **unprovable claim** | the sources agree with each other; the document is out of date | `correct_document` — an ordinary corrective proposal |
| **source conflict** | the sources disagree with *each other* | the conflict register; the document is annotated, never corrected |

Before this split existed, both arrived as "unprovable". A source disagreement
therefore flowed into `correct_document`, which rewrote the document to whichever
side the agent had read — silently choosing a winner between two sources, with no
human in the loop, and potentially flipping back on the next patrol.

Granularity is **per claim**. A document with one stale claim and one conflicted
claim gets the stale claim corrected normally and the conflicted claim annotated;
one unresolved conflict never freezes the rest of a document.

Intra-source and cross-source conflicts are the same thing with different
`sourceId`s on the positions.

## SC-2 · Lifecycle

1. **Detect** — the correctness patrol's `verify_document` pass finds the
   disagreement while fact-checking a document. A register entry opens.
2. **Annotate** — a proposal adds a conflict marker to the affected section. On
   merge, the document records that its sources disagree.
3. **Wait** — the conflict sits `open`. Someone fixes the policy, or the code, out
   in the source repositories. Magpie does nothing.
4. **Notice** — a later patrol re-verifies the document, re-checks the topic, and
   the agent reports explicitly that the sources now agree, and on what.
5. **Repair** — the entry auto-resolves; the marker is stripped and
   `correct_document` restates the agreed value. PR, human merge.

A reviewer who thinks a conflict is not real **dismisses** it instead. There is
no hand-resolve: marking one resolved would assert an agreement that does not
exist in the sources.

## SC-3 · Job contract

`verify_document` (`packages/jobs/src/schemas.ts`) carries `conflicts[]` alongside
`claims[]`, plus a `knownConflicts` → `resolvedConflicts` round-trip.

`verdict` stays `healthy | unprovable`: it describes **the document's** health, and
a document can hold a stale claim and a conflict at once. A document whose only
finding is a conflict is `healthy` with a non-empty `conflicts` — there is nothing
about the document to correct.

Each conflict carries the topic, a summary, the section `anchor` the claim lives
under, the claim itself, and **at least two positions**, each naming a source id,
a repo-relative path the agent actually opened, and what that location says. One
position is not a conflict; it is an unprovable claim.

## SC-4 · Resolution needs a positive signal

The verify prompt runs under `CONSERVATIVE_CONTRACT`, so an agent saying nothing
about a topic is its **default behaviour, not evidence**. Auto-resolving a
conflict because it was not reported this tick would close conflicts that are
still live.

So the agent receives the document's open conflicts as `knownConflicts` (the
`citedClaims` precedent) and must return an explicit verdict on each: still
reported in `conflicts`, or listed in `resolvedConflicts` with the statement the
sources now agree on — which is also the ground truth the repair needs. A known
conflict in neither array stays `open`, untouched.

## SC-5 · The conflict marker

Annotation is a **deterministic markdown edit made by the API**, not an AI job
(`packages/markdown/src/conflict-marker.ts`):

```markdown
<!-- magpie:conflict id=<conflictId> -->
> **Unresolved source conflict.** Sources disagree on the log retention period:
> one states 1 year, another enforces 60 days.
<!-- /magpie:conflict -->
```

- **No source paths or names in the marker.** Internal repository paths must never
  appear in published content (#214) — the verify prompt already flags inline
  source-path citations as a defect. The marker states *that* the sources disagree
  and *what the competing values are*; the paths live in the register and the PR
  body.
- **Insert-only.** The original prose is untouched. Rewriting the disputed
  sentence would need an AI pass, and a hallucination surface, to remove a value
  the callout directly above it already contradicts.
- **Machine-recognisable.** The HTML-comment delimiters render invisibly and make
  the repair step an exact removal, so insert and strip are true inverses.
- The summary is untrusted source-derived text, so every line is forced into the
  blockquote — a multi-line summary cannot inject Markdown into the document.

## SC-6 · The re-annotation loop

Annotating changes the document, which re-arms the change gate, so the patrol
re-verifies and the agent reads its own marker. Two rules keep that closed:

- The agent is told about the conflict via `knownConflicts` and reports it as
  known (an upsert bumping `seenCount`), not as novel.
- Annotation is **idempotent by conflict id**: a document already carrying
  `<!-- magpie:conflict id=X -->` is never annotated for X again, enforced in code
  rather than trusted to the model.

## SC-7 · Change-gate exemption

`hashSourceDescriptors` (`apps/api/src/scheduling/patrol-hash.ts`) states the
trade plainly: a source-content-only change does not bust the change gate, which
re-arms on document content or source *configuration* only.

That would be fatal to step 4 of the lifecycle. Once annotated, a conflicted
document's body and its source descriptors are both stable, so the patrol would
skip it on every future tick — the policy gets fixed and Magpie never looks again.

So **documents with at least one open conflict are exempt from the change gate**
and are re-checked whenever the cursor selects them. The exemption is
self-limiting: it applies only to documents awaiting exactly that source-content
change. It does not alter `checkedPaths` accounting — a document whose verify
fails or times out is still not recorded as checked (#163).

Note that an annotated document is still excluded while its annotation PR is
open, by the ordinary same-flow covered-path rule: re-scanning would redraft the
change already awaiting review.

## SC-8 · The register

`source_conflicts` (migration `0062`), one row per fingerprint, with status
`open | resolved | dismissed`.

The patrol re-verifies documents on a rolling cursor, so the same conflict is
re-detected repeatedly. Detection **upserts** on fingerprint — bumping
`seenCount` and `lastSeenAt` — and **never writes status**. That is what makes a
dismissal sticky: without it the register refills with judgements the reviewer
already made and stops being read.

`fingerprint = sha256(flowId, documentPath, sorted(sourceId:path), normalisedTopic)`.
The topic is normalised because the model's wording varies between runs;
`flowId` folds in as a sentinel rather than a NULL, since Postgres treats NULLs as
distinct in a unique index and dedupe on the unscoped flow would silently fail.
Mild over-splitting is deliberate: a duplicate row can be dismissed, whereas a
collapsed distinct conflict is invisible.

## SC-9 · API and console

- `GET /api/source-conflicts?flowId&status&limit` — `read:knowledge`, filtered to
  flows the principal can read.
- `PATCH /api/source-conflicts/:id` — `manage:knowledge`, body
  `{ status: "dismissed", note? }`. Any other status is a 400. A cross-flow id
  reads as 404, not 403 (`docs/authorization.md`).

The `/conflicts` console section lists the register with each position side by
side, the document and section it surfaced under, and first/last seen with the
sighting count. Dismiss is the only action.

## SC-10 · No new job types

The whole loop is built from existing machinery: detection extends
`verify_document` (already reading the sources for exactly this purpose),
annotation and marker-stripping are deterministic markdown edits, and repair is
`correct_document` reused unchanged. The vestigial `detect_contradiction` job
type — declared but enqueued by nothing, a leftover of the retired whole-KB
Crunch — was deleted as part of this work.

## SC-11 · Known limitation

Detection is anchored on claims the knowledge base already makes. A disagreement
about a topic no document covers is never found.

The complement would be a patrol anchored on `source_map_entries` — Magpie's
accumulated `(sourceId, topic) → paths` index of the sources — walking topics
covered by two or more sources independently of KB coverage. It is deferred on
evidence: its yield depends on how many source-map topics are held by two or more
sources, which is measurable now that this ships. The register and its data model
take a second producer without change.

## Code map

| concern | code |
|---|---|
| job contract | `packages/core/src/index.ts`, `packages/jobs/src/schemas.ts` |
| prompt | `packages/prompts/src/catalog.ts` (`VERIFY_DOCUMENT`) |
| marker | `packages/markdown/src/conflict-marker.ts` |
| routing | `apps/api/src/scheduling/verify-lens.ts` |
| annotate / repair | `apps/api/src/features/patrol/conflict-annotation.ts` |
| patrol wiring, gate exemption | `apps/api/src/features/patrol/service.ts` |
| register | `apps/api/src/stores/source-conflict-store.ts`, `postgres-source-conflict-store.ts`, migration `0062` |
| routes | `apps/api/src/features/source-conflicts/routes.ts` |
| console | `apps/web/src/components/SourceConflictsPanel.tsx`, `apps/web/src/app/conflicts/page.tsx` |
