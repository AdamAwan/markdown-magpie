# Keyword-retrieval quality

Status: proposed (2026-08-11)

Spec 1 of 2. Spec 2 (`2026-08-11-local-embeddings-sidecar-design.md`) makes
embeddings available in deployments that have no embeddings endpoint. The two are
independent: this one improves lexical retrieval for *every* deployment, including
hybrid ones, because the keyword leg feeds RRF whether or not vectors exist.

## Problem

Without an embedding provider, `InMemoryKnowledgeIndex.search`
(`apps/api/src/stores/knowledge-index.ts`) short-circuits to keyword-only ranking —
no vector leg, no RRF. That fallback is documented and intended (`docs/retrieval.md`
R17). What is not intended is how badly it performs.

**Natural-language questions match nothing.** `PostgresKnowledgeStore.searchByKeyword`
uses `websearch_to_tsquery`, which ANDs every lexeme. The question

> how do we handle refunds for annual subscriptions?

compiles to `handl & refund & annual & subscript` — all four must occur in a
*single section*. Real questions rarely satisfy that, so the common result is zero
rows.

**The index is impoverished.** `packages/db/migrations/0034_section_fts.sql` builds
`search_tsv` from `heading || ' ' || content`, unweighted. It omits `heading_path`
and `path`, both of which sit on `document_sections` already. A section headed
"Annual plans" under `Billing > Refunds` in `billing/refunds.md` cannot be found by
the word "refunds".

**Zero hits become fabricated knowledge gaps.** The agentic loop records queries
that returned nothing and feeds them to the model as grounding
(`apps/watcher/src/runners/generative.ts`, the `MAX_SEARCH_ROUNDS` comment). In
hybrid mode that inference is sound: vector search returns nearest neighbours for
any query, so empty genuinely means nothing close. The `MIN_RELEVANCE` comment in
`apps/api/src/features/retrieve/service.ts` states this assumption outright. In
keyword mode the assumption is false, and a lexical miss is presented to the model
as evidence of absence. The model concludes the KB has a gap, and the gaps
subsystem accumulates retrieval failures.

Local demos run on a CLI chat provider with no API key, so they run in exactly this
mode. But the same lexical weaknesses degrade the keyword leg of hybrid retrieval
in production deployments too.

## Goal / non-goals

**Goal.** Make keyword-only retrieval a genuinely usable first-class mode: recall
that survives natural-language questions, ranking that degrades gracefully instead
of cliff-edging to empty, and gap records that distinguish "we could not find it"
from "it is not there".

**Non-goals.**

- **No extra model calls.** No query-time expansion, no index-time alias
  generation. Everything here is Postgres-side, so it adds no latency and no
  tokens, and works identically under every chat provider.
- **No new Postgres extensions.** No `pg_trgm`, no custom search configurations or
  synonym dictionaries. Stock full-text search only.
- **Not a gaps-subsystem redesign.** This spec stamps gap provenance and gates one
  downstream behaviour. Clustering, reconciliation, and maintenance scheduling are
  untouched.

## Design

### 1. Weighted index

Rebuild `search_tsv` as a weighted vector over fields that already exist on
`document_sections`:

| Weight | Field | Rationale |
| --- | --- | --- |
| A | `heading` | The section's own title |
| B | `heading_path` | Ancestor headings — currently invisible to search |
| B | `path`, with `/` and `-` replaced by spaces | Filenames carry real topical signal |
| C | `content` | Body text |

Two mechanical constraints:

- A `GENERATED ALWAYS ... STORED` expression must be IMMUTABLE.
  `array_to_string(heading_path, ' ')` may only be STABLE. **Verify this first.**
  If it is not IMMUTABLE, denormalise a `heading_path_text text` column written by
  the application at section upsert and index that. Do *not* wrap it in a
  hand-declared IMMUTABLE function: the declaration would be an assertion we cannot
  enforce, and it interacts badly with dump/restore ordering.
- A generated column's expression cannot be altered in place, so the migration is
  `DROP COLUMN search_tsv` + `ADD COLUMN search_tsv` with the new expression, plus
  recreating the GIN index. That rewrites `document_sections`. Acceptable at
  current corpus sizes; call it out in the migration comment.

### 2. OR matching with graded ranking

Match on OR'd lexemes so partial matches survive; rank so that matching more of the
question wins.

The query terms are derived by running the question through `to_tsvector` and
extracting lexemes with `tsvector_to_array`, then joining them with ` | `. This
reuses Postgres's own stemming and stopword removal rather than string-munging
`plainto_tsquery` output. Each lexeme is `quote_literal`'d before joining so
punctuation cannot produce a malformed tsquery. A question that yields no lexemes
produces an empty tsquery, which matches nothing — the same outcome as today's
empty-query guard.

