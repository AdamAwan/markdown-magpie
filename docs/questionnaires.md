# Questionnaires

> **Status:** living spec (as-built). Source of truth for questionnaire mode — bulk
> question batches answered with **verbatim answer consistency**: an equivalent question
> gets the *same wording* back until the underlying knowledge actually changes, and
> confirmed reuse costs zero AI spend. Follows the [spec conventions](./README.md#conventions).

## Purpose

Handle the "same questions, every quarter" workload — security questionnaires and other
bulk batches — without re-paying to re-answer what has not changed. The questionnaire's
memory is **its own approved answer history**; freshness is **inherited from the KB**.
There is no separate store of truth, no TTLs, no hand-curated canonical answers: an old
answer is reusable exactly when the KB sections it cited are still present and unchanged
and nothing newer is relevant. Patrols keep the KB correct
([gaps-and-maintenance.md](./gaps-and-maintenance.md)); answers derive their validity from
the sections they cited. When the cheap freshness signal is ambiguous, the system asks the
model to **reconcile** against the live sources rather than reject outright — reuse stays
provably grounded, never a timestamp guess. All generative work is queue-only
([ai-jobs.md](./ai-jobs.md)); embeddings are the sanctioned inline exception.

## Boundaries & execution model

- **Q1** — `POST /api/questionnaires` MUST NOT call a chat model inline. It creates the
  batch, runs the inline **match** phase (embeddings only), fast-path-reuses what it
  provably can, and returns **201** with the initial worksheet immediately — fast-path
  reused items already carry answers; everything else drips through the queue. The only
  place the watcher runs a model for reuse is the reconcile step (Q7).
- **Q2** — Questionnaire answers MUST ride the questionnaire's **own** job type,
  `answer_question_batch` (#288c). It shares the `answer_question` contract (same watcher
  handler, prompts, grounding) but is **metered/globally-capped and NOT interactive**, so
  it admits under `nonInteractiveAiCapacity` (`limit − reserved`) and can never erode the
  interactive reserve that guards `/api/ask`. This reclassification is the **primary**
  protection against a bulk batch crowding out live asks.
- **Q3** — A per-questionnaire **drip** keeps at most `QUESTIONNAIRE_MAX_INFLIGHT`
  (default **3**) items in the answer pipeline at once — a **secondary** bound on a single
  batch's concurrency. Drip state MUST be **derived, not timer-held**: every completion,
  failure, and worksheet read (`GET /api/questionnaires/:id`) tops it back up, so an API
  restart can never wedge a questionnaire. Enqueue goes through the atomic admission
  primitive (`createIfAdmitted`, #288a): count + enqueue under the broker lock so the drip
  can never overshoot even when concurrent asks race it. A rejected admission reverts the
  item to `pending` and deletes the just-recorded log, then pauses until the next
  read/completion resumes it.

## Lifecycle

- **Q4** — **Create.** `POST /api/questionnaires` (console `/questionnaires`) pins a named
  batch of questions to a flow (one question per array entry; the console splits pasted
  text). Body is bounded to **≤500** questions of **≤4000** chars each — a sanity bound,
  not a product limit, since the drip means size only affects duration.
- **Q5** — **Match.** Each item is embedded **inline** and compared, **within its flow
  only**, against **approved** items of prior questionnaires, via `matchApprovedTopN`
  returning the top `QUESTIONNAIRE_RECONCILE_CANDIDATES` (default **3**) above
  `QUESTIONNAIRE_MATCH_THRESHOLD` (default **0.84** — the same near-identical-rewordings
  bar gap clustering uses). With **no embedding provider**, matching degrades to
  "everything answers fresh"; an embed/match **failure** likewise falls back to fresh (the
  safe, merely-more-expensive direction) and MUST NOT lose the questionnaire.
- **Q6** — **Deterministic fast-path** (free, no model call). A match reuses the prior
  answer **verbatim** iff *all* hold: exactly **one** candidate is above threshold; every
  section it cited is byte-identical (`md5(heading, content)` fingerprints snapshotted at
  approval, stored in `questionnaire_item_citations` — which deliberately has **no FK** so
  it survives re-index section churn); and nothing newer is relevant (no top-`k`
  hit's `contentChangedAt` is later than the prior answer's generation time,
  `NEWCOMER_TOP_K = 8`). Check 2 MUST compare against the prior answer's **original**
  generation time, never a later reuse time. A reused item carries the **original**
  `answeredAt` forward as the freshness baseline for future checks.
- **Q7** — **Reconcile.** Any other matched case (multiple candidates, or a single
  candidate whose fast-path check couldn't confirm it) MUST NOT be vetoed. Its candidate
  ids are stashed (`setReconcileCandidates`) and the drip primes the item's
  `answer_question_batch` job with the candidate answers (and, in the watcher, the current
  text of their cited sections). The model decides — against live sources — whether to
  reuse, adapt, merge, or answer fresh. This is the **only** place the watcher calls a
  model for reuse; it fails **open** (an unparseable verdict falls through to the normal
  answer flow, stamped `reuse: {verdict: "fresh"}`).

  | Verdict | Meaning | Answer text source |
  |---|---|---|
  | `reused` | one candidate still fully correct | the approved answer, copied **by id** (never the model's echo) |
  | `adapted` | one candidate, lightly edited | model output, grounded in the candidate + live sources |
  | `merged` | several candidates combined | model output, grounded in the candidates + live sources |
  | `fresh` | no candidate usable | model output, from an ordinary full answer |

- **Q8** — For a `reused` verdict the API MUST copy the approved answer **and its
  citations** verbatim by basis id, carrying the original `answeredAt` forward; a `reused`
  verdict that can't be honored (missing/unknown basis, or basis has no answer) degrades to
  an ungrounded completion rather than a phantom-reuse row. For `adapted`/`merged`/`fresh`,
  model-returned basis ids MUST be filtered to real items before persisting (an unknown id
  would violate the `reused_from_item_id` FK and wedge completion). Reconciled reuse is
  built at **high** confidence, and its citations are derived **in code** from the seed
  sections — never trusted from the model.
- **Q9** — **Legacy veto (opt-out).** `QUESTIONNAIRE_RECONCILE_ENABLED=0` falls back to the
  pre-trust deterministic path: a single-`matchApproved` match that fails the fast-path
  check is badged **`changed`** and re-answered fresh, with a machine-readable reason
  (which section changed / vanished / appeared, and when) shown on the worksheet.
  > Under the **default** (reconcile enabled) path the `changed` verdict is **retired for
  > new matched rows** — they route to reconcile (Q7) instead — and `matchApprovedTopN`
  > replaces `matchApproved`. `changed` now arises **only** under this legacy flag.
- **Q10** — **Answer.** Items with no usable candidate go through `answer_question_batch`
  (Q2) — the same handler, prompts, and grounding verification as a live ask.
- **Q11** — **Review / approve / export** (console detail page, Q17). Items are badged
  `queued` / `answering` / **reused / adapted / merged / fresh / changed** / `unanswerable`
  / `approved`, each answered item also carrying a **confidence** signal
  (`high`/`medium`/`low`/`unknown`).

## Show, don't suppress

- **Q12** — `unanswerable` means **ungrounded**, not "the model was unsure":
  `unanswerable ⟺ citations.length === 0`. Confidence is **not** part of that gate — an
  answer with ≥1 citation is `answered` regardless of `low`/`medium`/`high`/`unknown`
  confidence; confidence is a **display/review** signal, never a suppressor, so a
  correct-but-hedged answer is never blanked. Only a genuinely ungrounded result shows *"No
  answer available."*, which doubles as the honest gap signal.
- **Q13** — Rendering reflects this: the Markdown export prefixes a low/unknown-confidence
  answer with `> ⚠ Low confidence — review` plus a provenance line (e.g.
  `> Source: merged from prior approved answers`); the CSV export adds `confidence` and
  `outcome` columns; the console worksheet shows a "low confidence" badge per item.

## Purpose semantics

Questionnaire item asks record question logs with `purpose: "questionnaire"`:

- **Q14** — **Gap candidacy: IN.** An unanswerable questionnaire question is a real
  knowledge gap — the flywheel: this quarter's miss becomes a gap → proposal → merged doc,
  and next quarter the same question answers itself. Verification re-asks remain excluded
  (#154).
- **Q15** — **Questions list & ask-centric insights: OUT.** The worksheet is the
  questionnaire's surface; the live-ask log and insights charts filter to `purpose = 'live'`
  so 200 near-duplicate rows can't bury the live signal. (Both facts are enforced in the
  same store: gap candidacy queries `purpose IN ('live', 'questionnaire')`; the questions
  list queries `purpose = 'live'`.)

## Approval

- **Q16** — Approval is the human act that admits an answer into the **match corpus** for
  future questionnaires. It MUST snapshot the answer's **generation-time** citation
  fingerprints (what the answer was actually built from) and (re-)embed the item
  idempotently so a creation-time embedding outage can't permanently exclude it. If the KB
  has already moved on by approval time the item is flagged `stale_at_approval` —
  exportable, but never reusable by construction (it can't pass fast-path check 1).
  `approveItem` requires the item be `answered` (else **409**); `approve-reused`
  bulk-approves all reused-unapproved items.

## The detail page

- **Q17** — The console splits questionnaire mode into a create/list index
  (`QuestionnaireCreateList`) and a per-questionnaire **detail page**
  (`QuestionnaireDetail`) that owns its own fetch, so a detail URL works on direct
  navigation and refresh. It renders a back link, name/flow header, a six-tile stat banner
  (Total / Approved / Awaiting approval / In progress / Unanswerable / Reused, derived live
  from items), export (`.md`/`.csv`) and "Approve all reused" actions, and per-item cards
  (badge, low-confidence badge, answer or the gap/failure reason, change reason, citations,
  and a per-item Approve). It polls every `5s` while any item is `pending`/`answering`; the
  server-side read resumes a stalled drip, so polling doubles as restart recovery.
- **Q18** — **Export.** `GET /api/questionnaires/:id/export?format=md|csv` renders a pure
  worksheet download: Markdown (`## n. question` + answer, with the low-confidence/
  provenance blockquotes of Q13) for pasting into documents; CSV (RFC 4180 quoting, columns
  `position, question, answer, status, confidence, outcome`) for spreadsheet portals.
  Export is console/API-only (not on the MCP surface). Downloads MUST go through the
  console's authed download (a plain `<a href>` omits the bearer token and 401s under
  Auth0).

## API surface

All routes are flow-scoped via `assertCan(…, flow)` on the questionnaire's flow (cross-flow
reads follow the reads-as-404 convention). Creation sits under the `trigger` rate tier.

| Route | Scope | Notes |
|---|---|---|
| `POST /api/questionnaires` | `ask:knowledge` + flow `ask` | `{name, flowId, questions[]}` (≤500); **201** with initial worksheet |
| `GET /api/questionnaires` | `read:knowledge` | summaries with per-status counts |
| `GET /api/questionnaires/:id` | `read:knowledge` + flow `read` | worksheet; also resumes a stalled drip |
| `GET /api/questionnaires/:id/export?format=md\|csv` | `read:knowledge` + flow `read` | file download |
| `POST /api/questionnaires/:id/items/:itemId/approve` | `manage:knowledge` + flow `manage` | 409 unless the item is `answered` |
| `POST /api/questionnaires/:id/approve-reused` | `manage:knowledge` + flow `manage` | bulk-approve reused items |

## MCP surface

The MCP server ([mcp.md](./mcp.md)) exposes questionnaire mode as three thin tools over the
routes above. Create returns the initial worksheet **immediately** (fast-path-reused items
already carry answers); everything else drips, so clients re-read with
`kb_questionnaire_get` until no items are `pending`/`answering`. The worksheet view keeps
per-item status/outcome/answer/confidence/changeReason plus `{path, heading}` citations and
strips internal ids and citation fingerprints (the item `id` stays — approve targets it).
Export stays console/API-only.

| Tool | API call | HTTP-transport scope |
|---|---|---|
| `kb_questionnaire_create` | `POST /api/questionnaires` | `ask:knowledge` |
| `kb_questionnaire_get` | `GET /api/questionnaires/:id` | `read:knowledge` |
| `kb_questionnaire_approve` | `POST …/approve-reused`, or `POST …/items/:itemId/approve` when `item` is given | `manage:knowledge` |

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `QUESTIONNAIRE_MATCH_THRESHOLD` | `0.84` | cosine floor for matching a prior approved item |
| `QUESTIONNAIRE_MAX_INFLIGHT` | `3` | per-questionnaire drip concurrency (secondary bound) |
| `QUESTIONNAIRE_RECONCILE_CANDIDATES` | `3` | top-N approved matches (`k`) fed to reconcile |
| `QUESTIONNAIRE_RECONCILE_ENABLED` | on (`0` disables) | `0` falls back to the deterministic-veto (`changed`) path (Q9) |
| `QUESTIONNAIRE_STORE` | storage default | `memory`/`postgres` store override |

## Known limits (v1)

- **Match and reconcile see the indexed KB only.** A new certificate sitting un-merged in a
  *source* repo is invisible by construction; surfacing it is the source-change-sync
  pipeline's job.
- Paste-only creation — no spreadsheet/PDF questionnaire parsing.
- No automated contradiction detection between candidate answers (e.g. a pricing answer vs.
  an Enterprise-SLA answer that quietly disagrees) — the reconcile step is the natural
  future home, not yet built.
- Candidate-priming is questionnaire-only; the live Ask path doesn't reuse approved answers
  verbatim (the shared job is ready for a future step, just not wired in).

## Code map

| Concern | Code |
| --- | --- |
| Create / match / drip / completion / approval | `apps/api/src/features/questionnaires/service.ts` |
| Routes (create, list, get, export, approve) | `apps/api/src/features/questionnaires/routes.ts`, `schema.ts` |
| Deterministic reuse check (checks 1 & 2) | `apps/api/src/features/questionnaires/reuse-check.ts` |
| Fast-path predicate | `apps/api/src/features/questionnaires/reconcile.ts` |
| Export rendering (md/csv) | `apps/api/src/features/questionnaires/export.ts` |
| Reconcile step (watcher — the only reuse model call) | `apps/watcher/src/runners/generative.ts` (`reconcileOrAnswer`, `reconcileWithCandidates`, `buildReconciledOutput`) |
| Answer job input (candidate priming, `purpose`) | `apps/api/src/platform/answer-question.ts` |
| Store (match, reconcile candidates, complete, approve) | `apps/api/src/stores/questionnaire-store.ts`, `apps/api/src/stores/postgres-questionnaire-store.ts` |
| Gap candidacy IN / questions list OUT | `apps/api/src/stores/postgres-question-log-store.ts` |
| Non-interactive AI capacity gate | `apps/api/src/platform/ai-capacity.ts` |
| Config (threshold, inflight, candidates, enabled) | `apps/api/src/platform/config.ts` |
| Job contract (`answer_question_batch`, reconcile result) | `packages/jobs/src/schemas.ts`, `packages/jobs/src/catalog.ts` |
| Console (index + detail + badges) | `apps/web/src/components/QuestionnaireCreateList.tsx`, `QuestionnaireDetail.tsx`, `questionnaireItems.ts` |

## Tests (behavioural contract)

`apps/api/src/features/questionnaires/{service,routes,reuse-check,reconcile,export}.test.ts`,
`apps/api/src/stores/{questionnaire-store,postgres-questionnaire-store}.test.ts`,
`apps/web/src/components/{QuestionnaireCreateList,QuestionnaireDetail,questionnaireItems}.test.tsx`.
Cross-cutting coverage: `packages/jobs/src/{schemas,catalog}.test.ts` (the
`answer_question_batch` contract), `apps/watcher/src/runners/generative.test.ts` (the
reconcile step), and `apps/api/src/stores/postgres-question-log-store.test.ts` (gap
candidacy / questions-list purpose filtering).

## Provenance (design history)

Consolidates, and supersedes as a behavioural description:
`docs/superpowers/specs/2026-07-16-questionnaire-mode-design.md` (base model — inline match,
deterministic fast-path reuse, the drip),
`2026-07-17-questionnaire-trust-design.md` (reconciliation reuse + show-don't-suppress — the
retirement of the `changed` verdict for new rows, `matchApproved` → `matchApprovedTopN`, and
the `reused/adapted/merged/fresh` verdicts), and
`2026-07-17-questionnaire-detail-page-design.md` (the split into create-list + per-
questionnaire detail page). Design docs are future-tense archive; this spec is the as-built
source of truth.
