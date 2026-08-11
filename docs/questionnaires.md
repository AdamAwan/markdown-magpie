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
- **Q4a** — **Direction.** A questionnaire MAY carry an optional `direction`: free text
  (**≤2000** chars) stating how its questions should be *read* — e.g. *"where ambiguous,
  assume the question is about the company and not the product"*. It is set **at creation
  and immutable**: answering starts on create, so an edit would leave one questionnaire
  holding answers written under two different directions. A blank/whitespace value
  normalises to **absent**, so `""` and `NULL` are never distinguishable downstream (the
  Q6a comparison depends on it). To change a direction, create a new questionnaire.
- **Q4b** — The direction is appended to the answer system prompt **after** the flow
  persona (`withDirection(withPersona(…))`) and to the reconcile system prompt (Q7), so on
  conflict the questionnaire operator's intent gets the last word. It is operator-authored
  (creation requires `ask:knowledge`), so it is the same trust class as a flow persona: it
  goes into the **system** prompt guarded by `DIRECTION_GROUNDING_GUARD`, **not** wrapped
  as untrusted content. The guard is load-bearing — a direction steers *interpretation and
  framing only*; it MUST NOT supply facts of its own, and MUST NOT license a claim the
  retrieved context does not contain.
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
- **Q6a** — **Direction gate on the fast path.** Verbatim reuse additionally requires the
  candidate's **owning questionnaire** to carry an *identical* direction (`directionsMatch`
  — exact string comparison after trimming, with absent/empty/whitespace all normalised to
  the same "no direction"). A candidate written under a different steer may answer a
  different *reading* of the question, which only the reconcile step can judge. The
  comparison is deliberately **exact**: guessing that two differently-worded directions
  mean the same thing is the failure mode the feature exists to remove, and a mismatch is
  cheap — it falls through to reconcile (Q7), not to a fresh answer. With no direction set
  anywhere, every comparison is "none vs none" and behaviour is byte-for-byte what it was
  before directions existed.
- **Q7** — **Reconcile.** Any other matched case (multiple candidates, or a single
  candidate whose fast-path check couldn't confirm it) MUST NOT be vetoed. Its candidate
  ids are stashed (`setReconcileCandidates`) and the drip primes the item's
  `answer_question_batch` job with the candidate answers (and, in the watcher, the current
  text of their cited sections). The model decides — against live sources — whether to
  reuse, adapt, merge, or answer fresh. This is the **only** place the watcher calls a
  model for reuse; it fails **open** (an unparseable verdict falls through to the normal
  answer flow, stamped `reuse: {verdict: "fresh"}`). When the questionnaire carries a
  direction (Q4a) the reconcile prompt carries it too, with an explicit criterion: a
  candidate that answers a **different reading** of the question than the direction implies
  is **not** `reused`, however accurate it is on its own terms — adapt it, or answer fresh.
  This is what makes a direction reach *inherited* answers, not only newly-written ones.

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

  The legacy path carries the **same** direction gate: it reuses verbatim only when
  `decision.reuse && directionsMatch(…)`. A candidate that passes the freshness check but
  was answered under a *different* direction is left **pending** with no change reason —
  nothing about the knowledge base changed — so the drip answers it fresh under this
  questionnaire's direction.
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
  server-side read resumes a stalled drip, so polling doubles as restart recovery. When the
  questionnaire carries a direction it is rendered once, above the stat banner, read-only —
  it is immutable, so there is nothing to edit. The create form carries a matching optional
  "Direction" field.
- **Q18** — **Export.** `GET /api/questionnaires/:id/export?format=md|csv` renders a pure
  worksheet download: Markdown (`## n. question` + answer, with the low-confidence/
  provenance blockquotes of Q13, and — when set — a `> Direction: …` line under the title,
  since a reviewer needs to know which reading the answers took) for pasting into
  documents; CSV (RFC 4180 quoting, columns
  `position, question, answer, status, confidence, outcome`) for spreadsheet portals.
  Export is console/API-only (not on the MCP surface). Downloads MUST go through the
  console's authed download (a plain `<a href>` omits the bearer token and 401s under
  Auth0).

## Ingesting completed questionnaires

