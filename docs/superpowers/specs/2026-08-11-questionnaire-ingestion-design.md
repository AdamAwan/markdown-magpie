# Ingesting completed questionnaires — imported answers as evidence, not answers — design

**Date:** 2026-08-11
**Status:** Proposed
**Builds on:** [Questionnaire mode](2026-07-16-questionnaire-mode-design.md),
[Questionnaire trust](2026-07-17-questionnaire-trust-design.md),
[Questionnaire direction](2026-07-31-questionnaire-direction-design.md),
[Source conflict detection](2026-07-31-source-conflict-detection-design.md)

## Problem

Every organisation that fills in security questionnaires has a pile of completed ones. Each
is a set of questions someone outside the company thought worth asking, paired with an
answer someone inside the company was willing to put their name to. That pairing is the most
concentrated statement of organisational knowledge the company owns, and Magpie cannot read
any of it.

Two things are lost as a result.

The first is knowledge. A past answer names a certificate, a retention period, a sub-
processor — facts the knowledge base does not contain, and will not contain until someone
notices they are missing. The questionnaire *is* the list of what customers care about, and
it goes unread.

The second is assurance. Nobody knows whether the answers already sent out are still true,
or were ever true. An answer written two years ago asserting a certification may describe a
certificate that lapsed, that was never held, or that is held and simply undocumented. These
three cases are indistinguishable today, and only one of them is safe.

The obvious implementation — load the answers in and treat them as knowledge — is precisely
wrong. It would launder unverified human assertions into a knowledge base whose entire value
proposition is that its claims are grounded in sources.

## Goal

Read a completed questionnaire, and use its answers as **evidence to be adjudicated**, never
as answers to be trusted. Three outcomes, all valuable:

1. **The knowledge base gets richer.** Claims that the sources back but the KB never wrote
   down become knowledge gaps, and flow through the existing reconciler to proposals and PRs.
2. **The knowledge base gets audited.** Which past answers can Magpie reproduce from the KB
   today, and which can it not?
3. **The unbackable claims surface.** Everything asserted to a customer that no source
   supports — or that the sources contradict — lands in a register a human works through.

Secondarily, confirmed past answers seed the reuse corpus, so next quarter's near-identical
questions reuse wording that has already been through review.

## Scope

This spec covers the adjudication pipeline, fed by **pasted** two-column input. File upload,
XLSX/CSV parsing and AI column mapping are a separate follow-on spec that becomes another way
to fill the same pipeline; PDF and `.docx` are out of scope entirely for now.

The triage half is specced and built first deliberately: it carries all the product value and
all the design risk, and it de-risks the extraction work, which is then largely mechanical.

## Design decisions

### D1 · An imported questionnaire is a questionnaire, and the import is not an answer

An imported questionnaire is an ordinary `questionnaires` row whose items each carry an
`imported_answer`. Nothing forks: the same drip, the same worksheet, the same
`answer_question_batch` job, the same grounding.

The inversion is in what the item is *for*. Today an item's job is to **produce** an answer.
An imported item's job is to **adjudicate** one. Magpie still answers every question itself
from the KB, exactly as it does today; the imported text is compared against that answer. It
is never substituted for it, and it never seeds it.

### D2 · The imported answer is untrusted input

An imported answer arrives in a file someone outside the organisation sent, or in a
spreadsheet that has passed through many hands. It is the same trust class as fetched web
content ([ingestion.md IN4](../../ingestion.md)) — **not** the class of a questionnaire
`direction`, which is operator-authored and therefore admitted to the system prompt
([questionnaires.md Q4b](../../questionnaires.md)).

Consequently the imported answer is wrapped as untrusted content in the user turn, never
appended to a system prompt, and carries a grounding guard: it MUST NOT license a claim the
retrieved context does not contain. A questionnaire is exactly the artifact an attacker would
choose to inject through, since the whole point of it is that we read it carefully.

### D3 · Imported items never take the fast path

Verbatim reuse of a prior approved answer ([questionnaires.md Q6](../../questionnaires.md))
short-circuits the model entirely. For an imported item that would defeat the purpose: the
adjudication needs Magpie's own fresh KB-derived answer to grade the import against.

Imported items therefore skip fast-path reuse and always answer fresh. This is a real cost,
paid once per ingestion, and it is the correct one.

### D4 · Stage 1 — the cheap compare, at no extra AI cost

`answer_question_batch` already holds the question and the retrieved context, and is already
producing an answer. The imported answer rides along in its input, and the job emits a
comparison verdict alongside the answer it was going to produce anyway.

| Verdict | Meaning | Next |
|---|---|---|
| `confirmed` | Magpie's KB answer agrees with the imported one | stops here |
| `divergent` | both grounded, but materially different | stage 2 |
| `uncovered` | Magpie's answer is `unanswerable` (zero citations) | stage 2 |

`uncovered` reuses the existing definition of unanswerable —
`unanswerable ⟺ citations.length === 0` ([questionnaires.md Q12](../../questionnaires.md)) —
so confidence never gates it.

### D5 · Stage 2 — the source-grounded per-claim check

`divergent` and `uncovered` items escalate to a source-grounded check that reuses the
`verify_document` lens shape, with the imported answer as the document under test. Its
granularity is **per claim**, as source-conflict detection already is
([source-conflicts.md SC-1](../../source-conflicts.md)): one answer asserting three things
can be right about two of them.

