# Knowledge change log

Status: proposed (2026-08-27)

## Problem

Magpie already reacts to change continuously. `source_change_sync` diffs every
git source every ten minutes, patrols rewrite documents hourly, gaps draft new
ones, and each merge re-indexes the destination. The system therefore *knows*,
at all times, what moved upstream, what it changed in the knowledge base, and
why — and it throws all three away as soon as the proposal lands.

Two questions a user will reasonably ask cannot be answered today:

- **"What's new this week in product X?"** — a time-filtered list, not a
  similarity search. Retrieval cannot serve it: recency is not an axis RRF
  ranks on, so the hybrid retriever returns whatever is *semantically* nearest
  to the words "new" and "this week", which is noise.
- **"When did this change?"** — asked about a feature the KB already documents.
  The answer flow cites sections and has no idea how old any of them are, so it
  either omits the fact or the model invents a date.

The raw material exists but is scattered, non-durable, and in one case actively
misleading:

| Signal | Where | Why it is not a change log |
|---|---|---|
| Upstream commit ranges | `source_sync_runs` (`from_sha`, `to_sha`, `plan`, `changeset`) — migrations 0013/0023 | Operator telemetry, keyed by run, never joined to the documents that actually changed; a run that folds into an existing PR records no KB effect at all |
| KB edits with cause | `proposals` (`merged_at`, `target_path`, `provenance`) + `listMergedByTargetPath` (0050) | Records the *intent* that shipped, not the effect. A merged multi-file `changeset` proposal has one row; a merge that changed nothing byte-wise looks identical to one that rewrote a page |
| Per-section change instants | `document_sections.content_changed_at` (0054) | **Wrong for this purpose** — see below |
| Destination git history | `magpie/proposal-*` merges | Real, but unqueryable from the product and carries no flow/source/cause attribution |

### Why `content_changed_at` cannot be read as a change log

`upsertSections` keys on `sectionId = <documentId>:<ordinal>` and compares the
incoming `(heading, content)` against **whatever section previously sat at that
ordinal**. Insert one section near the top of a document and every section below
it shifts down one ordinal, compares unequal, and has its `content_changed_at`
moved to `now()`.

That is correct — deliberately so — for the two consumers it was built for.
Embedding carry-forward and questionnaire answer reuse both treat
over-reporting change as the *safe* direction: the worst case is a redundant
re-embed or a suppressed verbatim reuse.

For a change log the same over-reporting is a lie. "12 sections of the billing
guide changed on Tuesday" when one paragraph was inserted is worse than no
change log, because a human cannot tell the real edit from the ordinal shear.
So this design does **not** consume `content_changed_at`, and does not extend
it. It computes its own diff against a stable identity.

## Goal / non-goals

**Goal.** A durable, queryable, flow-scoped log of what changed in the
destination knowledge base, when, and what caused it — exposed to humans (API +
console), to MCP clients, and to the answer flow as citation-time context.

**Non-goals.**