Reading a questionnaire the organisation already answered, and using its answers as
**evidence to be adjudicated** rather than answers to be trusted. Three outcomes: the KB gets
richer, the KB gets audited, and every claim nothing can back surfaces in a register.

- **Q19** — **An imported questionnaire is a questionnaire.** `questionnaires.import_origin`
  (nullable) is the single switch; its presence routes the batch onto the adjudication path,
  and its absence leaves behaviour byte-for-byte as it was before ingestion existed. Items
  carry `imported_answer`. Creation accepts either a bare question string or
  `{question, importedAnswer?}`, normalised once in the service (a blank imported answer
  becomes absent, as a blank `direction` does).
- **Q20** — **The imported answer is untrusted external input**, the same trust class as
  fetched web content ([ingestion.md IN4](./ingestion.md)) — **not** the operator-authored
  class of `direction` (Q4b). It is wrapped in the untrusted delimiters in the **user** turn,
  never a system prompt, behind `IMPORTED_ANSWER_GUARD`: it is not a source, it may not be
  cited, and it must not change the answer written. A questionnaire arriving from a
  customer's procurement team is exactly the artifact an attacker would inject through.
- **Q21** — **Imported items never fast-path** (Q6). Verbatim reuse short-circuits the model,
  and the adjudication needs Magpie's *own* fresh KB answer to grade the import against.
  Embeddings are still computed and stored, so approved imported items join the match corpus
  for **future** questionnaires. A real one-off cost, paid deliberately.
- **Q22** — **Stage 1 — the free compare.** `answer_question_batch` already holds the question
  and the retrieved context, so the imported answer rides along in its input and the job emits
  a verdict alongside the answer it was producing anyway: **no extra AI call**.

  | Verdict | Meaning | Next |
  |---|---|---|
  | `confirmed` | Magpie's KB answer agrees on every material point | stops here |
  | `divergent` | both grounded, materially different | stage 2 |
  | `uncovered` | Magpie's answer cites nothing | stage 2 |

  `uncovered` reuses the Q12 equivalence (zero citations), decided in **code**: a model
  reporting `confirmed` while citing nothing is exactly the failure this exists to catch. A
  missing or garbled verdict on a grounded answer falls back to `divergent`, because silently
  confirming is the unsafe default.
- **Q23** — **Stage 2 — the source-grounded per-claim check.** `verify_imported_answer`
  (provider-routed, source-grounded, 15-min expiry — routed exactly like `verify_document`,
  and registered in `sourceGroundedInputSchema` so it actually reaches the checkouts). Metered
  by the global AI cap but **not** interactive, so a large import can never erode the reserve
  protecting live `/api/ask`. Granularity is **per claim**: one answer asserting three things
  can be right about two of them.

  | Finding | Meaning | Routing |
  |---|---|---|
  | `documented-elsewhere` | sources back it, the KB never wrote it down | `import` gap → reconciler → proposal → PR |
  | `contradicted` | sources say something materially different | `asserted_claims` register |
  | `unsubstantiated` | no source anywhere asserts it | `asserted_claims` register |
  | `source-conflict` | sources disagree with *each other* | existing conflict register ([source-conflicts.md](./source-conflicts.md)) |

  `documented-elsewhere` is the flywheel: the past answer sets the agenda, the **sources**
  supply the facts, and the imported text never reaches the drafting agent as content.
- **Q24** — **Escalation is bounded**, in the manner of `MAX_DRAFTS_PER_TICK`:
  `MAX_ESCALATIONS_PER_TICK` (**10**) per tick, with the remainder **deferred and logged**,
  never dropped. Drip-style derived state — a worksheet read or a stage-1 completion drains
  it — so an API restart can never wedge an ingestion part-way. Dequeuing uses a dedicated
  `import_escalated_at` stamp rather than overwriting `import_verdict`, which would make the
  worksheet report a stage-1 verdict the adjudication never reached.
- **Q25** — **The asserted-claims register.** `contradicted` and `unsubstantiated` are two
  kinds of one entity, mirroring how `verify_document` returns two finding kinds down one
  pipe: both resolve identically, so one register with a `kind`. Detection upserts on
  fingerprint and **never** writes `status`, which is what keeps a human's dismissal sticky
  across re-ingestion. Magpie never adjudicates and never edits a source to make a claim
  true — the posture source conflicts already take. Resolving or dismissing **requires a
  note**: an entry closed without a reason defeats the audit trail the register exists to be.
