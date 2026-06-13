# Vector + Hybrid Retrieval — Design

- **Date:** 2026-06-13
- **Branch:** `worktree-vector-hybrid-retrieval`
- **Status:** Approved design, pre-implementation

## Problem

The product's primary job is to be a fast source of *accurate* answers from Markdown. The
`/ask` Q&A flow (both `direct` and `queue` execution modes) retrieves through a single entry
point, `knowledgeIndex.search()` (`apps/api/src/knowledge-index.ts:181`), which today is **pure
in-memory keyword scoring** (heading match +3, content match +1). The LLM only ever sees the
≤3 sections that survive that lexical filter (`packages/retrieval/src/index.ts:128`).

Retrieval recall is therefore the ceiling on answer accuracy. Keyword scoring misses
paraphrases, synonyms, and conceptual queries: a question phrased in the user's words often
shares no tokens with the section that answers it, so that section scores 0 and never reaches
the model — no matter how capable the model is.

## Goal

Add semantic (vector) retrieval to the `/ask` flow, **fused** with the existing keyword scorer
(hybrid search using Reciprocal Rank Fusion), backed by **pgvector**. Embeddings are produced by
an admin-configured embeddings endpoint. Hybrid retrieval activates automatically when both a
Postgres knowledge store and an embeddings endpoint are configured; otherwise the system stays
on today's keyword-only search. No behavioural regression for existing deployments.

### Non-goals (YAGNI)

- Cross-encoder / LLM re-ranking of results.
- Configurable or multiple embedding dimensions running simultaneously (fixed at 1536).
- Changes to chunking (heading-based `DocumentSection`s are kept as-is).
- Per-file incremental re-embedding beyond targeting `NULL` embeddings.
- A separate retrieval path for the admin search endpoint — it shares `search()` and inherits
  hybrid for free.

## Key decisions (resolved during brainstorming)

1. **Search engine:** pgvector in Postgres for the vector side. This makes `KNOWLEDGE_STORE=postgres`
   a requirement for the *upgraded* retrieval; in-memory keyword scoring remains the no-DB fallback.
2. **Embedding source:** an OpenAI-compatible `/embeddings` endpoint or an Azure embedding
   deployment, configured by the admin via the same env-detection pattern as the chat providers.
   A CLI agent (Claude/Codex) **cannot** be an embedding source — it produces text, not vectors.
3. **Index-time embedding:** queued to the watcher as a background job (the API stays responsive;
   sections are keyword-searchable immediately and vector search warms up as embeddings land).
4. **Query-time embedding:** synchronous in the API — retrieval runs inline in `/ask`
   (`apps/api/src/main.ts:408`) before any job is enqueued, so the question must be embedded on
   the spot to run the pgvector query.
5. **Merge strategy (Approach B):** vector ranking from pgvector + keyword ranking from the
   existing in-memory scorer (already loaded by `hydrate()`), fused with RRF in TypeScript. Only
   the ANN lookup hits Postgres; the keyword scorer and the fusion logic stay unit-testable
   without a database.

## Two independent concerns: answering vs embedding

"AI provider" currently bundles one job (answering). This feature splits out a second,
independent job (embedding). They are configured separately and need not share a vendor.

| Provider family            | Can answer | Can embed                         |
| -------------------------- | ---------- | --------------------------------- |
| mock                       | yes        | yes (fake; keeps system keyword-only) |
| openai-compatible / azure  | yes        | **yes — the embedding source**    |
| codex / claude CLI         | yes        | **no — cannot produce vectors**   |

