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

- **R14** — Retrieval is **hybrid**: keyword ranking (Postgres full-text search via
  `websearch_to_tsquery`/`ts_rank`, or an in-memory scorer when FTS is unavailable) and
  vector ranking (pgvector cosine, `1 - (embedding <=> query)`), each over-fetching
  `20` candidates, are fused with **Reciprocal Rank Fusion** (`score += 1 / (k + rank)`,
  `k = 60`). RRF is rank-based and needs no score normalisation.
- **R15** — Each returned section's `relevance` is `max(cosineSimilarity,
  keywordRelevance)` — **not** the fused RRF score, which is used only for ordering.
- **R16** — The API applies a **relevance floor** `MIN_RELEVANCE = 0.15` in `retrieve()`:
  sections below it are dropped, and an empty result is treated as a knowledge gap
  rather than a weak answer. Default retrieve `limit` is `5`.
- **R17** — With no embedding provider (or on a vector-search error) retrieval MUST
  degrade to keyword-only top-K rather than failing the request.

## Citations

- **R18** — Citations MUST be derived in code from the retrieved sections and never
  trusted from the model. The model names *used* section ids (`usedSectionIds`); code
  narrows the retrieved pool to those and sorts strongest-first by relevance.
- **R19** — If the model names no valid ids, citations fall back to the whole retrieved
  pool. If it names **only** ids that were never retrieved, `attributionFailed` is set
  and the answer is downgraded to `low` confidence.

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

## HTTP endpoints

All three are scope `ask:knowledge`, rate tier `ask`, and enforce flow-scoped
authorization via `assertCan(…, "ask", flow)`. `/retrieve` and `/route` are watcher
callbacks (service-principal carve-out).

- `POST /api/ask` — `{question, flow?, conversationId?}` → 202 `{questionId,
  conversationId, job, links}`.
- `POST /api/retrieve` — `{question, flowId?, limit?≤50}` → `{sections[]}`, or 422
  `{error: "unknown_flow"}`.
- `POST /api/route` — `{question≤4000, flows[]≤200}` → `{status: "routed", flowId,
  confidence, margin}` or `{status: "abstain"}`.

See [api.md](./api.md) for the full request/response reference.

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `MIN_RELEVANCE` | 0.15 | `apps/api/src/features/retrieve/service.ts` |
| retrieve `limit` | 5 | `apps/api/src/features/retrieve/service.ts` |
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
`2026-07-04-answer-reconcile-call-tuning-design.md`.
