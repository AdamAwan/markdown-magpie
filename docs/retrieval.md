# Retrieval & Answering

> **Status:** living spec (as-built). Source of truth for how Markdown Magpie routes a
> question to a flow, retrieves grounding context, and produces a cited answer.
> Reference exemplar for the [spec conventions](./README.md#conventions).

## Purpose

Turn a natural-language question into a grounded, cited answer — or an explicit
knowledge gap when the corpus cannot support one. Answering is an **agentic loop**
(assess → search → maybe search again → answer → verify grounding) that runs entirely
in the watcher; the API only enqueues the job and serves pure retrieval/routing
callbacks. Weak or unanswerable questions feed the gaps subsystem
([gaps-and-maintenance.md](./README.md)).

## Boundaries & execution model

- **R1** — The API MUST NOT call a chat model inline for answering. `POST /api/ask`
  records a question log and enqueues an `answer_question` job; all generative work
  (routing, retrieval assessment, answering, grounding) runs in the watcher's
  generative runner. `/api/ask` returns **202** with `{questionId, conversationId, job,
  links}`.
- **R2** — Query-time **embeddings** are the sanctioned inline exception: the API
  computes them synchronously for vector retrieval and for embedding-based flow routing.
- **R3** — **Index-time** embedding is neither inline-in-request nor a queued job: it
  runs as an in-API background task (`BackgroundEmbedder`) triggered after indexing.
  There is no `embed_sections` job type.
- **R4** — The watcher reaches retrieval and routing only through the API's pure
  `POST /api/retrieve` and `POST /api/route` callbacks. It has no database access.

## Flow routing

- **R5** — A caller-pinned flow (`requestedFlowId` on the job, or the conversation's
  sticky `conversationFlowId`) MUST skip routing entirely and be used as-is.
- **R6** — Otherwise routing is **embedding-first**: the watcher calls `POST /api/route`,
  which embeds the question and each candidate flow's routing text and scores by cosine
  similarity. The flow embedding text is **`name` + `routingSummary` + `persona`**, and
  the `routingSummary` MUST be resolved server-side from live config by flow id — never
  trusted from the request body (the `/api/route` body accepts only `{id, name,
  persona?}`).
- **R7** — A flow is chosen only when `topScore ≥ minTopScore` **and**
  `(topScore − runnerUpScore) ≥ minMargin`. Confidence is `high` when
  `margin ≥ 2 × minMargin`, else `medium`. Defaults: `minTopScore = 0.25`
  (`FLOW_ROUTER_MIN_SCORE`), `minMargin = 0.05` (`FLOW_ROUTER_MIN_MARGIN`).
- **R8** — Routing MUST fall back to the chat router only on **abstain** (scores too
  close, no embedding provider, or an embed error). The trace records
  `routing.method = "embedding" | "chat"` accordingly.
  > ⚠️ NOT YET IMPLEMENTED (partial): the runner sets `routing.method` on the trace, but
  > `answerTraceSchema.routing` does not declare a `method` field, so it is stripped
  > before persistence. Either declare `method` on the schema or stop setting it — the
  > spec's intent is that the persisted trace records how routing was decided.

## The answering loop

- **R9** — For a follow-up turn, the runner MAY first condense the question plus bounded
  prior turns into a standalone question; the standalone form then drives routing,
  retrieval, and answering. Conversation context is bounded to `MAX_PRIOR_TURNS = 6`
  turns and `MAX_ANSWER_CHARS = 1200` per prior answer.
- **R10** — The loop seeds a section `pool` from an initial `/api/retrieve`, then repeats
  `assess()` up to `MAX_SEARCH_ROUNDS = 3` times while `pool.size < MAX_POOL_SECTIONS =
  15`. Each `assess()` returns either a final answer or `{action: "search", queries}`;
  **the model's own assessment drives follow-up searches**.
- **R11** — Forced-search guard: if the model tries to answer with low confidence / gap
  on the **first** round having run zero searches, the loop MUST force one round of
  gap-derived searches (capped at 3 queries) before accepting a weak answer.
- **R12** — On exhausting the rounds or hitting the pool cap, the loop issues a final
  `assess(…, forceAnswer = true)`.
- **R13** — **Grounding verification.** After a draft answer, a second model call reviews
  it against the cited sections (full text) plus uncited retrieved sections (headings
  only). Unsupported claims are stripped, confidence is downgraded to `low`, and the
  stripped claims are recorded as gaps. Verification is **skipped** when the answer is
  out-of-scope, has no sections, or is a low-confidence structured answer. It fails
  **open** for structured answers (an unparseable verdict keeps the draft) and
  **closed** for unstructured/prose answers.

## Retrieval

- **R14** — Retrieval is **hybrid**: keyword ranking and vector ranking (pgvector cosine,
  `1 - (embedding <=> query)`), each over-fetching `20` candidates, are fused with
  **Reciprocal Rank Fusion** (`score += 1 / (k + rank)`, `k = 60`). RRF is rank-based and
  needs no score normalisation.

  Keyword ranking is **OR-matched, weight-graded** full-text search. The question is run
  through `to_tsvector('english', …)` and its lexemes re-joined with ` | ` (each
  `quote_literal`'d), so Postgres's own stemming and stopword removal build the query and
  a section covering *part* of the question still surfaces. Ranking is
  `ts_rank_cd({0.1, 0.3, 0.6, 1.0}, search_tsv, any_query, 32)` over the weighted vector
  built by migration `0063` — `A` heading, `B` heading path, `B` file path (punctuation
  flattened to spaces), `C` body — multiplied by `STRICT_MATCH_BOOST = 1.5` when the
  section *also* satisfies the strict `websearch_to_tsquery`. Normalisation flag `32` is
  `rank / (rank + 1)`, already bounded in `[0,1)`, so there is **no** application-side
  rank normalisation — Postgres returns the final scale. `keywordRankInMemory`
  (`knowledge-index.ts`) mirrors the same four weighted fields for the no-Postgres path.

  > As built, the boost **saturates**: relevance is clamped to `1`, and every strict match
  > measured against the golden KB has a raw rank ≥ `0.667`, so `× 1.5` clamps to exactly
  > `1.0`. In practice `STRICT_MATCH_BOOST` therefore reads as "a whole-question match
  > scores 1.0", and ordering *among* strict matches is lost. Values ≤ `1.1` would make it
  > a genuine multiplier; no eval case distinguishes the two, so `1.5` stands.

- **R15** — Each returned section's `relevance` is `max(cosineSimilarity,
  keywordRelevance)` — **not** the fused RRF score, which is used only for ordering.

  > This mixes two incomparable scales behind one number, which is what makes R16's floors
  > hard to tune: the same threshold means "matched a couple of weighted lexemes" on the
  > keyword leg and "is this cosine-similar" on the vector leg.

- **R16** — The API applies a **two-part relevance floor** in `retrieve()`. A section is
  kept only when `relevance ≥ MIN_RELEVANCE` (**absolute**, `0.4`) **and**
  `relevance ≥ topRelevance × RELATIVE_RELEVANCE_FLOOR` (**relative**, `0.5`). Both apply
  in **both** retrieval modes — neither is gated on mode. Default retrieve `limit` is `5`.

  The relative floor exists so that a strong result implies its weak neighbours are noise,
  while a pool that is uniformly mediocre survives intact — it can never empty a result,
  because the top section always clears its own fraction. The absolute floor is the one
  that can, and does, return nothing.

  > **The two-part floor is still effectively one part on the keyword leg.** The relative
  > floor can only cut inside `[MIN_RELEVANCE, topRelevance × RELATIVE_RELEVANCE_FLOOR)`,
  > i.e. `[0.4, top × 0.5)`, which is empty unless `top > 0.8`. Even at `top = 1.0` the
  > live band is `[0.4, 0.5)` — which sits entirely inside the measured-empty gap between
  > single-lexeme noise (`≤ 0.375`) and real signal (`≥ 0.714`), so on the quantised
  > keyword scale nothing lands in it. Raising the fraction from `0.35` to `0.5` made the
  > relative floor *reachable* rather than provably dead (at `0.35` it could never cut
  > anything the absolute floor had not already cut), but it only genuinely bites on the
  > **continuous cosine leg**, where scores are not quantised. Treat the second part of
  > the floor as a hybrid-mode mechanism.

  `MIN_RELEVANCE` was re-derived in Task 7 against the golden KB, because
  `ts_rank_cd(…, 32)` replaced the old `rank / (rank + 0.1)` normalisation and `0.15` no
  longer meant what it had meant. Measured distribution: a single body (`C`) lexeme scores
  exactly `0.2308`, a single path / heading-path (`B`) lexeme exactly `0.3750`, and the
  weakest genuinely answer-bearing section `0.7143`. `0.4` is the lowest round value clear
  of that noise band, chosen at the *bottom* of the empty band rather than its middle
  because R15 applies the same floor to cosine similarity, where a higher value would
  prune real vector hits.

  > **The floor was derived against the SQL keyword leg only, and the in-memory leg
  > disagrees with it.** `MIN_RELEVANCE` is a measured property of `ts_rank_cd(…, 32)` over
  > the weighted tsvector. The in-memory keyword fallback in `knowledge-index.ts` — used in
  > no-persistence mode *and* whenever the Postgres keyword search errors (R17) — is a
  > different scoring function: additive field weights over `KEYWORD_RELEVANCE_SCALE` (26).
  > The two legs therefore cut in different places near the floor. Worked example: a section
  > matching three body-only terms scores `9 / 26 ≈ 0.346` in memory (**dropped**) but
  > `0.9 / 1.9 ≈ 0.474` in SQL (**kept**). The golden eval boots a real pgvector container,
  > so it measures only the SQL leg and this divergence is invisible to it; the in-memory
  > values either side of `0.4` are pinned by unit tests in `knowledge-index.test.ts`
  > instead. This is recorded as-built, not endorsed — closing the gap requires measuring
  > the in-memory leg, which has not been done.

  > **Empty is still read as absence downstream.** The design intent was that an empty
  > keyword-mode result is *not* evidence of a knowledge gap, and the prompt layer honours
  > that (R17's lexical-miss note). The answer builder does not: `buildAnswerOutput`
  > (`job-prompts.ts`) still branches on `sections.length === 0` into the knowledge-gap
  > path. That branch is what makes a genuine gap question emit a gap and cite nothing, so
  > it is load-bearing today — but it means `MIN_RELEVANCE` is simultaneously the noise
  > filter and the gap trigger, and the two want different values.

- **R17** — With no embedding provider (or on a vector-search error) retrieval MUST degrade
  to keyword-only top-K rather than failing the request. `POST /api/retrieve` reports which
  mode ran (`retrievalMode`) plus `candidateCount`, the match count **before** the floor,
  so the caller can tell "nothing matched" from "everything was filtered". The mode is a
  property of the deployment, so the loop takes it from the seed retrieval and reuses it
  for every search in the job. A search that returns nothing is framed to the model as a
  *lexical miss* in keyword mode, explicitly not as evidence of absence
  (`buildEmptySearchNote`); on the forced-final-answer turn the "retry with different
  vocabulary" suggestion is suppressed, because that turn accepts only an answer. In
  **hybrid** mode `buildEmptySearchNote` returns `""` — no note at all: an empty vector
  search genuinely is evidence of absence, and the hybrid prompt is deliberately left
  byte-identical to its pre-feature form because the golden eval runs keyword-only and
  could not measure a hybrid prompt change.

  Gaps recorded from `auto` / `followup` sources are stamped with the active mode on
  `question_gaps.retrieval_mode` (migration `0064`; NULL = pre-change, or not derived from
  retrieval). Gap candidacy (`gapIdsForSummary`) excludes `keyword`-mode gaps, so they
  never drive unattended proposal generation, while remaining fully visible in the console.

  > **Operator-visible cliff.** In a Postgres deployment with no embeddings endpoint,
  > *every* new `auto`/`followup` gap is stamped `keyword`. Automatic proposal generation
  > therefore goes quiet for all of them — the gaps keep accumulating and stay visible in
  > the console, but nothing acts on them until an embeddings endpoint is configured. This
  > is deliberate (weaker provenance must not drive unattended work), but it is a silent
  > mode change from an operator's point of view. A second, unrelated suppression also
  > applies to `followup` gaps in **both** modes — see R22.

## Citations

- **R18** — Citations MUST be derived in code from the retrieved sections and never
  trusted from the model. The model names *used* section ids (`usedSectionIds`); code
  narrows the retrieved pool to those and sorts strongest-first by relevance.
- **R19** — If the model names no valid ids, citations fall back to the whole retrieved
  pool. If it names **only** ids that were never retrieved, `attributionFailed` is set
  and the answer is downgraded to `low` confidence.

  > This fallback was written when retrieval either returned good matches or nothing.
  > OR matching removed the "nothing" case for any question sharing a lexeme with the
  > corpus, so a **weak non-empty pool now produces spurious citations**: a knowledge-gap
  > answer names no used ids (correctly — it used none) and gets the entire weak pool
  > attached as its citations. R16's absolute floor is what currently keeps that pool
  > empty for a genuine gap; the fallback itself has not been changed, and it remains the
  > second reason `MIN_RELEVANCE` cannot be lowered.

## Job contract (`answer_question`)

- **R20** — `answer_question` is `provider`-routed, interactive, repairable, retry limit
  3, `expireInSeconds = 300`. `answer_question_batch` shares the contract but is
  non-interactive. Full input/output shapes live in `packages/jobs/src/schemas.ts`
  (`answerQuestionInputSchema` / `answerQuestionOutputSchema`); see
  [ai-jobs.md](./ai-jobs.md) for the queue/capability model.
- **R21** — The output carries `{answer, confidence(high|medium|low|unknown), citations,
  gaps?, flowId?, flowSelectionRequired?, outOfScope?, trace?, standaloneQuestion?,
  reuse?}`. The `trace` records routing, seed/pool section counts, per-round searches,
  whether the answer was forced, the answer contract, and the grounding verdict.
- **R22** — Two kinds of gap reach the output. **Auto** gaps come from the model flagging
  the whole question as unanswerable (or from the grounding verifier stripping a claim).
  **Followup** gaps come from the model naming a specific sub-clause it could not support
  (`followupGaps`) while still answering the rest — the partial-answer case. Followup gaps
  are additionally gated: `groundedFollowupGaps`
  (`apps/watcher/src/job-prompts.ts`) discards **every** model-declared followup gap
  unless at least one search in the loop returned **zero** sections
  (`unsatisfiedSearches.size > 0`). The rule exists so the model may only claim missing
  supporting material if it actually went looking and came up empty.

  > ⚠️ **REGRESSION (as built).** OR matching (R14) has made a zero-section search nearly
  > unreachable: any query sharing a single lexeme with the corpus now returns rows, and
  > R16's floor only empties a pool of pure single-lexeme noise. So `unsatisfiedSearches`
  > is almost always empty and **followup gaps are almost never emitted**.
  >
  > Observable consequence: a multi-clause question whose knowledge base covers only some
  > clauses returns a partial answer that says so in prose, cites the covered material,
  > ships at `medium` — and records **no gap row at all**. The uncovered clause is
  > silently lost to the gaps subsystem, so nothing ever proposes documenting it. This is
  > the failing `partial-answer-followup-gap` case in `docs/golden-eval.md`; it is not
  > fixable by retuning R16's floor, because the sections such a search returns score
  > *higher* than legitimately-cited sections in passing cases. Fixing it requires
  > replacing the empty-result precondition with a strength-based one — `candidateCount`
  > and per-section `relevance` (R17) are already plumbed for it.

## HTTP endpoints

All three are scope `ask:knowledge`, rate tier `ask`, and enforce flow-scoped
authorization via `assertCan(…, "ask", flow)`. `/retrieve` and `/route` are watcher
callbacks (service-principal carve-out).

- `POST /api/ask` — `{question, flow?, conversationId?}` → 202 `{questionId,
  conversationId, job, links}`.
- `POST /api/retrieve` — `{question, flowId?, limit?≤50}` → `{sections[], retrievalMode,
  candidateCount}`, or 422 `{error: "unknown_flow"}`. `candidateCount` is the pre-floor
  match count (R17).
- `POST /api/route` — `{question≤4000, flows[]≤200}` → `{status: "routed", flowId,
  confidence, margin}` or `{status: "abstain"}`.

See [api.md](./api.md) for the full request/response reference.

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `MIN_RELEVANCE` | 0.4 | `apps/api/src/features/retrieve/service.ts` |
| `RELATIVE_RELEVANCE_FLOOR` | 0.5 | `apps/api/src/features/retrieve/service.ts` |
| retrieve `limit` | 5 | `apps/api/src/features/retrieve/service.ts` |
| `STRICT_MATCH_BOOST` | 1.5 | `apps/api/src/stores/postgres-knowledge-store.ts` |
| `TS_RANK_WEIGHTS` (D, C, B, A) | 0.1, 0.3, 0.6, 1.0 | `apps/api/src/stores/postgres-knowledge-store.ts` |
| `MAX_SEARCH_ROUNDS` | 3 | `apps/watcher/src/runners/generative.ts` |
| `MAX_POOL_SECTIONS` | 15 | `apps/watcher/src/runners/generative.ts` |
| `MAX_PRIOR_TURNS` / `MAX_ANSWER_CHARS` | 6 / 1200 | `apps/api/src/features/ask/service.ts` |
| `FLOW_ROUTER_MIN_SCORE` / `FLOW_ROUTER_MIN_MARGIN` | 0.25 / 0.05 | `apps/api/src/platform/config.ts` |
| `DEFAULT_RRF_K` | 60 | `packages/retrieval/src/rrf.ts` |
| `VECTOR_CANDIDATES` / `KEYWORD_CANDIDATES` | 20 / 20 | `apps/api/src/stores/knowledge-index.ts` |
| `EMBEDDING_DIMENSIONS` | 1536 | `packages/retrieval/src/embeddings.ts` |

## Code map

| Concern | Code |
| --- | --- |
| Ask entry (enqueue) | `apps/api/src/features/ask/{routes,service}.ts` |
| Answer job input | `apps/api/src/platform/answer-question.ts` |
| Agentic loop, grounding, citations | `apps/watcher/src/runners/generative.ts`, `apps/watcher/src/job-prompts.ts` |
| Retrieve callback + relevance floor | `apps/api/src/features/retrieve/{routes,service}.ts` |
| Route callback (embedding-first) | `apps/api/src/features/route/{routes,service}.ts` |
| Hybrid search + RRF fusion | `apps/api/src/stores/knowledge-index.ts`, `apps/api/src/stores/postgres-knowledge-store.ts`, `packages/retrieval/src/rrf.ts` |
| Weighted FTS vector + refresh trigger | `packages/db/migrations/0063_weighted_section_fts.sql` (`document_sections_search_tsv_refresh`, `document_sections_search_tsv_trg`) |
| Gap retrieval-mode stamp + candidacy gate | `packages/db/migrations/0064_gap_retrieval_mode.sql`, `apps/api/src/stores/postgres-question-log-store.ts` |
| Empty-search framing | `apps/watcher/src/job-prompts.ts` (`buildEmptySearchNote`) |
| Flow router (pure) | `packages/retrieval/src/flow-router.ts` |
| Embedding providers | `packages/retrieval/src/embeddings.ts` |
| Index-time background embedding | `apps/api/src/platform/background-embedder.ts`, `apps/api/src/stores/embed-sections.ts` |
| Job contract | `packages/jobs/src/{schemas,catalog}.ts` |

## Tests (behavioural contract)

`apps/api/src/features/ask/service.test.ts`,
`apps/api/src/features/retrieve/{service,routes.flow-scope}.test.ts`,
`apps/api/src/features/route/{service,routes.flow-scope}.test.ts`,
`packages/retrieval/src/{rrf,embeddings,flow-router,routing,index}.test.ts`,
`apps/api/src/stores/{knowledge-index,embed-sections}.test.ts`,
`apps/watcher/src/runners/generative.test.ts`, `apps/watcher/src/job-prompts.test.ts`,
`packages/jobs/src/{schemas,catalog}.test.ts`,
`apps/api/src/platform/config.test.ts`.

## Provenance (design history)

Consolidates, and supersedes as a behavioural description:
`docs/superpowers/specs/2026-07-01-agentic-retrieval-design.md` (agentic loop — matches
current code), `2026-06-13-vector-hybrid-retrieval-design.md` (hybrid substrate; its
`direct`/inline `/ask` mode and queued index-time embedding are **stale**),
`2026-07-04-flow-embedding-router-design.md` (embedding router),
`2026-07-02-answer-search-reliability-design.md`,
`2026-07-04-answer-reconcile-call-tuning-design.md`,
`2026-08-11-keyword-retrieval-quality-design.md` (weighted FTS, OR matching, the two-part
floor, and gap retrieval-mode provenance — implemented; its "an empty keyword result is
not a knowledge gap" goal is only **partly** realised, see the R16 and R19 notes).
