# Section citation-usage tracking

Status: approved (2026-07-25)

## Problem

A destination knowledge base only grows. Documents get seeded, drafted, patrolled
and improved, but nothing in Magpie records **which sections actually earn their
keep** — i.e. which ones get cited when questions are answered. When the time
comes to trim the KB (cost, noise, retrieval precision), there is no evidence for
"this document has never been cited in 6 months" versus "this one answers
something weekly".

The data exists in principle — every answer records its citations — but it is not
usable as a usage record:

- `answer_citations` is explicitly **write-only audit data** (see
  `0008_citation_section_cascade.sql`) and it is keyed on `section_id` with
  `ON DELETE CASCADE`. Section ids are `"<documentId>:<ordinal>"`, so *any*
  re-index that inserts or removes a section in a document renumbers the tail and
  the old rows cascade away. A KB that gets edited loses its own citation history.
- Deleting a logged question (the privacy scrub) also cascades its citations away.

So a durable, section-identity-keyed usage record is needed alongside the audit
table.

## Goal / non-goal

**Goal.** A durable per-section counter of how often a section has been cited in
an answer, with first/last-cited timestamps, surfaced as a report that ranks the
KB from least- to most-used (including never-cited sections) at both section and
document granularity.

**Non-goals.**

- No automatic trimming, archiving or "unused" flagging — the record informs a
  human decision, nothing acts on it.
- No per-question citation history. The counter is an **aggregate**: it stores no
  question ids and no question text, so the question scrub has nothing to purge
  and the record survives it.
- No time-series. `citationCount` + `firstCitedAt` + `lastCitedAt` answers "how
  much, and is it still happening?"; a full history would re-introduce the
  per-question rows this design deliberately avoids.

## Durable section identity

The key is **(documentId, anchor)**, not `sectionId`:

| identity | stability |
|---|---|
| `sectionId` = `<documentId>:<ordinal>` | breaks whenever a sibling section is added/removed |
| `documentId` = `<repositoryId>:<path>` | stable while the file keeps its path |
| `anchor` = slugified heading path | stable while the heading text is unchanged |

`(documentId, anchor)` is the same identity the claim-provenance fold uses to
re-anchor claims across rewrites, so usage tracking and provenance agree on what
"the same section" means. A renamed heading or a moved file starts a new usage
row — the honest answer, since the cited passage's identity genuinely changed.

## Data model

`section_citation_usage` (migration 0060), keyed `(document_id, anchor)`:

| column | role |
|---|---|
| `document_id`, `anchor` | durable section identity |
| `path`, `heading` | latest observed display labels, so a row stays readable after its section leaves the index |
| `citation_count` | number of distinct answered questions that have cited this section |
| `first_cited_at`, `last_cited_at` | when the section first/most recently earned a citation |

**No foreign keys, by design** — the same rationale as
`questionnaire_item_citations`: the record must outlive the section row it
describes. A usage row whose section is no longer indexed is not orphaned junk;
it is the evidence that something being used got deleted, and the report says so.

## What counts as a use

One increment per **(question, section)** pair, at the moment the answer's
citations are recorded:

- **Counted:** `live` asks and `questionnaire` asks (both are somebody asking
  something).
- **Not counted:** `verification` re-asks. Those are the system checking its own
  work after a merge (#150) — counting them would let maintenance manufacture
  usage for the documents it just wrote.
- **Idempotent by construction.** Re-answering a question (job repair, the
  idempotent completion replay) counts only the pairs the question was not
  already citing: the increment is the delta against the question's existing
  `answer_citations` rows, computed inside the same transaction that rewrites
  them. Answering the *same* question again with the *same* citations adds
  nothing; a re-answer that cites something new counts only the new sections.
- Counts are never decremented. A section that stopped being cited keeps its
  count and ages out via `lastCitedAt` — that pair ("used 40 times, last in
  January") is exactly the trim signal.

Verbatim questionnaire reuse (an approved answer replayed without a model call)
does not mint a question, so it does not increment. Documented, not fixed here:
its basis item's original ask was already counted.

## Report

`GET /api/knowledge/citation-usage` (`read:knowledge`), which joins the durable
counters against the **live index** so never-cited sections appear:

- `group=section` (default) | `document` — the document rollup is the actionable
  one for trimming, since files are what get deleted.
- `sort=least` (default) | `most` | `recent`. `least` orders never-cited first,
  then by oldest last-citation — the "what could go" ordering.
- `limit` / `offset`, plus a `summary` envelope (indexed vs cited vs uncited
  counts, total citations, and how many usage rows describe sections that are no
  longer indexed).
- Every row carries `indexed`, so a report row for a deleted-but-used section is
  visibly distinct from a live one.

The console surfaces it on `/knowledge` as a "Citation usage" panel, fetched
page-locally (the Insights pattern) so it stays out of the global console poll.

## Store semantics

`QuestionLogStore` grows one read method, `listSectionCitationUsage()`. The
Postgres store reads the durable table; the in-memory store derives the same
aggregate from the logs it holds. The in-memory backend therefore does not model
the *durability* property (it has no re-index to survive) — that difference is
inherent to a store that vanishes with the process, and the Postgres integration
test is what pins the durability guarantee.
