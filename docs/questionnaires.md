# Questionnaires

Questionnaire mode handles the "same questions, every quarter" workload — security
questionnaires and other bulk question batches — with **verbatim answer consistency**:
an equivalent question gets the *same wording* back until the underlying knowledge
actually changes, and confirmed reuse costs zero AI spend. Design specs:
`docs/superpowers/specs/2026-07-16-questionnaire-mode-design.md` (base model) and
`docs/superpowers/specs/2026-07-17-questionnaire-trust-design.md` (reconciliation reuse
+ show-don't-suppress).

## Core principle

**The questionnaire's memory is its own answer history; freshness is inherited from the
KB.** There is no separate store of truth, no TTLs, no hand-curated canonical answers.
An old answer is reusable exactly when the KB says it is; patrols keep the KB correct,
and answers derive their validity from the KB sections they cited. When the cheap
freshness signal is ambiguous, the system asks the model to **reconcile** against the
live sources rather than reject outright — reuse stays provably grounded, never a
timestamp guess.

## Lifecycle

1. **Create** (`POST /api/questionnaires`, console `/questionnaires`): a named batch of
   questions pinned to a flow. One question per line in the console form.
2. **Match**: each item is embedded (inline — embeddings are the sanctioned exception to
   queue-only) and compared against **approved** items of prior questionnaires in the
   same flow, returning the top `QUESTIONNAIRE_RECONCILE_CANDIDATES` matches (default
   **3**) above `QUESTIONNAIRE_MATCH_THRESHOLD` (default **0.84** — the same
   near-identical-rewordings-only threshold gap clustering uses). No embedding provider →
   matching degrades to "everything answers fresh".
3. **Deterministic fast-path** (free, no model call) — a match reuses the prior answer
   verbatim with **no LLM call** iff *all* hold: exactly **one** candidate is above
   threshold, every section it cited is byte-identical (`md5(heading, content)`
   fingerprints snapshotted at approval — durable in `questionnaire_item_citations`,
   which deliberately has no FK so it survives re-index section churn), and nothing newer
   is relevant (no top-k hit's `content_changed_at` is later than the prior answer's
   generation time). A reused item carries the **original** `answered_at` forward as the
   freshness baseline for future checks.
4. **Reconcile** — any other matched case (multiple candidates, or a single candidate
   whose fast-path check couldn't confirm it) is **not** vetoed. It is answered by the
   same `answer_question` job, primed with the candidate answers (and the current text of
   their cited sections); the model decides — against live sources — whether to reuse,
   adapt, merge, or answer fresh. This is the only place the watcher calls a model for
   reuse; no separate job type exists. Verdicts:

   | Verdict | Meaning | Answer text source |
   |---|---|---|
   | `reused` | one candidate still fully correct | the approved answer, copied **by id** (never the model's echo) |
   | `adapted` | one candidate, lightly edited | model output, grounded in the candidate + live sources |
   | `merged` | several candidates combined | model output, grounded in the candidates + live sources |
   | `fresh` | no candidate usable | model output, from an ordinary full answer |

   Set `QUESTIONNAIRE_RECONCILE_ENABLED=0` to fall back to the old deterministic-veto
   behaviour: any match that fails the fast-path check is badged **changed** and
   re-answered fresh, with a machine-readable reason (which section changed / vanished /
   appeared, and when) shown on the worksheet, instead of going through reconcile.
5. **Answer**: items with no usable candidate go through the ordinary `answer_question`
   job — same queue, watcher, prompts, and grounding verification as a live ask; no
   questionnaire-specific AI path exists. Items **drip** into the queue
   (`QUESTIONNAIRE_MAX_INFLIGHT`, default 3 per questionnaire) so a big batch can't crowd
   out live asks. Drip state is derived, not timer-held: every completion, failure, and
   worksheet read tops it back up, so an API restart can never wedge a questionnaire.
6. **Review, approve, export** (console `/questionnaires`): items are badged
   **reused / adapted / merged / fresh / changed / unanswerable** (`changed` only arises
   under the legacy veto path). Each answered item also carries a **confidence** signal
   (`high`/`medium`/`low`/`unknown`) alongside its answer — see "Show, don't suppress"
   below. Approval is the human act that admits an answer into the match corpus for
   future questionnaires (and snapshots its citation fingerprints; if the KB already
   moved on by approval time the item is flagged `stale_at_approval` — exportable, but
   never reusable, by construction). Export as Markdown or CSV.

## Show, don't suppress

`unanswerable` means **ungrounded** — zero citations — not "the model was unsure":

```
unanswerable  ⟺  citations.length === 0
```

Confidence is not part of that gate. An answer with at least one citation is `answered`
regardless of `low`/`medium`/`high`/`unknown` confidence; confidence is a **display/review
signal**, not a suppressor, so a correct-but-hedged answer is never blanked. Only a
genuinely ungrounded result shows *"No answer available."* — which doubles as the honest
gap signal (an unanswerable questionnaire item still raises a knowledge gap; see "Purpose
semantics" below).

Rendering reflects this: the Markdown export prefixes a low/unknown-confidence answer
with `> ⚠ Low confidence — review` and a provenance line (e.g. `> Source: merged from
prior approved answers`); the CSV export adds `confidence` and `outcome` columns; the
console worksheet shows a "low confidence" badge per item.

## Purpose semantics

Questionnaire item asks record question logs with `purpose: "questionnaire"`:

- **Gap candidacy: IN.** An unanswerable questionnaire question is a real knowledge gap —
  the flywheel: this quarter's miss becomes a gap → proposal → merged doc, and next
  quarter the same question answers itself. (Verification re-asks remain excluded, #154.)
- **Questions list: OUT.** The worksheet is the questionnaire's surface; 200
  near-duplicate rows would bury the live-ask log. Insights' ask-centric charts also
  stay live-only.

## API surface

| Route | Scope | Notes |
|---|---|---|
| `POST /api/questionnaires` | `ask:knowledge` + flow `ask` | `{name, flowId, questions[]}` (≤500); `trigger` rate tier |
| `GET /api/questionnaires` | `read:knowledge` | summaries with per-status counts |
| `GET /api/questionnaires/:id` | `read:knowledge` + flow `read` | worksheet; also resumes a stalled drip |
| `GET /api/questionnaires/:id/export?format=md\|csv` | `read:knowledge` + flow `read` | file download |
| `POST /api/questionnaires/:id/items/:itemId/approve` | `manage:knowledge` + flow `manage` | 409 unless the item is `answered` |
| `POST /api/questionnaires/:id/approve-reused` | `manage:knowledge` + flow `manage` | bulk-approve reused items |

## MCP surface

The MCP server ([docs/mcp.md](mcp.md)) exposes questionnaire mode to MCP clients as
three thin tools over the routes above:

| Tool | API call | HTTP-transport scope |
|---|---|---|
| `kb_questionnaire_create` | `POST /api/questionnaires` | `ask:knowledge` |
| `kb_questionnaire_get` | `GET /api/questionnaires/:id` | `read:knowledge` |
| `kb_questionnaire_approve` | `POST …/approve-reused`, or `POST …/items/:itemId/approve` when `item` is given | `manage:knowledge` |

Create returns the initial worksheet **immediately** — fast-path-reused items already
carry answers; everything else (fresh/adapted/merged/changed) drips through the queue,
so clients re-read with `kb_questionnaire_get` until no items are `pending`/`answering`.
The worksheet view keeps per-item status/outcome/answer/changeReason plus
`{path, heading}` citations and strips internal ids and citation fingerprints (the item
`id` stays — approve targets it). `confidence` is not currently surfaced over MCP (API-
and console-only). Export stays console/API-only.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `QUESTIONNAIRE_MATCH_THRESHOLD` | `0.84` | cosine floor for matching a prior approved item |
| `QUESTIONNAIRE_MAX_INFLIGHT` | `3` | per-questionnaire drip concurrency |
| `QUESTIONNAIRE_STORE` | storage default | `memory`/`postgres` store override |
| `QUESTIONNAIRE_RECONCILE_CANDIDATES` | `3` | top-N approved matches (`k`) fed to the reconcile step |
| `QUESTIONNAIRE_RECONCILE_ENABLED` | on (`0` disables) | off falls back to the deterministic-veto (`changed`) behaviour |

## Known limits (v1)

- **Match and reconcile see the indexed KB only.** A new certificate sitting un-merged in
  a *source* repo is invisible to matching/reconciliation by construction; surfacing it is
  the source-change-sync pipeline's job.
- Export links hit the API directly; under Auth0 they need a session that can pass the
  browser's cookie/token along (fine for local/off-auth deployments).
- Paste/CSV-free creation only — no spreadsheet/PDF questionnaire parsing.
- No automated contradiction detection between candidate answers (e.g. a pricing answer
  vs. an Enterprise-SLA answer that quietly disagrees) — the reconcile step is a natural
  future home for this, but it isn't built yet.
- Candidate-priming is questionnaire-only; the live Ask path doesn't reuse approved
  answers verbatim (the mechanism is shared-job-ready for a future step, just not wired
  in yet).
