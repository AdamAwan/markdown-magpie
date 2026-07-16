# Questionnaires

Questionnaire mode handles the "same questions, every quarter" workload — security
questionnaires and other bulk question batches — with **verbatim answer consistency**:
an equivalent question gets the *same wording* back until the underlying knowledge
actually changes, and reuse costs zero AI spend. Design spec:
`docs/superpowers/specs/2026-07-16-questionnaire-mode-design.md`.

## Core principle

**The questionnaire's memory is its own answer history; freshness is inherited from the
KB.** There is no separate store of truth, no TTLs, no hand-curated canonical answers.
An old answer is reusable exactly when the KB says it is; patrols keep the KB correct,
and answers derive their validity from the KB sections they cited.

## Lifecycle

1. **Create** (`POST /api/questionnaires`, console `/questionnaires`): a named batch of
   questions pinned to a flow. One question per line in the console form.
2. **Match**: each item is embedded (inline — embeddings are the sanctioned exception to
   queue-only) and compared against **approved** items of prior questionnaires in the
   same flow. The bar is `QUESTIONNAIRE_MATCH_THRESHOLD` (default **0.84** — the same
   near-identical-rewordings-only threshold gap clustering uses). No embedding provider →
   matching degrades to "everything answers fresh".
3. **Reuse check** — a matched item reuses the prior answer verbatim iff BOTH hold:
   - **Cited sections byte-unchanged**: every section the prior answer cited still exists
     with identical content (compared via `md5(heading, content)` fingerprints snapshotted
     at approval — durable in `questionnaire_item_citations`, which deliberately has no FK
     so it survives re-index section churn).
   - **No new relevant content**: re-run retrieval for the question today; if any top-k
     hit's `content_changed_at` is **later than the prior answer's generation time**,
     reuse is off. This catches the "a new certificate file was added" case: additions
     anywhere in the indexed KB surface through retrieval scoring, with no watch-lists.
     Rank shuffles among old sections can never trigger a refresh.
   A reused item carries the **original** `answered_at` forward as the freshness baseline
   for future checks. A non-reusable match is badged **changed** and re-answered, with the
   machine-readable reason (which section changed / vanished / appeared, and when) shown
   on the worksheet — wording changes are always explained, never arbitrary.
4. **Answer**: fresh and changed items go through the ordinary `answer_question` job —
   same queue, watcher, prompts, and grounding verification; no questionnaire-specific AI
   path exists. Items **drip** into the queue (`QUESTIONNAIRE_MAX_INFLIGHT`, default 3
   per questionnaire) so a big batch can't crowd out live asks. Drip state is derived,
   not timer-held: every completion, failure, and worksheet read tops it back up, so an
   API restart can never wedge a questionnaire.
5. **Review, approve, export** (console `/questionnaires`): items are badged
   **reused / fresh / changed / unanswerable**. Approval is the human act that admits an
   answer into the match corpus for future questionnaires (and snapshots its citation
   fingerprints; if the KB already moved on by approval time the item is flagged
   `stale_at_approval` — exportable, but never reusable, by construction). Export as
   Markdown or CSV.

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

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `QUESTIONNAIRE_MATCH_THRESHOLD` | `0.84` | cosine floor for matching a prior approved item |
| `QUESTIONNAIRE_MAX_INFLIGHT` | `3` | per-questionnaire drip concurrency |
| `QUESTIONNAIRE_STORE` | storage default | `memory`/`postgres` store override |

## Known limits (v1)

- **Reuse checks see the indexed KB only.** A new certificate sitting un-merged in a
  *source* repo is invisible to any reuse check by construction; surfacing it is the
  source-change-sync pipeline's job.
- Export links hit the API directly; under Auth0 they need a session that can pass the
  browser's cookie/token along (fine for local/off-auth deployments).
- Paste/CSV-free creation only — no spreadsheet/PDF questionnaire parsing.