- **Q26** — **The approval gate.** An item with an open `unsubstantiated`/`contradicted`
  finding **cannot be approved with the imported wording** (409 `claim_unsubstantiated`).
  Approval admits an answer into the match corpus (Q16), so it would re-serve an unbackable
  claim to next quarter's customer with no human in the loop. Magpie's own grounded answer
  stays approvable for the same item, so the gate is never a dead end. Approving the imported
  wording keeps the human's reviewed phrasing and **Magpie's citations**, so the answer stays
  grounded and keeps tracking the sections it was built from.
- **Q27** — **`import` is a sixth gap source** alongside `auto`/`manual`/`followup`/
  `verification`/`feedback` ([gaps-and-maintenance.md G1](./gaps-and-maintenance.md)). A
  `documented-elsewhere` item is *not* unanswerable — it answered fine and cites sections — so
  the Q14 unanswerable→gap route never fires for it. Like `manual` and `verification` it
  survives a re-answer (only `auto`/`followup` are rewritten), because it records a human
  assertion rather than a model judgement. Raising is idempotent per (question, summary).

- **Q28** — **The console.** An imported item renders **side by side** on the worksheet
  (`ImportedAnswerPanel`): the previously-given wording against Magpie's KB-derived answer,
  the stage-1 verdict, and any live findings inline with the source positions that produced
  them. *Approve imported* is disabled on an item with an open finding — the server's 409
  (Q26) is the real guard, the disabled button is so a reviewer is not invited to try. The
  create form takes two-column paste (`parseTwoColumnPaste`: question, tab, previous answer —
  a spreadsheet selection already carries the tab) plus an optional import source. The
  register has its own page at `/asserted-claims`, filterable by status, where resolving or
  dismissing requires a note.

## Uploading a questionnaire file

Turning a real questionnaire file — XLSX or CSV — into the `{question, importedAnswer?}` pairs
the ingestion pipeline above already consumes. Nothing downstream changes: this is a second
way to fill `POST /api/questionnaires`, not a second questionnaire model.

- **Q29** — **An upload is a staging resource, not a second questionnaire path.** A file
  creates a `questionnaire_imports` row; only *confirm* creates a questionnaire, and it does
  so by calling the ordinary create service with `importOrigin` set to the file's name (Q19).
  The questionnaire model never learns about files, sheets or columns — delete the extraction
  half tomorrow and paste still works byte-for-byte.
- **Q30** — **Deterministic parse, inferred mapping.** Reading cells out of a file needs no
  model (`parse-xlsx.ts` unzips with `fflate` and walks the sheet XML; `parse-csv.ts` is an
  RFC-4180 reader with BOM handling and comma/semicolon/tab sniffing). Deciding *which* column
  is the question does: layout variance across SIG, CAIQ, VSA and bespoke workbooks is
  unbounded, and every hardcoded heuristic is a rule some vendor's file breaks. Cells are read
  as **text** — a cached formula value is taken as-is and never evaluated.
- **Q31** — **The mapping job returns coordinates, never text.** `map_questionnaire_columns`
  is provider-routed, non-interactive, metered and repairable. Its input is a bounded sample
  per sheet (30 rows × 25 columns, cells truncated) wrapped in the untrusted delimiters
  exactly as Q20 wraps an imported answer; its output is a role, a header-row index and column
  **indices**. Every output field is a number, an enum or a short reason, so an injection
  buried in a cell can at worst produce a **wrong mapping** — which is what the Q33 gate
  catches. No model-authored text is ever on the path from file to questionnaire item.
- **Q32** — **Nothing at rest.** The uploaded bytes are parsed inside the request and dropped:
  never written to disk, never stored. What persists is the extracted grid in
  `questionnaire_imports.sheets`, and it is nulled on confirm or discard, leaving filename,
  format and the confirmed mapping as the audit trail. Unconfirmed imports are swept after
  **24 hours**, lazily on upload rather than on a timer — the same derived-state discipline as
  the drip (Q24), so a restart can never strand customer material. Bounds at upload: 5 MB, 20
  sheets, 5 000 rows/sheet, 60 columns, cells capped at the 20 000-char imported-answer limit;
  the 500-question cap is enforced at confirm.
