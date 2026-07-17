# Questionnaire trust — reconciliation reuse + show-don't-suppress — design

**Date:** 2026-07-17
**Status:** Proposed
**Builds on:** [Questionnaire mode](2026-07-16-questionnaire-mode-design.md)

## Problem

Live testing of the questionnaire feature (four `magpie-sales` runs, QA #1–#4) surfaced two
behaviours that make the worksheet hard to trust:

1. **Good answers are silently suppressed.** An item is marked `unanswerable` whenever the
   answer comes back `low`/`unknown` confidence *or* with zero citations
   ([service.ts:151](../../../apps/api/src/features/questionnaires/service.ts)), and the
   export blanks it to *"No answer available."*
   ([export.ts:13](../../../apps/api/src/features/questionnaires/export.ts)). In QA #3/#4,
   items that retrieved the correct sections and produced a correct, well-formed answer
   were blanked purely because the model self-reported `low` confidence — the tool looked
   *less* capable than it was, and hid usable content a reviewer could have accepted.

2. **Reuse is brittle and never visibly fires.** The reuse check
   ([reuse-check.ts](../../../apps/api/src/features/questionnaires/reuse-check.ts)) is a
   hard veto: any cited section byte-changed, or any top-k hit newer than the prior answer,
   rejects reuse and forces a full fresh re-answer. In QA #4 a re-index bumped
   `content_changed_at` on 109 of ~158 sections, so every match against a pre-index baseline
   was rejected as `new_content` — zero reuse, despite the answers still being correct.
   Compounding it, `matchApproved` returns only the *single* most-similar approved item, so
   a stale older questionnaire (QA #1) shadows a fresher equivalent (QA #2) that would have
   reused cleanly.

## Goal

Make the worksheet trustworthy on two axes: **never hide a usable answer, and never silently
trust (or silently discard) a reusable one.** Every item shows its answer (if one exists), a
confidence signal, and its provenance. Reuse loosens from a deterministic veto to a
deterministic *fast-path* plus a grounded LLM **reconciliation** step that decides — against
the current KB — whether to reuse, adapt, merge, or answer fresh.

## Core principle (unchanged, extended)

The questionnaire's memory is still its own approved answer history, and freshness is still
inherited from the KB — no TTLs, no canned answers. What changes: when the cheap freshness
signal is ambiguous, we **ask the model to reconcile against the live sources** rather than
reject outright. Reuse stays *provably* valid — the reconcile step is grounded in the current
text of the candidate answers' cited sections, so "reused, still good" means "re-checked the
live sources," not "a timestamp looked unchanged."

## Part 1 — Reconciliation reuse

### 1.1 Match: top-N, not top-1

Replace `matchApproved` (single best) with `matchApprovedTopN(flowId, vector, model, k)`
returning up to **k** approved items above `QUESTIONNAIRE_MATCH_THRESHOLD`, ordered by cosine
similarity. `k` = `QUESTIONNAIRE_RECONCILE_CANDIDATES` (default **3**). Handing all candidates
to the reconcile step dissolves the "stale item shadows fresh item" bug — the model picks the
good one instead of being stuck with the closest embedding.

### 1.2 Deterministic fast-path (free, no model call)

Reuse verbatim with **no LLM call** iff *all* hold:

- exactly **one** candidate above threshold, and
- every section it cited is byte-identical (Check 1 today), and
- nothing newer is relevant (Check 2 today — no top-k hit `content_changed_at` > answer time).

This is today's reuse condition, restricted to the unambiguous single-candidate case. Outcome
`reused`; the stored approved answer is copied **verbatim by id** (never re-emitted by a model).

### 1.3 Reconcile job (queued) — everything else

Any other matched case — multiple candidates, or a single candidate whose sources changed or
have newer relevant content — enqueues a **reconcile job** instead of a fresh re-answer.

Queue-only compliance: like `answer_question`, the API enqueues; the watcher claims it, calls
back into the API for scoped context (the candidate answers plus the **current** text of their
cited sections) and for retrieval, invokes the provider, and posts the result back. No inline
chat call is added to the API.

The runner primes the model with the candidates and their live cited-section text, and
instructs: *satisfy from the candidates if you honestly can; search the KB only if you must.*
Structured output verdict:

| Verdict | Meaning | Answer text source | Provenance | Typical cost |
|---|---|---|---|---|
| `reused` | one candidate still fully correct | the approved answer, **copied by id** | that item | cheapest — no retrieval |
| `adapted` | one candidate, lightly edited | model output | that item | small generation |
| `merged` | several combined (± edits) | model output | those items | small–medium |
| `fresh` | none usable; searched and wrote new | model output | none | full answer cost |

Trust rule: for `reused`, the API substitutes the original approved answer text by id rather
than trusting the model's echo, so verbatim really is verbatim. `adapted`/`merged`/`fresh`
carry the model's text and its own citations.

### 1.4 Outcome model

`questionnaire_items.outcome` widens from `{reused, fresh, changed}` to
`{reused, adapted, merged, fresh}`. `changed` is retired for new rows (its old meaning —
"matched but rejected, re-answered fresh" — is now `fresh` reached via reconcile, or one of
`adapted`/`merged`); historical `changed` rows are left intact by widening (not narrowing) the
CHECK.

## Part 2 — Show, don't suppress

### 2.1 `unanswerable` means *ungrounded*, not *unsure*

Redefine the gate ([service.ts:151](../../../apps/api/src/features/questionnaires/service.ts)):

```
unanswerable  ⟺  citations.length === 0
```

Confidence is **removed** from the gate. An answer with ≥1 citation is `answered` regardless of
`low`/`medium`/`high`; confidence becomes a **display/review badge**, not a suppressor. Only a
genuinely ungrounded result (no citations) shows *"No answer available"* — which is also the
honest gap signal. Gap candidacy is unchanged (it keys on gap rows, not on this status), so the
flywheel still captures low-confidence items.

### 2.2 Durable confidence + provenance on the item

- Add `confidence` to `questionnaire_items` (snapshotted from the answer, like citations are),
  so the worksheet is stable and doesn't re-join the mutable `questions` row.
- Add `questionnaire_item_basis(item_id, basis_item_id)` — the general provenance table for
  `adapted`/`merged` (and single-item `reused`/`adapted`). `reused_from_item_id` stays for
  back-compat, derived from the single-basis case.

### 2.3 Rendering

- **Markdown export**: render the answer whenever present, prefixed with a badge line when it
  needs attention, e.g. `> ⚠ Low confidence — review` and a provenance line
  `> Source: merged from Q#3, Q#7 (QA #2)`. Emit `_No answer available._` only for
  `unanswerable` (now = ungrounded).
- **CSV export**: add `confidence` and `provenance` columns alongside the existing `status`.
- **Console** (`QuestionnairesPanel`): confidence badge + provenance chips per item; unchanged
  otherwise.

## Data flow

```
create → embed items (inline) → matchApprovedTopN
  ├─ 0 candidates ───────────────► answer_question (fresh)
  ├─ 1 candidate, sources clean ─► reuse verbatim (fast-path, no model)   outcome=reused
  └─ else ───────────────────────► reconcile job (queued)
                                      └─ verdict → reused | adapted | merged | fresh
completion → snapshot answer + citations + confidence + basis → item
```

## Components (each independently testable)

- `matchApprovedTopN` (store) — pure SQL top-k; testable against Postgres fixtures.
- `fastPathReusable(candidate, fingerprints, hits)` (pure) — the §1.2 predicate.
- Reconcile runner (watcher) — provider call with candidates+live sources; deterministic via
  fixture provider (see writing-magpie-tests).
- Completion handler — maps verdict → item fields + basis rows; pure given job output.
- Export renderer — pure `(Questionnaire) → string`; already isolated in `export.ts`.

## Error handling / edge cases

- Reconcile job fails terminally → `failItem` (`unanswerable` + error), as today.
- Malformed/invalid verdict → validation retry; on repeated failure, fall through to a fresh
  `answer_question` (safe, never a wedged item).
- `reused` verdict naming a basis id that is no longer approved → treat as `fresh` (the corpus
  moved under the job).
- Fast-path is provably safe: byte-identical `content_hash` guarantees the cited sources are
  unchanged; the single-candidate restriction avoids silently dropping a better merge.
- Verbatim guarantee: `reused` copies stored text by id, so a model can't quietly reword an
  approved answer.

## Testing

- Unit: `matchApprovedTopN` ordering/threshold; `fastPathReusable` truth table;
  `unanswerable ⟺ no citations`; export rendering (shown low-confidence + badge + provenance;
  true-abstain blank).
- Reconcile runner: one fixture per verdict (`reused`/`adapted`/`merged`/`fresh`), asserting
  verbatim substitution on `reused` and basis rows on `merged`.
- Postgres-gated integration: migration up, basis table writes, top-k query.
- Regression for the QA #4 shape: single candidate + changed sources → reconcile → `reused`
  (not a forced fresh re-answer).

## Config

- `QUESTIONNAIRE_RECONCILE_CANDIDATES` (k, default 3).
- `QUESTIONNAIRE_MATCH_THRESHOLD` (unchanged, 0.84).
- `QUESTIONNAIRE_RECONCILE_ENABLED` (default on) — off falls back to today's veto behaviour.

## Non-goals (YAGNI)

- Automated contradiction detection between answers or sources (the pricing-vs-Enterprise-SLA
  case). The reconcile step reads multiple answers and live sources, so it is the natural
  future home for this, but it is **not** built in this pass.
- Fuzzy multi-tier matching below the near-verbatim threshold.
- Changing the embedding model or retrieval algorithm.

## Rollout

1. Migration: widen `outcome` CHECK; add `confidence`; add `questionnaire_item_basis`.
2. New queued job type + watcher capability (see add-a-job-type skill).
3. Match/fast-path/reconcile wiring behind `QUESTIONNAIRE_RECONCILE_ENABLED`.
4. Show-don't-suppress gate + export/console rendering (shippable independently, and the
   higher-trust quick win).