A Claude-CLI deployment can still get hybrid search by *additionally* configuring an embeddings
endpoint; the question is embedded there while the answer is still written by Claude. With no
embeddings endpoint available, the system stays on keyword-only retrieval (today's behaviour).

## Architecture

### Component 1 — Embedding providers (`packages/retrieval`)

Mirror the existing chat-provider structure:

- `OpenAICompatibleEmbeddingProvider` — `POST {baseUrl}/embeddings` with `{ model, input: texts }`,
  returns `data[].embedding`.
- `AzureOpenAIEmbeddingProvider` — `POST {endpoint}/openai/deployments/{deployment}/embeddings?api-version=…`.
- `createEmbeddingProvider(config)` factory, analogous to `createChatProvider`.
- `MockEmbeddingProvider` is retained for the no-config path.

**Config** reuses existing variables plus one new one:

- OpenAI-compatible: `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`,
  `OPENAI_COMPATIBLE_EMBEDDING_MODEL` *(new)*.
- Azure: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`
  *(already surfaced at `apps/api/src/main.ts:650`)*, `AZURE_OPENAI_API_VERSION`.

**Dimension guard:** the `document_sections.embedding` column is `vector(1536)`
(`packages/db/migrations/0001_initial.sql:37`), matching `text-embedding-3-small` / `ada-002`. The
provider validates that returned vectors have length 1536 and **fails fast** otherwise, rather than
writing a corrupt index. Changing the dimension is a future migration, out of scope.

### Component 2 — Migration `0006_hybrid_retrieval.sql`

Add an HNSW index for fast nearest-neighbour search:

```sql
CREATE INDEX document_sections_embedding_hnsw
  ON document_sections USING hnsw (embedding vector_cosine_ops);
```

No `tsvector` column is required: keyword ranking stays in memory under Approach B, so the
migration is intentionally minimal.

### Component 3 — Index-time embedding

> **REVISED during implementation (Option A):** The original design queued embedding to the
> watcher. On inspection the watcher is a thin HTTP job-queue client with no DB or embedding
> capability, and section-embedding is already triggered by the index event in the API. So
> index-time embedding now runs **in the API as a background task** kicked off after the index
> request returns (`embedSectionsInBackground`, idempotent, drains all `embedding IS NULL`
> sections, concurrent triggers coalesce). There is no `embed_sections` job type and no watcher
> change. The pure `embedPendingSections` batch function and the `EmbeddingPersistence` helpers
> below remain exactly as described — only the caller changed (API background task, not a watcher
> runner). The text struck through below is retained for history.

~~Queued to the watcher as a background job:~~

- New `AiJobType` `"embed_sections"` with input/output types in `packages/core`.
- After a successful index, the API enqueues an `embed_sections` job **only when** running with
  `KNOWLEDGE_STORE=postgres` and an embeddings endpoint configured.
- A new `EmbedSectionsRunner` in `apps/watcher`:
  - Selects `document_sections WHERE embedding IS NULL` in configurable batches.
  - Embeds `heading + "\n" + content` per section via the configured embedding provider.
  - `UPDATE`s the `embedding` column.
- The watcher gains a direct `PostgresKnowledgeStore` dependency (it already connects to Postgres
  for the job queue) and constructs an embedding provider from the same env detection.
- **Idempotent & self-healing:** targeting only `NULL` embeddings makes retries and partial
  failures safe. Re-indexing a changed document re-inserts its sections with `NULL` embeddings
  (`apps/api/src/postgres-knowledge-store.ts:75`), so they are automatically re-embedded by the
  next job. The API's in-memory index does not need embeddings — vectors are queried from Postgres
  at query time — so no re-hydrate is required when embeddings land.

### Component 4 — Query-time retrieval (hybrid)

When hybrid is active, `search(question, limit)`:

1. Embeds the question synchronously (in the API).
2. Runs a pgvector ANN query → top-K nearest sections + cosine similarity
   (`ORDER BY embedding <=> $1 LIMIT K`, K ≈ 20).
3. Runs the existing in-memory keyword scorer → top-K.
4. **Fuses** the two ranked lists with Reciprocal Rank Fusion (`score = Σ 1 / (60 + rank)`),
   returning the top `limit`.

**Fallbacks** (no behavioural change for existing deployments):

- No embeddings endpoint or `KNOWLEDGE_STORE != postgres` → keyword-only search.
- Query-embedding call fails, or pgvector is configured but unavailable → keyword-only for that
  query, plus a surfaced runtime notice (consistent with commit `b898ba5`). `/ask` never fails
  because of an embedding/vector error.

### Component 5 — `SectionSearchProvider` returns scored results

Today `answerQuestion` re-tokenizes and re-scores results by keyword
(`packages/retrieval/src/index.ts:189`), and `selectRelevantSections` drops anything with keyword
score < 2 (`:200`). That would **discard vector-only hits** — semantically relevant sections with
no shared tokens — which are the entire point of this work. The fused relevance must therefore
flow through to selection.

- `SectionSearchProvider.search` changes from returning `DocumentSection[]` to returning ranked
  sections each carrying a **normalized relevance in `[0,1]`**, descending.
- `selectRelevantSections` and `confidenceForEvidence` keep their *shape* — a relevance floor, a
  relative band relative to the best hit, a cap of 3 sections, and confidence derived from the best
  relevance plus the number of supporting sections — but operate on the `[0,1]` scale instead of
  raw keyword counts.
- **Primary implementation risk:** recalibrating the threshold constants from the integer
  keyword-count scale to the `[0,1]` relevance scale. *Mitigation:* the existing retrieval tests
  pin keyword-only behaviour and act as a guardrail; new tests cover the hybrid path. The exact
  constants are an implementation detail validated by tests; this design fixes only the shape.

### Component 6 — Configuration & admin UI (clarity is a requirement)

Users think in terms of one "AI provider"; this feature introduces a second, independent concern.
The configuration must make that obvious and must make it impossible to mis-configure.

- **Two clearly separated, labelled settings:** "Answering" and "Embeddings (for semantic
  search)". Embeddings is *not* merged into the answer-provider selector.
- **The embeddings selector only offers api-style endpoints** (OpenAI-compatible / Azure). The
  codex/claude CLI providers never appear there, so a non-embedding provider cannot be selected
  for embeddings.
- **A plain-language, read-only status line** driven by a derived `retrievalMode`
  (`"hybrid" | "keyword"`), exposed via `/config`:
  - *"Retrieval: Hybrid (semantic + keyword)"* — embeddings endpoint + Postgres store both live.
  - *"Retrieval: Keyword only — add an embeddings endpoint to enable semantic search"* — no
    embeddings endpoint configured.
  - *"Retrieval: Keyword only — semantic search requires the Postgres knowledge store"* —
    embeddings configured but `KNOWLEDGE_STORE` is not Postgres.
- **No write-toggle for retrieval mode** — it is derived from what is configured, so the displayed
  mode can never contradict the actual behaviour.
- `/config` additions: `providers.openAiCompatible.embeddingModel` (new), the existing Azure
  embedding deployment, and the derived `retrievalMode` with its explanatory reason. The web UI
  (`apps/web/src/app/page.tsx`) gains a small, read-only retrieval-status indicator.

## Data flow

**Index:** `POST /repositories/index` → persist sections (`embedding NULL`) → enqueue
`embed_sections` (if Postgres + embeddings) → watcher embeds in batches → embeddings populated.

**Ask:** `POST /ask` → embed question (sync) → pgvector ANN (top-K) + in-memory keyword (top-K) →
RRF fuse → select ≤3 → LLM (direct) or enqueue `answer_question` (queue) → answer + citations +
confidence.

## Files touched

| File | Change |
| ---- | ------ |
| `packages/core/src/index.ts` | `embed_sections` job input/output types; ranked-section type for the search contract. |
| `packages/retrieval/src/index.ts` | Real embedding providers + factory; `SectionSearchProvider` returns scored results; RRF fusion; relevance-scale selection/confidence. |
| `packages/db/migrations/0006_hybrid_retrieval.sql` | HNSW index on `embedding`. |
| `apps/api/src/postgres-knowledge-store.ts` | pgvector nearest-neighbour query; fetch-NULL-embedding + update-embedding methods. |
| `apps/api/src/knowledge-index.ts` | Hybrid search wiring + keyword fallback; embedding-provider injection. |
| `apps/api/src/main.ts` | Construct embedding provider; enqueue `embed_sections` after index; expose `retrievalMode` + embedding status in `/config`. |
| `apps/watcher/src/main.ts` | `EmbedSectionsRunner`. |
| `apps/web/src/app/page.tsx` | Read-only retrieval-status indicator. |
| `docs/` (e.g. `ingestion.md`) | Update the note about keyword-only scoring "until the embedding adapter is wired in". |

## Testing strategy

- **RRF fusion** — pure-function, table-driven unit tests (no DB).
- **Embedding providers** — mocked `fetch`: request shape, response parsing, dimension validation.
- **`answerQuestion` hybrid** — a vector-only hit with zero keyword overlap survives selection;
  confidence mapping on the `[0,1]` scale; keyword-fallback behaviour preserved.
- **`EmbedSectionsRunner`** — fake embedding provider + fake DB client: NULL-targeting, batching,
  idempotency.
- **pgvector ANN** — optional integration test gated on `DATABASE_URL`; keep the SQL in a
  testable function so ordering can be asserted.

## Configuration summary

| Variable | Purpose |
| -------- | ------- |
| `KNOWLEDGE_STORE=postgres` + `DATABASE_URL` | Required for vector search (existing vars). |
| `OPENAI_COMPATIBLE_BASE_URL` / `_API_KEY` / `_EMBEDDING_MODEL` | OpenAI-compatible embeddings (`_EMBEDDING_MODEL` is new). |
| `AZURE_OPENAI_ENDPOINT` / `_API_KEY` / `_EMBEDDING_DEPLOYMENT` / `_API_VERSION` | Azure embeddings. |
| (derived) `retrievalMode` | `hybrid` when Postgres + embeddings configured, else `keyword`. |