- **Q33** — **The human confirms the mapping before any answering starts.** Until confirm, no
  questionnaire exists, no `answer_question_batch` is enqueued, and the only AI spend is the
  one mapping call. A mis-parsed sheet caught here costs that; caught after answering it costs
  a full adjudication run and pollutes the match corpus with instruction text. Preview and
  confirm run the **same** pure `applyMapping`, so what the operator approved is what gets
  created.
- **Q34** — **Unclassified rows are surfaced, never dropped.** Rows the mapping cannot take
  become a triage list with their reason (`above_header`, `blank_question`, `heading_like`,
  `no_mapping`) and a promote-to-question control. A count-only "142 rows skipped" would make
  the gate a rubber stamp: a mis-detected question column reads as a clean import precisely
  when the rows it lost are invisible. Wholly blank rows stay silent — they are noise, not
  loss.
- **Q35** — **One upload may span sheets; the operator picks which.** Included sheets
  concatenate into one questionnaire in sheet order, each question prefixed by its sheet name
  (when more than one contributes) and by the running section heading. A workbook whose
  domains are split across tabs is one questionnaire to the customer who sent it, and
  splitting it would fragment the worksheet, the register and the approval flow.
- **Q36** — **Never a dead end.** An unreadable, oversized, empty or unsupported file 400s at
  upload with its reason and stores nothing. A failed or dead-lettered mapping job leaves the
  import `failed` **with its grid intact**, so the operator maps by hand or the job re-runs —
  only a bad *parse* needs the file again. A model that classifies nothing yields a blank
  proposal the operator fills in. Paste remains available throughout.

## API surface

All routes are flow-scoped via `assertCan(…, flow)` on the questionnaire's flow (cross-flow
reads follow the reads-as-404 convention). Creation sits under the `trigger` rate tier.

| Route | Scope | Notes |
|---|---|---|
| `POST /api/questionnaires` | `ask:knowledge` + flow `ask` | `{name, flowId, questions[], direction?, importOrigin?}` (≤500 questions; direction ≤2000 chars, immutable). A question entry is a string or `{question, importedAnswer?}` (imported answer ≤20000 chars); **201** with initial worksheet |
| `GET /api/questionnaires` | `read:knowledge` | summaries with per-status counts |
| `GET /api/questionnaires/:id` | `read:knowledge` + flow `read` | worksheet; also resumes a stalled drip |
| `GET /api/questionnaires/:id/export?format=md\|csv` | `read:knowledge` + flow `read` | file download |
| `POST /api/questionnaires/:id/items/:itemId/approve` | `manage:knowledge` + flow `manage` | 409 unless the item is `answered` |
| `POST /api/questionnaires/:id/approve-reused` | `manage:knowledge` + flow `manage` | bulk-approve reused items |
| `POST /api/questionnaire-imports` | `ask:knowledge` + flow `ask` | multipart (`file`, `flowId`, `name`); parses, stores the grid, enqueues the mapping job; **202** with the staged import |
| `GET /api/questionnaire-imports/:id` | `read:knowledge` + flow `read` | status, proposed mapping, bounded preview and the unclassified rows |
| `POST /api/questionnaire-imports/:id/confirm` | `manage:knowledge` + flow `manage` | `{sheets:[{sheetIndex, include, mapping}], promoted?}` → **201** with the created questionnaire; 409 `empty_questionnaire`/`too_many_questions`/`not_mapped` |
| `DELETE /api/questionnaire-imports/:id` | `manage:knowledge` + flow `manage` | discard the upload and its extracted grid |
| `GET /api/asserted-claims?status&flowId&limit` | `read:knowledge` | the register; flow-filtered to what the caller can read |
| `PATCH /api/asserted-claims/:id` | `manage:knowledge` + flow `manage` | `{status: "resolved"\|"dismissed", note}` — note required; cross-flow reads as 404 |

## MCP surface

