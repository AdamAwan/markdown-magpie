# Embeddings-based flow router (issue #169, Part 3)

**Status:** approved · **Date:** 2026-07-04 · **Issue:** #169 (`token-efficiency`)

Replace the per-question chat completion that only outputs a flow id with a cheap
embedding-similarity comparison, keeping the chat call as a fallback for low-margin
scores. Builds on Parts 1 + 2 (merged in #191).

## Problem

`routeQuestionToFlow` (`packages/retrieval/src/routing.ts`) bills a full chat completion
whose only output is a flow id, on **every** question in deployments with ≥2 configured
flows. It already short-circuits for 0/1 flows and caller-pinned flows.

## Constraint that dictates the architecture

Routing runs today in the **watcher** (`generative.ts:resolveFlow` → `routeQuestionToFlow`
with the watcher's chat provider). But embeddings are inline in the **API**
(`ctx.providers.embedding`); the watcher has no embedding provider and no DB. So the
embedding comparison must run API-side, mirroring how retrieval already works
(watcher → `POST /api/retrieve` → API embeds inline). **Decision: API callback endpoint**,
watcher keeps owning the routed-vs-fallback decision. The chat fallback stays in the
watcher, preserving the queue-only model (no inline chat call in the API).

## Safety property

The fallback *is* today's behaviour. A mis-tuned threshold only makes the router abstain
more often → the watcher does the chat call it would have done anyway. So thresholds can
reduce savings but **never** hurt routing correctness. Thresholds are therefore biased
toward abstaining.

## Components

### 1. `@magpie/retrieval` — pure, deterministic core

- `cosineSimilarity(a: number[], b: number[]): number` — no such helper exists today
  (pgvector owns similarity for section search).
- `routeByEmbeddingSimilarity(questionVector, flows, options)` where each flow carries its
  precomputed vector. Returns
  `{ status: "routed"; flowId; confidence; margin } | { status: "abstain" }`.
  - Picks the top-1 flow by cosine similarity.
  - Routes only when top-1 ≥ `minTopScore` **and** (top-1 − top-2) ≥ `minMargin`.
  - Confidence: `high` when the margin is comfortably above `minMargin`, else `medium`.
  - Never emits `"unknown"` — only the chat router abstains to the user, so
    flow-selection-required behaviour is untouched.

### 2. API — new `features/route/` (mirrors `features/retrieve/`)

- `POST /api/route`, body `{ question: string, flows: [{ id, name, persona? }] }`.
- Service:
  - Flow embedding text = `name` + `routingSummary` + `persona`. The **routing summary**
    (`routingSummary`/`summary` on a flow in `KNOWLEDGE_FLOWS`) is an admin-authored
    description of the flow's *topical scope* — the strongest routing signal, distinct
    from `persona` (answering voice). It is resolved server-side from the current config
    by flow id, not trusted from the request, so routing always reflects live config.
    A flow with only a name is a thin signal that abstains readily to the chat router.
  - Embeds `[question, ...flowTexts]` in **one** `embed()` call. Flow vectors are memoized
    by a content hash (flows are static per API process), so steady state is one embedding
    per distinct flow text ever + one for the question per request.
  - Runs `routeByEmbeddingSimilarity` with env-configured thresholds.
  - No embedding provider configured → responds `{ status: "abstain" }`.
  - Response: `{ status: "routed"; flowId; confidence; margin } | { status: "abstain" }`.
- Thresholds from env (abstain-biased defaults), read once at context/config init:
  - `FLOW_ROUTER_MIN_SCORE` (default conservative floor)
  - `FLOW_ROUTER_MIN_MARGIN` (default conservative margin)

### 3. Watcher

- `http-client.ts`: add `routeByEmbedding(question, flows, signal)` → the `/api/route`
  decision; a transport/parse failure resolves to `abstain` (never fails the ask).
- `generative.ts:resolveFlow`: for ≥2 unpinned flows, call `routeByEmbedding` first. On
  `routed`, use it (traced `method: "embedding"`). On `abstain`/error, fall back to the
  existing `routeQuestionToFlow` chat call (traced `method: "chat"`). Pinned flows and the
  0/1-flow short-circuits are unchanged.

### 4. `core`

- Extend `AnswerTrace.routing` with an optional `method: "embedding" | "chat"` (pure
  observability — the console can show which router decided). Absent for
  requested/unscoped/unknown modes.

## Testing

- `packages/retrieval` — `routeByEmbeddingSimilarity` / `cosineSimilarity` unit tests with
  hand-built vectors: a clear winner routes; a near-tie abstains; below-floor abstains;
  confidence mapping.
- `apps/api` — route service: one `embed()` call for question + flows; flow-vector
  memoization across calls; no-provider → abstain; a clear winner → routed.
- `apps/watcher` — `chat.test.ts`: embedding-routed happy path (no chat routing call made,
  retrieval scoped to the routed flow, trace `method: "embedding"`); abstain → chat
  fallback still routes (trace `method: "chat"`); embedding-router error → chat fallback.
- Prompt catalog unchanged (no new prompt; `ROUTE_QUESTION_TO_FLOW` still backs the
  fallback).

## Docs

- `docs/question-logging.md` and `docs/ai-jobs.md` — routing description (embedding-first,
  chat fallback).
- `docs/architecture.md` — the routing step (`generative.ts` / `/api/route`).
- `docs/chat-providers.md` / env reference — the two new `FLOW_ROUTER_*` vars.

## Validation

`npm run build`, `npm run typecheck`, `npm run lint`, and
`npm test -w packages/retrieval -w apps/api -w apps/watcher -w packages/prompts`, run per
component. Committed and pushed incrementally.

## Out of scope

Parts 1 + 2 (already merged). Re-embedding-based *retrieval* changes. Persisting flow
embeddings across process restarts (in-process memoization only).