| Finding | Meaning | Routing |
|---|---|---|
| `documented-elsewhere` | sources back the claim, the KB never wrote it down | knowledge gap → reconciler → proposal → PR |
| `contradicted` | sources say something materially different | `asserted_claims` register |
| `unsubstantiated` | no source anywhere asserts it | `asserted_claims` register |
| `source-conflict` | sources disagree with each other | existing source-conflict register |

`documented-elsewhere` is the flywheel: the past answer set the agenda, the sources supplied
the facts, and the drafting agent writes from the sources. The imported text does not reach
the drafting agent as content.

Stage 2 is **bounded per ingestion**, in the manner of `MAX_DRAFTS_PER_TICK`: a large import
against a thin KB would otherwise fan out hundreds of agentic runs at once. The cap warns and
drains across subsequent ticks rather than dropping work silently.

### D6 · One register, two kinds

`contradicted` and `unsubstantiated` are two kinds of one entity, in the same way
`verify_document` returns two finding kinds down one pipe. "We told a customer X and our own
sources say Y" is at least as alarming as an unbackable claim, and both resolve identically:
a human points at a source, corrects the record, or dismisses.

Magpie never adjudicates and never edits a source repository to make a claim true. It
records, and waits — the posture source conflicts already take
([source-conflicts.md](../../source-conflicts.md)).

### D7 · Approval keeps both answers and a human picks

The worksheet shows the imported answer and Magpie's grounded answer side by side. The
reviewer approves one, or edits a merge. Bulk *Approve all confirmed* defaults to the
**imported** wording — preserving already-reviewed, customer-ready phrasing is why the import
was worth doing — with per-item override.

One hard gate: an item with an open `unsubstantiated` or `contradicted` finding **cannot be
approved with the imported wording**. Approval admits an answer into the match corpus
([questionnaires.md Q16](../../questionnaires.md)), so approving it would re-serve an
unbackable claim to next quarter's customer automatically, with no human in the loop. Magpie's
grounded answer remains approvable for that item.

### D8 · `import` is a sixth gap source

A `documented-elsewhere` item is **not** unanswerable — Magpie answered it, with citations —
so the existing unanswerable→gap route ([questionnaires.md Q14](../../questionnaires.md))
never fires for it. A gap must be raised explicitly.

`import` joins `auto` / `followup` / `manual` / `verification` / `feedback`
([gaps-and-maintenance.md G1](../../gaps-and-maintenance.md)). Like `manual` and
`verification`, an `import` gap is **preserved** on re-answer rather than deleted and
rewritten (G3): it records a human assertion, not a model judgement, so a later re-ask must
not silently erase it.

## Data model

Additive only.

| Change | Shape |
|---|---|
| `questionnaires.import_origin` | nullable text; its presence switches on the triage path and records where the batch came from |
| `questionnaire_items.imported_answer` | nullable text |
| `questionnaire_items.import_verdict` | nullable; the D4 stage-1 verdict |
| `asserted_claims` | new table, modelled on `source_conflicts` (migration `0062`): `kind` (`unsubstantiated`/`contradicted`), claim text, owning item + flow, source positions (jsonb), open/resolved/dismissed lifecycle |
| gap source enum | gains `import` |

## Interfaces

- `POST /api/questionnaires` accepts `questions: [{question, importedAnswer?}]` alongside the
  existing string form, and an optional `importOrigin`. Existing callers are unaffected.
- The console's paste box learns two-column input — a TSV selection pasted straight out of a
  spreadsheet already carries tabs.
- `QuestionnaireDetail` gains an imported mode: side-by-side answers, verdict badge, per-item
  approve-which-side, and the bulk action of D7.
- A register page for `asserted_claims`, filterable by flow, with resolve and dismiss. This
  is the "everything we have told customers that we cannot back up" view.
- Stage 2 is a queued job, per [ai-jobs.md](../../ai-jobs.md); no chat model is called inline.

## Testing

Colocated `node:test` suites in the existing pattern:

- Stage-1 verdict derivation and the `uncovered ⟺ zero citations` equivalence.
- D3: an imported item with a matching approved candidate still answers fresh.
- D7's gate: approving imported wording on an item with an open finding is refused.
- D8: an `import` gap survives a re-answer that deletes `auto` gaps.
- Store and Postgres-store coverage for `asserted_claims` lifecycle, mirroring the
  `source_conflicts` store tests.
- Job contract coverage in `packages/jobs` for the extended answer input and the stage-2 job.
- Web component coverage for the side-by-side worksheet and the register page. Per the
  harness limits, verify submit flows rather than typing into text inputs.

## Rejected alternatives

- **Attach the imported answer to the draft as evidence of last resort.** Fastest route to a
  populated KB, and the failure mode is fatal: a plausible-sounding unverified claim gets
  merged by a skimming reviewer and is thereafter indistinguishable from grounded knowledge.
  The grounding invariant is the product.
- **Discard imported answers and re-answer everything.** Simple, and throws away both the
  audit and the reviewed customer-facing wording — most of the reason to do this at all.
- **KB-only comparison, no source-grounded stage.** Cheap, but cannot separate an
  undocumented-but-true certificate from an invented one. Those two cases needing different
  handling is the point of the feature.
- **Approve imported answers into the reuse corpus automatically when confirmed.** Removes
  the human from the one step that admits text into future customer-facing answers.
- **Extraction first.** Delivers a demoable upload flow whose first half produces no
  knowledge value, and defers all the design risk.