The MCP server ([mcp.md](./mcp.md)) exposes questionnaire mode as three thin tools over the
routes above. Create returns the initial worksheet **immediately** (fast-path-reused items
already carry answers); everything else drips, so clients re-read with
`kb_questionnaire_get` until no items are `pending`/`answering`. The worksheet view keeps
per-item status/outcome/answer/confidence/changeReason plus `{path, heading}` citations and
strips internal ids and citation fingerprints (the item `id` stays — approve targets it).
`kb_questionnaire_create` takes an optional `direction` (Q4a), and the view echoes it back
so an agent can see which reading the answers were produced under. Export stays
console/API-only.

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
- **XLSX and CSV only.** `.docx` and PDF are out of scope: prose formats need a different
  extractor and a different confidence story. Formulas are read as their cached values, never
  evaluated, and recovering from a bad *parse* means re-uploading — the file itself is never
  kept (Q32).
- Stage 2 is bounded to `MAX_ESCALATIONS_PER_TICK` (10) per tick and drains across later
  worksheet reads and completions, so a large import finishes adjudicating over several ticks
  rather than all at once.
- No automated contradiction detection between candidate answers (e.g. a pricing answer vs.
  an Enterprise-SLA answer that quietly disagrees) — the reconcile step is the natural
  future home, not yet built.
- Candidate-priming is questionnaire-only; the live Ask path doesn't reuse approved answers
  verbatim (the shared job is ready for a future step, just not wired in).
- A direction governs the answers **this** questionnaire produces. It does not retroactively
  reframe an answer approved elsewhere and reused verbatim under a matching direction — that
  is what the Q6a match check is for, but it also means changing the direction between two
  runs of the same questionnaire invalidates the free path for every item in it.
- Direction matching is exact (Q6a), so a whitespace-only or typo-level edit costs a full
  reconcile pass. Deliberate; the alternative is guessing that two wordings mean the same.
- A direction is not editable, and there is no per-question override or flow-level default.
  Recovering from a wrong direction means creating a new questionnaire; the old
  questionnaire's approved items remain candidates and are reconciled against the new
  direction rather than fast-pathed.

## Code map

