# Knowledge change log

**Status:** as-built (2026-08-27) — write path only; the read surfaces are marked
below and are not yet built.

A durable, append-only record of **what changed in the destination knowledge
base, when, and what caused it**. It exists to answer two questions retrieval
structurally cannot: *"what's new this week in product X?"* (a time filter, not a
similarity search) and *"when did this change?"* (a fact about a section, which
the answer flow has no way to know).

## KC-1 · Change identity is `(documentId, anchor)`

Section-level entries are keyed on `(documentId, anchor)`; document-level entries
on `documentId` alone. This is the same durable identity `section_citation_usage`
(migration 0060) and the claim-provenance fold already use.

| identity | stability |
|---|---|
| `sectionId` = `<documentId>:<ordinal>` | breaks whenever a sibling is added or removed |
| `documentId` = `<repositoryId>:<path>` | stable while the file keeps its path |
| `anchor` = slugified heading path | stable while the heading text is unchanged |

**R1.** The change log MUST NOT be derived from `document_sections.content_changed_at`,
and MUST NOT extend it. `upsertSections` keys on `documentId:ordinal` and compares
each incoming section against whatever previously sat at that ordinal, so
inserting one section near the top of a document shifts every section below it
and moves all of their `content_changed_at` stamps. That over-reporting is the
*safe* direction for its two consumers (embedding carry-forward, questionnaire
answer reuse — a redundant re-embed, a suppressed verbatim reuse) and a lie for a
change log: "12 sections of the billing guide changed on Tuesday" when one
paragraph was inserted is worse than no log at all.

**R2.** A renamed heading MUST read as a `section_removed` plus a `section_added`.
The passage a reader could have cited last week is genuinely gone.

## KC-2 · One choke point: the index

**R3.** Entries MUST be derived from the index-time diff in
`InMemoryKnowledgeIndex`, which holds the prior `documents`/`sections` maps in
memory before overwriting them on both the full and `incrementalIndex` paths.

Hooking the index rather than the merge cascade matters for coverage: a human who
edits the destination repository by hand, or a merge that lands outside Magpie,
changes the knowledge base just as much as a proposal does, and the index sees all
of it. It also means an entry describes a change that **took effect**, not one
that was merely proposed.

**R4.** The diff MUST be a pure function over two section lists
(`diffKnowledgeSnapshots`), with no clock, ids, or database — so the identity
rules above are unit-testable without one.

Per re-index, per document, it yields:

- `document_added` / `document_removed` — document-level, no anchor. A document
  present on only one side yields exactly one entry; its sections are not
  enumerated.
- `section_added` / `section_removed` / `section_changed` — anchor-keyed, for
  documents present on both sides. `section_changed` only when the body of a
  *surviving* anchor differs.

**R5.** A re-index that produces no entries MUST write nothing.

**R6.** The change log MUST NOT be able to fail an index. The store call is
wrapped: a failing change store degrades the log and leaves the answer corpus
exactly as correct as it was.

**R7.** The log MUST NOT enter retrieval. Same rule as source maps: it is metadata
*about* the corpus, not corpus. Admitting change entries to the answer index would
let "we updated the rate-limit page" compete with the rate-limit page itself for
citation.

## KC-3 · Starting cold

**R8.** There MUST be no backfill of any kind. The log records forward from
install.

**R9.** The first index of a repository (one with no prior documents in the index)
is a **baseline** and MUST write nothing. Logging every document as an addition
would assert that the whole knowledge base changed on install day — the same lie
a `content_changed_at` backfill would tell. A restart is not a baseline:
`hydrate()` reloads the prior corpus first, so an unchanged repository diffs to
nothing.

Source-side history is empty on day one anyway: source sync baselines a source on
first sighting and generates nothing, so the first upstream-attributed entries
appear at the first commit after install.

## KC-4 · Cause attribution is a decoration

The index knows *what* changed, not *why*. `runMergeCascade` is the one caller
that knows a re-index was driven by a specific proposal, and passes that proposal
down as the **attribution hint** for the re-index it triggers. Every other
re-index attributes `external`.

```
proposal.jobId ──▶ source_sync_runs.job_id ──▶ { sourceId, fromSha, toSha }   (source_sync)
proposal.gapClusterId ─▶ the gap cluster                                       (gap)
proposal.seedPlanId ───▶ the seed plan                                         (seed)
drafting job type ─────▶ verify | correct | improve | dedupe | split           (patrol)
(none of the above) ───▶                                                       (external)
```

