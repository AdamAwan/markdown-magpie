# Answer search reliability: forced gap-search + robust JSON

Follow-up to [the agentic retrieval design](2026-07-01-agentic-retrieval-design.md).
That work gave `answer()` a bounded assess → (search)\* → answer loop. In practice
two failure modes surfaced that made the loop look like it "never searches."

## Problem

Both were observed on the `openai-compatible` provider via the per-question answer
trace (`AnswerTrace`).

1. **The model decides whether to search, and often gives up instead.** The loop
   only ran a follow-up search when the model chose `action:"search"`. A weak model
   frequently skips straight to a low-confidence / `isKnowledgeGap` answer on the
   very first round — precisely the case where searching would help most — and the
   loop honoured it and returned. Whether the loop searched was left entirely to the
   model's discretion, so the same model searched for "find as much as you can about
   X" but not for "what certifications does Magpie have?" (where it had a teasing
   SOC 2 mention but no confirmation, and should have searched before conceding).

2. **A hand-written JSON reply with an unescaped quote corrupts the answer.** The
   model emits its `{ "action": ..., ... }` envelope as hand-written JSON. When the
   answer string embeds an unescaped `"` (e.g. quoting a source document), the whole
   envelope is invalid JSON. `extractJson` then fails, which:
   - made `parseAssessment` fall back to `action:"answer"` (so even a would-be
     search couldn't run), and
   - made `buildAnswerOutput` ship the **raw `{"action":"answer",...}` envelope** to
     the reader as the answer text, at a forced `low` confidence
     (`answerContract:"unstructured"`).

## Decisions

### 1. Force one gap-derived search before accepting a give-up answer

In the loop, when the model returns `action:"answer"` while **no search has run yet**
(`searches.length === 0`) and the answer is low-confidence / a knowledge gap, do not
accept it. Instead force one search round seeded from the model's **own declared
gaps**, then re-assess with the enlarged pool.

- `forcedSearchQueries(content, max = 3)` (in `job-prompts.ts`) parses the structured
  answer and returns up to `max` gap summaries as queries — but only when the answer
  gave up (`isKnowledgeGap` or `confidence === "low"`), is not `outOfScope`, and
  actually named gaps. It returns `[]` otherwise, including for an unparseable reply.
- The guard is gated on `searches.length === 0`, so it fires **at most once**: after
  the forced round a search has run, so the next give-up answer is accepted and the
  loop still converges within `MAX_SEARCH_ROUNDS` / `MAX_POOL_SECTIONS`.
- It reuses the model's own gap analysis — **no extra model call**, just retrievals.

This turns "the model *may* search" into "the model *will* search before it is allowed
to give up," without removing its ability to answer directly when it is confident.

### 2. Nudge the prompt to prefer searching over settling

`ANSWER_QUESTION` now tells the model to prefer searching to answering whenever the
current context does not already, on its own, fully and specifically answer the
question — and to report a gap only once a search for it has come back empty. This
makes the guard the fallback, not the norm. The existing anti-fabrication contract is
unchanged. The nudge is toward *gathering more*, never toward *saying more* from thin
context.

### 3. Request valid JSON from API-backed providers

`ChatRequest` gains `responseFormat?: "json"`. The OpenAI-compatible and Azure
providers map it to `response_format: { type: "json_object" }`, so the model returns
syntactically valid JSON and the unescaped-quote class of failures disappears at the
source. It is set on the `answer_question` flow's model calls: `assess`, the grounding
`verify`, and `routeQuestionToFlow`. CLI providers (`codex`, `claude`) cannot enforce
it and rely on the prompt, which already demands JSON, exactly as before. Every prompt
these calls use already instructs "Return JSON," which `json_object` mode requires.

### 4. Never surface a broken JSON envelope

`buildAnswerOutput` no longer echoes an unparsed reply that opened as a JSON object.
When `parseStructuredAnswer` fails and the raw content starts with `{`, it was a broken
structured attempt, so a safe `UNPARSEABLE_ANSWER_FALLBACK` message ships at low
confidence instead of the raw envelope. Genuine prose (does not start with `{`) is still
kept verbatim, preserving the prior "keep an off-contract plain-prose answer at low
confidence" behaviour.

## Changes by layer

- `@magpie/core`: `ChatRequest` gains `responseFormat?: "json"`.
- `@magpie/retrieval`: both API providers honour `responseFormat` via
  `response_format`; `routeQuestionToFlow` requests JSON.
- `@magpie/prompts`: `ANSWER_QUESTION` gains the search-first nudge.
- `apps/watcher`: `forcedSearchQueries` helper + `UNPARSEABLE_ANSWER_FALLBACK` and the
  broken-envelope guard in `job-prompts.ts`; the round-0 forced-search guard and the
  `assess`/`verify` JSON requests in `generative.ts`.

## Testing

- `job-prompts` unit: `forcedSearchQueries` returns gaps when the model gives up low,
  caps to `max`, and returns `[]` for confident / off-topic / no-gap / unparseable
  replies; `buildAnswerOutput` replaces a broken JSON envelope with the fallback and
  keeps plain prose.
- watcher `chat.test.ts`: a model that only ever answers low on round 0 still triggers
  a gap-derived search recorded in the trace; the verify-skip test asserts "no verify
  call" directly rather than counting model calls (the guard legitimately adds one).
- `catalog.test.ts`: the search-first nudge is asserted so it cannot silently regress.

## Out of scope (YAGNI)

- JSON mode for the maintenance / reconcile flows — this change targets the
  `answer_question` path. Extending it is a mechanical follow-up.
- Salvaging the answer text from a malformed envelope (a JSON-repair pass) — JSON mode
  removes the need; the fallback is the safety net for CLI providers.
- No new round/pool caps or a configurable forced-query count beyond `max = 3`.