| Concern | Code |
| --- | --- |
| Create / match / drip / completion / approval | `apps/api/src/features/questionnaires/service.ts` |
| Ingestion: the `importOrigin` switch | `apps/api/src/features/questionnaires/import-verdict.ts` (`isImported`) |
| Ingestion: bounded stage-2 escalation + finding routing | `apps/api/src/features/questionnaires/import-escalation.ts` |
| Ingestion: stage-1 verdict (prompt guard, code-side override) | `packages/prompts/src/catalog.ts` (`IMPORTED_ANSWER_GUARD`, `withImportedAnswer`), `apps/watcher/src/runners/generative.ts` (`withImportVerdict`), `apps/watcher/src/job-prompts.ts` |
| Ingestion: stage-2 job contract + prompt | `packages/jobs/src/{schemas,catalog,types}.ts`, `packages/prompts/src/catalog.ts` (`VERIFY_IMPORTED_ANSWER`), `apps/watcher/src/source-workspace.ts` |
| Asserted-claims register (store + routes) | `apps/api/src/stores/{asserted-claims-store,postgres-asserted-claims-store}.ts`, `apps/api/src/features/asserted-claims/routes.ts` |
| Ingestion columns | `packages/db/migrations/0063_questionnaire_import.sql`, `0064_asserted_claims.sql`, `0065_questionnaire_import_escalated.sql` |
| Routes (create, list, get, export, approve) | `apps/api/src/features/questionnaires/routes.ts`, `schema.ts` |
| Deterministic reuse check (checks 1 & 2) | `apps/api/src/features/questionnaires/reuse-check.ts` |
| Fast-path predicate + direction matching | `apps/api/src/features/questionnaires/reconcile.ts` (`isFastPathReusable`, `directionsMatch`) |
| Direction prompt assembly + grounding guard | `packages/prompts/src/catalog.ts` (`withDirection`, `DIRECTION_GROUNDING_GUARD`, `RECONCILE_ANSWER`) |
| Direction column | `packages/db/migrations/0061_questionnaire_direction.sql` |
| Export rendering (md/csv) | `apps/api/src/features/questionnaires/export.ts` |
| Reconcile step (watcher — the only reuse model call) | `apps/watcher/src/runners/generative.ts` (`reconcileOrAnswer`, `reconcileWithCandidates`, `buildReconciledOutput`) |
| Answer job input (candidate priming, `purpose`) | `apps/api/src/platform/answer-question.ts` |
| Store (match, reconcile candidates, complete, approve) | `apps/api/src/stores/questionnaire-store.ts`, `apps/api/src/stores/postgres-questionnaire-store.ts` |
| Gap candidacy IN / questions list OUT | `apps/api/src/stores/postgres-question-log-store.ts` |
| Non-interactive AI capacity gate | `apps/api/src/platform/ai-capacity.ts` |
| Config (threshold, inflight, candidates, enabled) | `apps/api/src/platform/config.ts` |
| Job contract (`answer_question_batch`, reconcile result) | `packages/jobs/src/schemas.ts`, `packages/jobs/src/catalog.ts` |
| Console (index + detail + badges) | `apps/web/src/components/QuestionnaireCreateList.tsx`, `QuestionnaireDetail.tsx`, `questionnaireItems.ts` |
| Console: side-by-side imported review + paste parsing | `apps/web/src/components/ImportedAnswerPanel.tsx`, `questionnaireItems.ts` (`parseTwoColumnPaste`) |
| Upload: XLSX/CSV extraction + bounds | `apps/api/src/features/questionnaire-imports/{parse,parse-xlsx,parse-csv}.ts` |
| Upload: mapping → questions (preview AND confirm) | `apps/api/src/features/questionnaire-imports/apply-mapping.ts` |
| Upload: staging service, routes, confirm body | `apps/api/src/features/questionnaire-imports/{service,routes,schema}.ts` |
| Upload: staging store + migration | `apps/api/src/stores/{questionnaire-import-store,postgres-questionnaire-import-store}.ts`, `packages/db/migrations/0066_questionnaire_imports.sql` |
| Upload: mapping job contract + prompt | `packages/jobs/src/{schemas,catalog,types}.ts`, `packages/prompts/src/catalog.ts` (`MAP_QUESTIONNAIRE_COLUMNS`), `apps/watcher/src/job-prompts.ts` |
| Upload: the console's confirmation gate | `apps/web/src/components/ImportMappingPreview.tsx`, `QuestionnaireCreateList.tsx` |
| Console: the asserted-claims register page | `apps/web/src/components/AssertedClaimsPanel.tsx`, `apps/web/src/app/asserted-claims/page.tsx` |

## Tests (behavioural contract)

`apps/api/src/features/questionnaires/{service,routes,reuse-check,reconcile,export,import-escalation}.test.ts`,
`apps/api/src/features/asserted-claims/routes.test.ts`,
`apps/api/src/stores/asserted-claims-store.test.ts`,
`apps/api/src/stores/{questionnaire-store,postgres-questionnaire-store}.test.ts`,
`apps/web/src/components/{QuestionnaireCreateList,QuestionnaireDetail,questionnaireItems,ImportedAnswerPanel,ImportMappingPreview}.test.tsx`.
Upload: `apps/api/src/features/questionnaire-imports/{parse,parse-csv,apply-mapping,service,routes}.test.ts`
(the XLSX fixture at `fixtures/sample.xlsx` deliberately mixes shared strings, an inline
string, a numeric cell and a sparse row) and
`apps/api/src/stores/questionnaire-import-store.test.ts`.
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
questionnaire detail page), and
`2026-08-11-questionnaire-ingestion-design.md` (ingesting completed questionnaires — Q19–Q27:
imported answers as untrusted evidence, the two-stage adjudication, the asserted-claims
register, the approval gate, and the `import` gap source), and
`2026-08-11-questionnaire-file-upload-design.md` (uploading a questionnaire file — Q29–Q36:
the staging resource, the coordinates-only mapping job, nothing at rest, and the
confirmation gate), and
`2026-07-31-questionnaire-direction-design.md` (the per-questionnaire answering direction —
Q4a/Q4b/Q6a, the direction gate on the fast path, and the direction-aware reconcile
criterion). Design docs are future-tense archive; this spec is the as-built source of truth.