Ranking is `ts_rank_cd(<weight array>, search_tsv, any_query, 32)`, multiplied by a
boost when the section *also* satisfies the strict `websearch_to_tsquery`. Sections
matching the whole question keep today's precedence; sections matching part of it
rank below them instead of disappearing.

Normalisation flag `32` is `rank / (rank + 1)`, already bounded in `[0,1)`.
`normaliseRank` (`apps/api/src/stores/postgres-knowledge-store.ts`) is therefore
**removed**, not stacked on top of it.

**Consequence: the relevance scale moves.** `MIN_RELEVANCE = 0.15` was chosen
against `rank / (rank + 0.1)`. It must be re-derived against the new scale, not
carried over. This is the change in this spec most likely to affect existing hybrid
deployments, because `MIN_RELEVANCE` is applied to the fused result of both legs.

### 3. Two-part relevance floor

OR matching admits weak single-term hits, so the floor in `retrieve()` gains a
relative component alongside the absolute one: keep sections at or above
`MIN_RELEVANCE`, **and** at or above a fraction of the top-scoring section.

This gives the behaviour the cliff currently lacks. When the best hit is strong,
weak filler is dropped. When every hit is weak, they are kept rather than the
caller receiving nothing — because in keyword mode "nothing" is the failure we are
trying to eliminate.

The relative floor applies in **both** modes. If it moves `docs/golden-eval.md`
numbers for hybrid, the correct response is to retune the constant, not to gate the
floor on retrieval mode.

### 4. Gap evidence

`retrievalMode()` already exists in `apps/api/src/platform/providers.ts` and returns
`hybrid | keyword` with a reason. Plumb it through:

- `POST /api/retrieve` returns `retrievalMode` and `candidateCount` (the count
  *before* the floor, so the watcher can distinguish "nothing matched" from
  "everything was filtered").
- The `answer_question` job input carries `retrievalMode`.
- The answer prompt frames a zero-hit search in keyword mode as *no lexical match*,
  explicitly weak evidence of absence — not *not covered*.

Structurally, `question_gaps` gains a nullable `retrieval_mode text` column (NULL =
recorded before this change). Gaps recorded in keyword mode are stored and remain
fully visible in the console; they are excluded from **automatic** proposal
generation until corroborated.

Suppressing them outright was considered and rejected: in a deployment that will
never have embeddings, that switches the gaps subsystem off permanently. Recording
with weaker provenance keeps the signal and stops it driving unattended work.

### 5. In-memory parity

`keywordRankInMemory` (`apps/api/src/stores/knowledge-index.ts`) is the fallback for
the no-Postgres path and for test fixtures. It already ORs terms, but scores only
`heading + content`, weighting a heading hit 3× a body hit. It gains `heading_path`
and `path` with weights mirroring the SQL vector, so the two paths cannot silently
diverge in ranking.

### Constants

Three numeric values are deliberately left unfixed here — the strict-match boost
multiplier, the relative-floor fraction, and the re-derived `MIN_RELEVANCE`. They
are not omissions: each must be chosen against `docs/golden-eval.md` output rather
than asserted in advance, and picking numbers now would give them false authority.
The implementation plan starts from boost `1.5`, relative floor `0.35`, and a
`MIN_RELEVANCE` re-derived so that today's single-term match sits at the same
accept/reject verdict as before, then tunes all three against the eval. All three
live beside the existing constants they join.

## Testing

- **Postgres integration** (`RUN_PG_INTEGRATION`, per `writing-magpie-tests`): a
  question whose lexemes are split across sections returns results (the regression
  that motivates this spec); a whole-question match outranks a partial one; a
  `heading_path`-only match is retrievable; a `path`-only match is retrievable.
- **Unit**: the two-part floor keeps weak-but-best results and drops weak-alongside-
  strong ones; the in-memory scorer ranks the four fields consistently with SQL.
- **Contract**: `/api/retrieve` carries `retrievalMode` and `candidateCount`;
  `answer_question` input accepts and forwards it.
- **Regression gate**: `docs/golden-eval.md` run before and after, as the check on
  the `MIN_RELEVANCE` rescale.

## Risks

- **`MIN_RELEVANCE` rescale reaches hybrid deployments.** Mitigated by the golden
  eval as an explicit gate rather than a spot check.
- **`array_to_string` immutability is unverified.** It changes the migration from
  one step to two (denormalised column + application write path). Verify before
  planning.
- **The §4 gate is the only part that leaves retrieval.** It touches which gaps
  drive automatic proposals. Bounded deliberately to a stamp plus one gate.

## Open questions

None. The `array_to_string` immutability question is a verification step for the
implementation plan, not an unresolved design decision — both branches are
specified.