**R10.** Nothing about the diff's correctness may depend on the cause resolving. A
missing, failing, or unresolvable hint MUST yield cause `external` and a still-correct
entry. Lookup failures are logged and swallowed.

**R11.** `summary` MUST be a human label taken from data the system already holds
(the proposal title, the gap summary, the plan summary) — never model prose
written for this log, per the factual-register contract (#213).

## KC-5 · Data model

`knowledge_changes` (migration 0069), append-only. Columns: `id`,
`repository_id`, `document_id`, `path`, `anchor`, `heading`, `kind`, `changed_at`,
`commit_sha`, `cause`, `proposal_id`, `job_id`, `source_id`, `source_from_sha`,
`source_to_sha`, `summary`, `flow_id`.

**R12.** There MUST be no foreign keys to `documents` or `document_sections`, and
`proposal_id` / `job_id` MUST be plain text. A change entry has to outlive the row
it describes — "this section was removed on 12 August" is precisely an entry whose
section no longer exists — and an FK would cascade the history away on the very
re-index that created it. Matches `section_citation_usage` and
`questionnaire_item_citations`.

**R13.** `flow_id` MUST be resolved at write time from the destination the
repository belongs to, so filtering a flow's feed is an index scan rather than a
join back through configuration.

**R14.** Entries MUST dedupe on `(document_id, anchor, kind, commit_sha)`, written
with `ON CONFLICT DO NOTHING`. Re-indexing is not rare — a merge, a restart, and
the PR poller can each drive one — and the job-completion replay path deliberately
re-runs side effects after a 500. Document-level entries carry a NULL anchor, so
the unique index is built over `COALESCE(anchor, '')`.

**R15.** Entries with no `commit_sha` (a destination whose git context is
unavailable) MUST dedupe on a short window instead. A permanent
`(document_id, anchor, kind)` key would swallow the second real edit to a section.

Indexes: `(flow_id, changed_at DESC)` for the feed, `(document_id, changed_at DESC)`
for the per-document timeline.

## KC-6 · Read surfaces

> ⚠️ NOT YET IMPLEMENTED — the write path above is built; these are the remaining
> rollout steps of the design (`GET /api/knowledge/changes`, the console panel and
> document timeline, the `kb_changes` MCP tool, and answer-time change context).
> No read surface exists yet; entries are queryable only through the store.

## KC-7 · Known limitations

- **`section_changed` has no magnitude.** A one-word typo fix and a rewritten
  section are the same entry. Storing changed-byte counts is cheap; deciding what
  a reader should do with them is not, so it is left until a surface needs it.
- **Frontmatter-only edits are invisible.** A metadata change that leaves every
  section byte-identical produces no entry.
- **The log grows without bound**, at roughly the rate the knowledge base is
  edited. No pruning is proposed; if it is ever needed, the honest form is
  aggregation of old entries, not deletion.

## Code map

| concern | code |
|---|---|
| entry type | `packages/core/src/index.ts` (`KnowledgeChange`) |
| pure diff | `apps/api/src/stores/knowledge-change-diff.ts` |
| index hook | `apps/api/src/stores/knowledge-index.ts` (`recordChanges`, `snapshotRepository`) |
| store | `apps/api/src/stores/knowledge-change-store.ts`, `postgres-knowledge-change-store.ts` |
| schema | `packages/db/migrations/0069_knowledge_changes.sql` |
| attribution | `apps/api/src/features/proposals/change-attribution.ts`, `service.ts` (`reindexDestinationForProposal`) |
| source-sync join | `apps/api/src/features/source-sync/service.ts` (`resolveSourceOrigin`) |
| wiring | `apps/api/src/context.ts`, `apps/api/src/platform/stores.ts` |

## Provenance

Consolidates `docs/superpowers/specs/2026-08-27-knowledge-change-log-design.md`,
which builds on `2026-07-25-citation-usage-tracking-design.md` (durable
`(documentId, anchor)` identity, no-FK durability),
`2026-07-08-claim-provenance-design.md` (merged proposals as an append-only event
log), and the detection half of `2026-06-18-source-change-sync-design.md`.