- **No model-authored narrative in the record.** Entries are derived from a
  diff and from cause metadata the system already holds. Rendering a list of
  entries into prose is a separate, later concern (see *Deferred*), and even
  then the log itself stays factual — consistent with the factual-register
  contract (#213).
- **The log never enters retrieval.** Same rule as source maps (source-sync
  S10): it is metadata about the corpus, not corpus. Admitting change entries
  to the answer index would let "we updated the rate-limit page" compete with
  the rate-limit page itself for citation.
- **No backfill.** The log starts at install (see *Starting cold*).
- **No source-side change log.** Upstream commits are attributed as the *cause*
  of a KB change; a source commit that changed nothing in the KB produces no
  entry. Magpie documents its own knowledge base, not other people's repos.
- **No new job types in this design.** Every event is written on a code path
  that already runs.

## Durable change identity

Entries key on **`(documentId, anchor)`** for section-level changes and
`documentId` for document-level ones, exactly as citation-usage tracking (0060)
and the provenance fold already do:

| identity | stability |
|---|---|
| `sectionId` = `<documentId>:<ordinal>` | breaks whenever a sibling is added or removed — the shear described above |
| `documentId` = `<repositoryId>:<path>` | stable while the file keeps its path |
| `anchor` = slugified heading path | stable while the heading text is unchanged |

Three consumers now agree on what "the same section" means. A renamed heading
reads as a removal plus an addition, which is the honest rendering: the passage
a reader could have cited last week is genuinely gone.

## Where entries come from

**One choke point: the index.** `InMemoryKnowledgeIndex.indexLocalRepository`
is the only path by which anything reaches the answer corpus, and it holds the
prior `documents`/`sections` maps in memory before overwriting them. Both the
full and `incrementalIndex` paths therefore have before and after in hand
already; the diff is a pure function over two section lists, computed by
anchor.

Hooking the index rather than `runMergeCascade` matters for coverage: a human
who edits the destination repository by hand, or a merge that lands outside
Magpie, changes the knowledge base just as much as a proposal does, and the
index sees all of it. It also means an entry describes a change that **actually
took effect**, not one that was merely proposed.

Per re-index, per document, the diff yields:

- `document_added` / `document_removed` (document-level, no anchor)
- `section_added` / `section_removed` / `section_changed` (anchor-keyed;
  `section_changed` only when the body of a *surviving* anchor differs)

A re-index that produces no entries writes nothing. Renames of a whole file are
already modelled upstream as delete-then-add (`incrementalIndex`), and inherit
that shape here.

### Cause attribution

The index knows *what* changed, not *why*. Cause is resolved from data already
linked, best-effort, and stamped on the entry:

```
proposal.jobId ──▶ source_sync_runs.job_id ──▶ { sourceId, fromSha, toSha }
proposal.gapClusterId ─▶ gap cluster summary          (cause: "gap")
proposal.seedPlanId ───▶ seed plan                    (cause: "seed")
draft/patrol job type ─▶ verify | correct | improve | dedupe | split
(none of the above) ───▶ cause: "external"            (hand edit, direct merge)
```

`runMergeCascade` is the one caller that knows a re-index was driven by a
specific proposal, so it passes that proposal down as the *attribution hint*
for the re-index it triggers. Every other re-index attributes `external`. This
keeps attribution a decoration on an independently-correct diff: if the hint is
missing or wrong, the entry still records a true change, just an unattributed
one. Nothing about the log's correctness depends on the cause being resolvable.

## Data model

`knowledge_changes` (migration 0069), append-only:

| column | role |
|---|---|
| `id` | entry id |
| `repository_id`, `document_id`, `path` | which destination, which document |
| `anchor`, `heading` | durable section identity + latest display label; both NULL on a document-level entry |
| `kind` | `document_added` \| `document_removed` \| `section_added` \| `section_removed` \| `section_changed` |
| `changed_at` | when the re-index observed it |
| `commit_sha` | destination HEAD the change was observed at |
| `cause` | `gap` \| `source_sync` \| `patrol` \| `seed` \| `external` |
| `proposal_id`, `job_id` | attribution links, nullable |
| `source_id`, `source_from_sha`, `source_to_sha` | the upstream commit range that caused it, when resolvable |
| `summary` | the proposal title / gap summary / plan summary — a human label, never model prose written for this log |
| `flow_id` | resolved at write time from the destination, so a filter is an index scan not a join through config |

**No foreign keys to `documents` or `document_sections`**, matching
`section_citation_usage` and `questionnaire_item_citations`. A change entry must
outlive the row it describes — "this section was removed on 12 August" is
precisely an entry whose section no longer exists, and an FK would cascade the
history away on the very re-index that created it. `proposal_id` and `job_id`
are likewise stored as plain text.

Indexes: `(flow_id, changed_at DESC)` for the feed, `(document_id, changed_at
DESC)` for the per-document timeline.

### Idempotency

Re-indexing is not rare — a merge, a restart, and the PR poller can each drive
one — and a full re-index after a restart compares against a hydrated prior, so
identical content produces an empty diff and no entries. The real risk is a
*re-run of the same transition* (the completion replay path, which deliberately
re-runs side effects after a 500). Entries are therefore deduped on
`(document_id, anchor, kind, commit_sha)`: the same change observed at the same
destination commit is one entry, written with `ON CONFLICT DO NOTHING`. A
destination whose git context is unavailable has no `commit_sha`; those entries
fall back to deduping within a short window on `(document_id, anchor, kind)`.

## Read surfaces

**`GET /api/knowledge/changes`** (`read:knowledge`), alongside
`/api/knowledge/citation-usage` and following its shape — filtered, paginated,
with a summary envelope:

- filters `flowId`, `documentId`, `sourceId`, `since`, `until`, `cause`, `kind`
- `limit` / `offset`; default ordering newest first
- a summary envelope: entry counts by kind and by cause over the filtered
  window, plus distinct documents touched
- `flowId` resolves through the flow's destination; a cross-flow `documentId`
  reads as 404, not 403, per the authorization convention

**Console.** A "Recent changes" panel on `/knowledge` (page-local fetch, the
Insights pattern, so it stays out of the global poll), and a per-document
timeline on the document view. Entries render as
`§ Rate tiers changed — source product-repo a1b2f3…c3d4e5 — 12 Aug`, linking
to the proposal where one is attributed.

**MCP.** An eleventh tool, `kb_changes` (`read:knowledge`), taking `flowId`,
`since`, and an optional `documentPath`. This is what actually answers "what's
new this week in product X" for a client: a filtered list, returned directly,
with no queue round-trip and no model call. Registered in `main.ts` and
scope-mapped in `http.ts` alongside the existing ten.

## Answer-time change context

Separate from the log's own surfaces, and the piece that makes "when did this
change?" answerable in an ordinary ask.

The scoped-context callback the watcher already calls for retrieval attaches,
per returned section, the most recent `knowledge_changes` entry for that
`(documentId, anchor)` — its `changed_at`, `cause`, and `summary`. The answer
prompt gains a factual line per cited section ("last changed 12 Aug 2026,
following an upstream source change") and the standing instruction that it may
state a change date **only** for a section it is citing and only from this
metadata.

This deliberately keeps change data out of the retrieval index while still
letting an answer carry it: the sections are chosen on merit, and the dates ride
along on the ones that were chosen anyway. A section with no entry (unchanged
since install) carries no date and the model says nothing — silence, not a
guess.

## Starting cold

The log records forward only.

- **No backfill from `content_changed_at`.** 0054's backfill set every existing
  row to `now()`, so a backfill would assert that the entire knowledge base
  changed on migration day.
- **No backfill from destination git history.** Possible, and deliberately out
  of scope: it would produce entries with no cause attribution and no anchor
  identity that the current parser agrees with. If it is wanted later it is an
  additive, standalone script.
- **Source-side history is empty on day one anyway.** Source sync *baselines* a
  source on first sighting and generates nothing (source-sync S2), so the first
  upstream-attributed entries appear at the first commit after install.

The console panel and the API summary both report the log's start instant, so
an empty week is visibly "nothing recorded yet" rather than "nothing changed".

## Honesty about truncation

`SOURCE_SYNC_MAX_CHANGED_FILES` (default 1000) caps the files a sync run
materializes while recording the *true* total on the run. Where a change entry
displays its causing commit range, it carries both numbers and renders
"1,412 files changed upstream (1,000 examined)". A change log that implies
completeness it does not have is the failure mode most worth avoiding here.

## Deferred

- **Prose summaries.** A `summarize_changes` provider job rendering a filtered
  entry list into a paragraph — queue-only, via the add-a-job-type skill. Worth
  doing only once real entries exist and their shape has settled; the filtered
  list is already the useful artefact.
- **Digest delivery.** A weekly "what changed" digest is a scheduling concern on
  top of the same query, not a change to this design.
- **Source-side change feeds.** See non-goals.

## Rollout

1. Migration 0069 + store + the index-time diff, writing entries with cause
   `external` only. Verifiable in isolation: re-index a destination with an
   edited file and assert one `section_changed` entry against the right anchor,
   plus the insert-a-section case asserting exactly one `section_added` and no
   shear.
2. Cause attribution through `runMergeCascade`, and the source-sync run join.
3. `GET /api/knowledge/changes` + the console panel and document timeline.
4. `kb_changes`.
5. Answer-time change context (callback field + prompt clause), behind its own
   validation against the golden eval — a prompt change to the answer path is
   the highest-risk step here and lands last, alone.

Steps 1–4 add no AI spend and no new job types.

## Open questions

- **Does `section_changed` need a magnitude?** A one-word typo fix and a
  rewritten section are the same entry today. Storing changed-byte counts is
  cheap; deciding what a reader should do with them is not. Left out until a
  surface needs it.
- **Frontmatter-only edits.** A change to a document's metadata that leaves
  every section byte-identical currently produces no entry. Probably correct
  (nothing a reader would notice changed), but it means an `owner:` or
  `last_verified:` change is invisible in the log.
- **Retention.** The log grows without bound, at roughly the rate the KB is
  edited — small, but unbounded. No pruning is proposed; if it is ever needed,
  the honest form is aggregation of old entries, not deletion.

## Provenance (design history)

New design. Builds on: `2026-07-25-citation-usage-tracking-design.md` (durable
`(documentId, anchor)` identity, no-FK durability), `2026-07-08-claim-provenance-design.md`
(merged proposals as an append-only event log), and the source-sync detection
half of `2026-06-18-source-change-sync-design.md`. A living as-built spec
(`docs/knowledge-changes.md`) follows implementation, per the spec conventions.
