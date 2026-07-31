# Questionnaire direction — steering how questions are interpreted — design

**Date:** 2026-07-31
**Status:** Proposed
**Builds on:** [Questionnaire mode](2026-07-16-questionnaire-mode-design.md),
[Questionnaire trust](2026-07-17-questionnaire-trust-design.md)

## Problem

A questionnaire arrives as a flat list of questions written by someone outside the
organisation, and many of them are ambiguous in a way the sender never noticed. "Where is
data stored?" means one thing about the company and another about the product. "Do you hold
ISO 27001?" may be asking about the corporate certificate or about a specific hosted service.
The knowledge base contains both readings, so retrieval succeeds and the model answers —
confidently — the wrong question.

Today there is no way to tell it which reading to take. The only free text a questionnaire
carries is `name`, and `name` is never sent to the model: `topUpDrip` builds the job input
from `item.question` and `questionnaire.flowId` alone
([service.ts:163](../../../apps/api/src/features/questionnaires/service.ts)). The only
operator-authored text that reaches the answering prompt is the *flow's* `persona`, applied
via `withPersona` ([catalog.ts:833](../../../packages/prompts/src/catalog.ts)) — which is
flow-wide, shared by every questionnaire against that flow, and about tone rather than
subject.

So the operator's options are to reword all 200 questions by hand, or to accept the answers
and correct them afterwards.

## Goal

Let the operator state, once per questionnaire, how its questions should be read — e.g.
*"where ambiguous, assume the question is about the company and not the product"* — and have
that direction govern every answer the questionnaire produces, **including** the ones it
would otherwise inherit from earlier questionnaires.

Two things the direction is explicitly **not**: it is not a source of facts, and it is not a
licence to answer beyond the retrieved context. It changes which question we understand
ourselves to be answering, not what we are willing to claim.

## Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Scope | Per questionnaire | The motivating example is a whole-document framing, not a per-question one. |
| Reuse | Direction feeds the reconcile prompt | Keeps the trust/reuse mechanism; an off-direction candidate is adapted rather than silently reused. |
| Fast path | Kept only when directions match exactly | Re-running a questionnaire with the same direction stays free; a mismatch falls through to reconcile. |
| Editability | Set at creation, immutable | Answering starts on create, so an edit would leave one questionnaire holding answers written under two directions. |

## Part 1 — Data model

New migration `0061_questionnaire_direction.sql` (next free number at time of writing —
confirm against `packages/db/migrations/` at implementation time):

```sql
ALTER TABLE questionnaires ADD COLUMN direction text;
```

Nullable; `NULL` means no direction. No other schema change — items do not store a direction
of their own, because a questionnaire's direction is immutable and therefore uniform across
its items.

`Questionnaire` and `QuestionnaireSummary`
([core/src/index.ts:382](../../../packages/core/src/index.ts)) gain `direction?: string`.

`createQuestionnaireSchema`
([schema.ts:9](../../../apps/api/src/features/questionnaires/schema.ts)) gains an optional
`direction` string, max **2000** characters, trimmed on the way in, with an all-whitespace
value normalised to absent so `""` and `NULL` are never distinguishable downstream.

## Part 2 — Prompt plumbing

### 2.1 The prompt helper

A new export in [packages/prompts/src/catalog.ts](../../../packages/prompts/src/catalog.ts),
mirroring `withPersona` in shape and in its guard clause:

```ts
export const DIRECTION_GROUNDING_GUARD =
  "The direction above settles how to read an ambiguous question and how to frame the answer. " +
  "It never overrides the grounding rules: it supplies no facts of its own, and it never " +
  "licenses a claim the retrieved context does not contain.";

export function withDirection(baseInstructions: string, direction?: string): string {
  const trimmed = direction?.trim();
  return trimmed
    ? `${baseInstructions}\n\nAnswering direction (how to read these questions):\n${trimmed}\n\n${DIRECTION_GROUNDING_GUARD}`
    : baseInstructions;
}
```

### 2.2 Composition on the answer path

At [generative.ts:282](../../../apps/watcher/src/runners/generative.ts):

```ts
const system = withDirection(
  withPersona(ANSWER_QUESTION.instructions, routedFlow?.persona),
  input.direction
);
```

Persona first (how we sound), direction second (what these questions are about). The ordering
is deliberate: where a flow persona and a questionnaire direction pull against each other, the
direction is nearer the end of the system prompt and the questionnaire operator's intent wins.

### 2.3 Job contract

`direction?: string` is declared on **both** the core `AnswerQuestionJobInput`
([core/src/index.ts:836](../../../packages/core/src/index.ts)) and
`answerQuestionInputSchema` ([schemas.ts:114](../../../packages/jobs/src/schemas.ts)) — the
same schema-stripping gotcha already documented in that file for `priorTurns` and
`candidates`. An input field the provider schema does not declare is dropped by the broker
before the watcher sees it.

It is carried `topUpDrip` → `buildAnswerQuestionInput`
([answer-question.ts:41](../../../apps/api/src/platform/answer-question.ts)), which gains a
`direction` parameter. Live ask and verification callers pass nothing and are unaffected.

### 2.4 The reconcile path

`reconcileWithCandidates` ([generative.ts:169](../../../apps/watcher/src/runners/generative.ts))
applies the same `withDirection` to `RECONCILE_ANSWER.instructions`, and
`RECONCILE_ANSWER` gains a criterion covering the case:

> A candidate that answers a **different reading** of the question than the direction implies
> is not `reused`, however accurate it is on its own terms — adapt it, or answer fresh.

This is what makes the direction reach inherited answers rather than only newly-written ones.

### 2.5 Trust boundary

Creating a questionnaire requires `ask:knowledge`, so the direction is operator-authored —
the same trust class as a flow `persona`. It goes into the **system** prompt unwrapped and
guarded, **not** through `wrapUntrusted`. Retrieved sections and candidate prior answers keep
their existing untrusted wrapping; nothing about this change moves content across that line.

## Part 3 — Reuse semantics

`matchApprovedTopN`
([postgres-questionnaire-store.ts:233](../../../apps/api/src/stores/postgres-questionnaire-store.ts))
additionally returns each candidate's owning questionnaire's `direction`, joining
`questionnaire_items` → `questionnaires`.

`isFastPathReusable`
([reconcile.ts:7](../../../apps/api/src/features/questionnaires/reconcile.ts)) takes a third
argument:

```ts
export function isFastPathReusable(
  candidateCount: number,
  decision: ReuseDecision,
  directionMatches: boolean
): boolean {
  return candidateCount === 1 && decision.reuse && directionMatches;
}
```

`directionMatches` is an **exact** comparison of the two directions after trimming, with
`NULL`, `""` and all-whitespace normalised to the same "no direction" value. No fuzzy
matching and no embedding comparison: a near-identical direction counts as a mismatch, and a
mismatch is cheap — it falls into the reconcile path that already exists, not into a fresh
answer. With no direction set anywhere, every comparison is "none vs none" and behaviour is
byte-for-byte what it is today.

On mismatch the item takes the existing `setReconcileCandidates` route
([service.ts:53](../../../apps/api/src/features/questionnaires/service.ts)), so the candidate
is judged by the model with the direction in hand.

Legacy path (`QUESTIONNAIRE_RECONCILE_ENABLED=0`) needs the same guard — it reuses verbatim
whenever `decision.reuse` holds, so without a check it would bypass the direction entirely.
`matchApproved` gains the same `direction` field, and the branch becomes: reuse only when
`decision.reuse && directionMatches`; on a direction mismatch the item is simply left pending,
so the drip answers it fresh with the direction applied. `markChanged` still covers the
`!decision.reuse` case unchanged.

## Part 4 — Surfaces

**API** — `POST /api/questionnaires` accepts `direction`; both `GET /` (summaries) and
`GET /:id` return it. No new endpoint: the field is immutable, so there is nothing to PATCH.

**Web** — `QuestionnaireCreateList.tsx` gains an optional multi-line "Direction" field below
the name, placeholder *"e.g. where ambiguous, assume the question is about the company and not
the product"*, with helper text stating that it steers interpretation and cannot be changed
later. `QuestionnaireDetail.tsx` renders it once above the item list when present.

**MCP** — `kb_questionnaire_create` ([main.ts:216](../../../apps/mcp/src/main.ts)) gains an
optional `direction` string; `QuestionnaireView`
([kb-client.ts:653](../../../apps/mcp/src/kb-client.ts)) carries it so `kb_questionnaire_get`
echoes back the direction the answers were produced under.

**Export** — the markdown export ([export.ts:9](../../../apps/api/src/features/questionnaires/export.ts))
prints the direction under the title, as provenance: a reviewer reading the worksheet needs to
know which reading the answers took. CSV is unchanged — it is a per-row format and the
direction is a per-document fact.

## Testing

- **Unit (prompts):** `withDirection` returns the base unchanged for undefined / empty /
  whitespace, and appends direction plus guard otherwise; composition order with
  `withPersona` puts the direction last.
- **Unit (reconcile):** `isFastPathReusable` direction normalisation — `NULL` vs `""` vs
  `"  "` all match each other; differing text does not; identical text after trimming does.
- **Service:** creating a questionnaire with a direction, where the single matching candidate
  belongs to a questionnaire with a *different* direction, routes the item to
  `setReconcileCandidates` rather than `markReused`. Same setup with an identical direction
  still fast-paths.
- **Watcher:** fixture provider asserts the direction text is present in the system prompt on
  both the `answerCore` and `reconcileWithCandidates` paths.
- **Migration:** covered by the standard migration test; existing rows read back `NULL`.

## Documentation

Updated alongside the code, not after: `docs/questionnaires.md` (new clauses in Lifecycle and
Configuration, plus code-map and provenance entries), `docs/mcp.md` (M25 input schema),
`docs/api.md` (create payload).

## Known limits

- The direction governs answers **this** questionnaire produces. It does not retroactively
  reframe an answer approved elsewhere and reused verbatim under a matching direction — that
  is exactly what the match check is for, but it also means changing the direction between two
  runs of the same questionnaire invalidates the free path for every item in it.
- Exact-match on direction text is conservative: a whitespace-only or typo-level edit costs a
  full reconcile pass across the questionnaire. Deliberate — the alternative is guessing that
  two differently-worded directions mean the same thing, which is the failure mode this
  feature exists to remove.
- The direction is not editable. Recovering from a wrong direction means creating a new
  questionnaire; approved items from the old one remain reusable candidates, and will be
  reconciled against the new direction rather than fast-pathed.

## Out of scope

Per-question direction overrides, flow-level default directions, and any direction-aware
change to live ask or verification. All three are additive later if the per-questionnaire form
proves too coarse.
