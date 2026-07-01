# Agentic retrieval with grounded citations

## Problem

Citations are weak, and the same weakness makes answers shallow:

1. **Citations are "the top 5 search hits," not references the answer actually
   used.** `buildAnswerOutput` does `sections.map(toCitation)` — every retrieved
   section becomes a citation regardless of whether the answer draws on it
   (`apps/watcher/src/job-prompts.ts`). The model's output contract
   (`ANSWER_QUESTION`) is only `{ answer, confidence, isKnowledgeGap, gaps }`; it
   is never asked which sections it used.
2. **There is no relevance floor.** `knowledgeIndex.search` returns the top-K by
   fused rank with no minimum score, and vector search always returns nearest
   neighbours — so even a nonsense question yields exactly 5 citations. The search
   *computes* a `relevance` per section (`RankedSection.relevance`, already in
   `[0,1]`), but `retrieve()` discards it: `RetrievedSection` doesn't carry it, so
   nothing downstream can gate weak matches.
3. **Retrieval is a single fixed grab.** `answer()` calls `api.retrieve` exactly
   once with the raw question at `limit = 5`. The model cannot pull in a *related*
   thing it judges necessary for a complete answer (e.g. answering "how do I
   deploy?" without also surfacing the required env setup).
4. **Gaps only fire on whole-question failure.** `buildAnswerOutput` emits gap
   signals solely in the `isKnowledgeGap || sections.length === 0` branch — i.e.
   when the question went essentially unanswered. A confidently-answered question
   that nonetheless *lacked supporting material* (the model wanted to show an
   example of X, searched for it, and found nothing) raises no gap, even though
   that is one of the most actionable gap signals the system could produce.

We want the watcher to **drive its own retrieval**: assess what it has, run
follow-up searches when an answer would be incomplete, and cite only what it
actually used — while keeping attribution server-sourced and the cost bounded.

## Current pipeline (for reference)

- `POST /api/ask` → API records a `QuestionLog`, enqueues `answer_question`
  carrying all flows → `202` + job links.
- Watcher `answer()` (`apps/watcher/src/runners/generative.ts`):
  `routeQuestionToFlow` → `api.retrieve(question, flowId, undefined)` (top 5) →
  one `model.complete` → `buildAnswerOutput(content, sections, question, flowId)`.
- `/api/retrieve` (`apps/api/src/features/retrieve/service.ts`) resolves the
  flow's repository scope and returns `knowledgeIndex.search(question, limit ?? 5,
  scope)` mapped to `RetrievedSection[]` (**relevance dropped here**).
- `buildAnswerOutput` maps every section to a `Citation` and, on
  `isKnowledgeGap` or zero sections, emits gap signals at low confidence.

## Decisions

### 1. Relevance flows end-to-end, and gates citations (land this first)

`retrieve()` is variable-cost bait for junk once the loop exists, so thread the
score through and floor on it before anything else.

- `RetrievedSection` gains `relevance: number` (`[0,1]`); `retrieve()` populates
  it from `RankedSection.relevance` instead of discarding it.
- `retrieve()` drops sections below `MIN_RELEVANCE` (start at `0.15`, a
  conservative floor tuned to remove clear non-matches, not borderline ones)
  **after** fusion/scoping. A question with no section above the floor returns an
  empty list → the existing `sections.length === 0` branch already produces a
  knowledge-gap answer with **zero** citations. This alone kills "5 citations for
  a bogus question."
- `Citation` gains `relevance: number` so the UI can show/sort by it.

### 2. `answer()` becomes a bounded agentic loop

Replace the single retrieve→answer with **assess → (search)\* → answer**:

1. **Seed** the pool with `api.retrieve(question, flowId, limit)`, deduped by
   `sectionId`.
2. **Assess** — the model sees the question + current context and returns one of:
   - `{ action: "search", queries: string[], rationale: string }` — needs more
     before it can answer well (including *related* info the user will need).
   - `{ action: "answer", answer, confidence, isKnowledgeGap, gaps, usedSectionIds }`.
3. On `search`, run each query via `api.retrieve(query, flowId, limit, signal)`,
   merge **new** sections into the pool (dedupe by `sectionId`), loop to step 2.
4. **Terminate** on `action: "answer"`, or when a guard trips — then force one
   final answer call from the accumulated pool.

**Scope:** follow-up searches reuse the **routed `flowId`** — same repository
scope as the original question. Related material only surfaces if it lives in the
question's knowledge area. (Cross-flow retrieval is explicitly out of scope; it
would mix audiences/domains and cite outside the question's area.)

**Guards (this is now variable-cost work):**
- `MAX_SEARCH_ROUNDS = 3` assess→search iterations; the 4th assess must answer.
- `MAX_POOL_SECTIONS = 15` — once reached, stop searching and force an answer.
- Dedupe by `sectionId` so repeated queries don't inflate the pool or cost.
- Thread the job's `AbortSignal` into `api.retrieve` (it currently takes none) so
  a long loop is cancellable; keep the 300s job heartbeat in mind — bound rounds
  low enough that a job can't stall past its expiry.

### 3. Citations are grounded to what the answer used

- The final `action: "answer"` returns `usedSectionIds`. `buildAnswerOutput`
  cites **only** those ids, **intersected with the retrieved pool** — an id the
  model invents but that was never retrieved is dropped. Sections still come from
  the API index, so the "never trust citations from the model" invariant holds;
  the model only *selects among* server-sourced sections.
- If `usedSectionIds` is empty/absent while a substantive answer was given, fall
  back to citing the pool (ordered by relevance) so we never strip attribution
  from a real answer.
- Gap/zero-section branch is unchanged except it now naturally has an empty pool
  when everything fell below the relevance floor.

### 4. Unsatisfied follow-up searches raise grounded `followup` gaps

The agentic loop already knows something the current pipeline never captures:
**which searches the model itself decided were worth running, and which of those
came back empty.** That is a precise, self-motivated gap — "to answer this well I
wanted an example of X, and the KB has none."

- The watcher tracks **unsatisfied searches**: any `search` query whose retrieval
  returned zero sections above the relevance floor (nothing merged into the pool).
- On the final `action: "answer"`, the model may emit `followupGaps: string[]` —
  human summaries of missing supporting material — **independently of
  `isKnowledgeGap`**. So a `high`-confidence, well-cited answer can still carry
  gaps. This decouples gap emission from "the question failed."
- **Grounding (mirrors citation grounding):** a `followupGap` is only kept if it
  corresponds to a search the watcher actually ran and saw come back empty. The
  model writes the prose; the watcher vouches that the underlying search was real
  and unsatisfied. A gap with no matching empty search is dropped, so the model
  can't invent gaps for material that does exist (or was never looked for).
- Each kept gap becomes a `KnowledgeGapSignal` with **`source: "followup"`**,
  `confidence` = the answer's confidence, and `citedSectionIds` = the sections the
  answer *did* use (the surrounding context the missing piece belongs with). It
  then flows through the existing gap → cluster → draft → PR pipeline unchanged.

Rationale for a distinct source: these gaps are qualitatively different from
whole-question misses — they come *from* a good answer and point at a specific
missing artifact — so the console and gap analytics should be able to surface and
filter them separately. The clustering/reconciler pipeline treats all sources
alike; only the label differs.

## Changes by layer

### `packages/db` (new migration `0035_followup_gap_source.sql`)
- Widen the `question_gaps.source` CHECK constraint from `('auto','manual')` to
  `('auto','manual','followup')`. Additive; no backfill (existing rows keep their
  source).

### `@magpie/core` (`packages/core/src/index.ts`)
- `Citation`: add `relevance: number`.
- `QuestionGapSource`: add `"followup"` → `"auto" | "manual" | "followup"`.
- `KnowledgeGapSignal`: add `source: QuestionGapSource` (default `"auto"` at the
  existing call sites) so the watcher can label a signal as `followup` and the
  persistence path can honour it instead of hard-coding `"auto"`.

### `@magpie/jobs` (`packages/jobs/src/schemas.ts`)
- `citationSchema`: add `relevance: z.number()`.
- `gapSchema`: add `source` (`z.enum(["auto","manual","followup"])`) so the
  `answer_question` output can carry a per-gap source. The output *shape* is
  otherwise unchanged (`{ answer, confidence, citations, gaps?, flowId?,
  flowSelectionRequired? }`); the agentic protocol stays internal to the watcher.

### `@magpie/prompts` (`packages/prompts/src/catalog.ts`)
- `ANSWER_QUESTION`: extend to the two-action protocol. Instruct the model to
  emit `{ action: "search", queries, rationale }` when the context is insufficient
  **or** when a complete, genuinely helpful answer needs closely related
  information the user will require; otherwise `{ action: "answer", answer,
  confidence, isKnowledgeGap, gaps, followupGaps, usedSectionIds }` citing only
  the sections it relied on. Define `followupGaps` as "supporting material you
  looked for (e.g. a concrete example of X) but the context does not contain,"
  emitted **even for a confident answer**, and kept only when it matches a search
  that actually came back empty. Update `outputShape`. Keep the "answer only from
  provided context" rule.

### `@magpie/retrieval`
- No routing change. If a shared assess/parse helper is warranted, add it here
  next to `routeQuestionToFlow`; otherwise keep parsing in the watcher.

### `apps/api`
- `features/retrieve/service.ts`: `RetrievedSection` gains `relevance`; populate
  from `RankedSection.relevance`. Apply the `MIN_RELEVANCE` floor after search.
  (Consider a per-request floor later; hard-code the constant for now — YAGNI.)
- Gap persistence (`stores/postgres-question-log-store.ts` +
  `stores/question-log-store.ts`, and the job-completion path that records answer
  gaps): honour each `KnowledgeGapSignal.source` instead of hard-coding `"auto"`
  when writing `question_gaps`. `followup` gaps are written with that source.

### `apps/watcher` (`src/http-client.ts`, `src/runners/generative.ts`, `src/job-prompts.ts`)
- `WatcherApi.retrieve`: add an `AbortSignal` param; thread it through the POST.
- `RetrievedSection` (client mirror): add `relevance`.
- `generative.ts` `answer()`: implement the assess→search→answer loop with the
  guards above; parse the two-action JSON (tolerant extraction like the existing
  `extractJson`); accumulate the deduped pool. Track an **unsatisfied-search set**
  — the queries whose retrieval added zero sections to the pool — and pass it into
  the output builder for grounding the `followup` gaps.
- `job-prompts.ts`: `toCitation` carries `relevance`; `buildAnswerOutput` accepts
  `usedSectionIds` (cites the grounded subset with the empty-fallback rule),
  `followupGaps`, and the unsatisfied-search set. It keeps each `followupGap` only
  when a corresponding empty search was actually observed, emits them as
  `KnowledgeGapSignal`s with `source: "followup"` (answer's confidence,
  `citedSectionIds` = used sections), and merges them with any whole-question
  (`auto`) gaps from the existing gap branch. Add a `parseAssessment` helper.

### `apps/web` (`components/common.tsx`, `AskPanel.tsx`)
- `CitationRow`: show relevance (e.g. a subtle percentage/'·' meter) and keep the
  excerpt. Citations arrive pre-filtered, so the count now reflects what the
  answer used, not a fixed 5.

## Testing

- `retrieve` service: relevance populated; sections below floor dropped; all-weak
  question → empty list.
- watcher `chat.test.ts` / generative:
  - single round: `action: "answer"` with `usedSectionIds` → cites only that
    subset; invented id dropped; empty `usedSectionIds` + real answer → pool
    fallback.
  - multi-round: `action: "search"` triggers a second `api.retrieve` with the
    model's query and the **routed flow id**; pool dedupes by `sectionId`.
  - guards: stops at `MAX_SEARCH_ROUNDS`; stops at `MAX_POOL_SECTIONS`; abort
    signal passed to every `retrieve`.
- `job-prompts` unit: `buildAnswerOutput` citation grounding + fallback + gap
  branch; **`followupGaps`**: a confident answer with an unsatisfied search →
  `followup` gap emitted; a `followupGap` with no matching empty search → dropped;
  `followup` gaps merge alongside `auto` gaps.
- gap persistence: a `followup`-sourced signal writes `source = 'followup'` to
  `question_gaps` (Postgres store test).
- migration: `0035` widens the CHECK; a `followup` insert succeeds.
- web: `CitationRow` renders relevance; variable citation count.

## Out of scope (YAGNI)

- **Cross-flow retrieval** — searches stay within the routed flow.
- No per-request tunable relevance floor or configurable round/pool caps —
  constants for now.
- No re-ranking model or query-rewrite model beyond the assess step's own queries.
- No change to the `answer_question` job *state* or the overall output *shape* —
  the agentic loop is internal to the watcher run; only `gapSchema` gains `source`
  and `citationSchema` gains `relevance`.
- No inline `[n]` markers tying individual sentences to sources (grounded
  citation *set* only; sentence-level anchoring is a later step).
- `followup` gaps get no bespoke clustering/reconciler handling — they flow
  through the existing gap → cluster → draft → PR pipeline; only the source label
  and (later) console filtering distinguish them.
