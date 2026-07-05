# Question Logging

Markdown Magpie records question interactions so the knowledge base can learn from usage.

## Stores

- `STORAGE_BACKEND=postgres`: durable logs in Postgres.

`QUESTION_LOG_STORE` still works as a compatibility override for question logs, but new local and deployment configs should prefer `STORAGE_BACKEND`.

## Logged Fields

Each question log records:

- Question text.
- Chat provider that produced the answer.
- Confidence.
- Retrieved section IDs.
- Flow the question was routed to, when known.
- Answer result.
- Citations.
- Gaps, when present. A single question can record several gaps — each
  distinct unanswered topic is its own gap, tagged `auto` (a whole-question miss
  detected during answer synthesis), `followup` (supporting material a confident
  answer searched for during retrieval but the knowledge base did not contain),
  `manual` (flagged by an admin), `verification` (a merged proposal failed to close
  this gap — see [Gap-closure verification](#gap-closure-verification)), or
  `needs_attention` (verification failed repeatedly and the question is parked from
  auto-redrafting). A `verification`/`needs_attention` gap may carry a `note` — the
  detail of why the merged document still did not answer the question.
- Helpful or unhelpful feedback, when submitted.
- Manual knowledge-gap flag, when set.
- Answer trace — the watcher's audit trail of how the answer was produced: the
  routing decision, every follow-up search the model requested with its hit count
  (empty searches are what ground `followup` gaps), whether the final answer was
  forced by the search budget, whether the model honoured the structured-answer
  contract, and the grounding-verification outcome (ran/skipped and why, with any
  stripped claims). Rendered in the console under **"How this was answered"** on
  each answered question — the Ask page's counterpart to the Schedules view.
- Timestamp.

## Endpoints

```bash
GET /api/questions
GET /api/questions/:id
POST /api/questions/:id/feedback
POST /api/questions/:id/gap
DELETE /api/questions/:id/gap
GET /api/gaps/candidates
```

Gap candidates are grouped by gap summary, across the individual gaps of every question. Answer synthesis asks the model to return structured JSON with `isKnowledgeGap` and a `gaps` array of summaries; when `isKnowledgeGap` is true, the answer is logged as low confidence and each summary becomes its own `auto` gap eligible for grouping. This means a single multi-topic question — for example "how do I set this up with React so I can export dashboards?" — records one gap per unanswered topic, so each can cluster with the same gap from other questions and become its own proposal, rather than being condensed into one summary. (The model may still return a single gap, or the legacy singular `gapSummary` string, which is wrapped into a one-element array.)

The answer is produced by an **agentic retrieval loop** (see [ai-jobs.md](./ai-jobs.md)): after an initial retrieval the model may run bounded follow-up searches within the routed flow to pull in closely related material before answering, and it cites only the sections it actually used. When one of those follow-up searches for supporting material (e.g. "a concrete example of X") comes back empty, the model can record a `followup` gap **even on a confident, well-cited answer**. These are grounded — kept only when the loop actually observed a search return nothing — so they point at a specific missing artifact rather than a whole-question failure. `followup` gaps join the same candidate-clustering and proposal workflow as `auto` gaps.

## Answer Grounding

Answers must be grounded in retrieved context — the system must say "the knowledge
base does not cover X" rather than fabricate. Several layers enforce this:

- **Prompt contract.** The `answer-question` prompt makes the retrieved sections the
  model's only permitted source of facts: no certifications, compliance claims,
  figures, or capabilities the context does not state, even for persuasive or
  sales-flavoured questions — missing selling points are knowledge gaps, not licence
  to invent. Confidence is defined against context support ("high" only when every
  claim is directly supported by the cited sections), and a fixed guard appended
  after every flow persona states that a persona shapes tone only and never adds
  facts.
- **Untrusted output ships distrusted.** Model output that breaks the structured
  answer contract (unparseable JSON, or an answer attributed only to invented
  section ids) is downgraded to `low` confidence instead of defaulting to a quiet
  `medium`.
- **Search before asserting.** During the agentic retrieval loop the prompt directs
  the model to treat a tempting-but-absent supporting fact ("do we have SOC 2?") as
  a search, not an assertion. When that search comes back empty, the missing topic
  is recorded as a `followup` gap alongside the (still confident) answer instead of
  appearing in it. Gap candidacy keys on gap rows — not question confidence — so
  these followup gaps cluster and draft proposals even though the answer itself was
  strong.
- **Grounding verification.** Before a `medium`/`high` answer is returned, the
  watcher runs a second model call (the `verify-answer` prompt) reviewing the
  drafted answer against the retrieved pool. To avoid re-sending the whole pool
  (already sent verbatim in the assess call), the context is split: the **cited**
  sections go in full, while the retrieved-but-uncited sections go as **headings
  only**. The prompt tells the verifier those headings were retrieved as relevant,
  so a claim whose topic matches one is treated as plausibly grounded rather than
  fabricated — preserving the "don't flag uncited-but-retrieved claims" property
  without re-sending every uncited body. Unsupported claims are stripped
  via the verifier's revised answer, the answer drops to `low` confidence, and each
  stripped claim is recorded as an `auto` gap — so a question that tempted the model
  to fabricate (e.g. "are we SOC 2 compliant?") feeds gap clustering and can become
  a real documentation proposal. An unparseable verdict fails open (the drafted
  answer is kept) so a flaky verifier cannot downgrade every answer; gap,
  out-of-scope, and already-`low` answers skip the extra call because they already
  ship distrusted.

The model can also mark an answer **out of scope**: when the question is unrelated to the picked flow's subject area — e.g. a question about cats asked of a product flow — it sets `outOfScope`, and the answer is returned at `unknown` confidence with **no gaps at all**. This is distinct from `isKnowledgeGap` ("this flow *should* cover the topic but the docs don't"): an off-topic question is not a gap, so it never clusters or drafts a proposal. The out-of-scope signal rides on the answer result (`outOfScope`) so the console and MCP can surface it distinctly from a low-confidence answer. This is the picked flow's counterpart to the router's `flowSelectionRequired` abstain, which fires earlier when no flow can be chosen at all.

Gaps can also be flagged manually — via the **Knowledge gap** chip in the console, or the MCP `kb_feedback` tool — when the system fails to detect one automatically. A manual flag is separate from helpful/unhelpful feedback (an answer can be helpful and still expose a gap), and a manually-flagged question joins the same gap-candidate clustering and proposal workflow regardless of its answer confidence. Manual flagging adds a `manual` gap (its summary falls back to the question text) alongside any auto-detected gaps; clearing the flag removes only the manual gap and leaves auto-detected gaps intact.

## Gap-closure verification

Merging a proposal used to *assume* it closed its gaps. It no longer does: a merge is
**verified before it resolves anything**. When a proposal is marked `merged`, the merge
cascade re-indexes the destination and — for any proposal with triggering questions —
enqueues a `verify_gap_closure` job. The API then **re-asks each triggering question**
through the normal queued `answer_question` path against the freshly re-indexed knowledge
base, and applies a deterministic closure test: the question is *closed* only when the
re-ask comes back with a confident answer (`high`/`medium`) that **cites one of the merged
proposal's target documents** (a confident answer citing unrelated docs does not count).
The path match is done in a single path space: a proposal's target path is destination-
root-relative and includes the destination's configured `subpath`, whereas citations are
indexed-subtree-relative with that `subpath` stripped, so the verifier strips the subpath
off the target paths before comparing. (Without this, no citation could ever match on a
subpath-configured destination and every merge would falsely reopen.)

- If every triggering question closes, the gaps are resolved — this is the only path that
  now resolves a gap (`proposals.closure_status = verified_closed`).
- If any question is still open, its gap stays open and gains a **`verification`** row
  whose `note` records why the merged doc still fell short, so the reconciler re-drafts it
  (`reopened`). The reopen is filed under the summary the proposal actually addressed **for
  that specific question**, resolved from the proposal's persisted cluster (the membership
  rows carry each gap's `(question_id, summary)`); if there is no cluster association it
  falls back to intersecting the question's own still-open gap summaries with the proposal's
  recorded summaries, and finally the question text. This dedups with the existing gap in
  candidate clustering rather than forking a new one, and — crucially on a multi-gap
  question or a multi-question cluster — avoids misfiling the reopen under the question's
  oldest unrelated gap or another question's gap. When that gap is re-drafted, its `note` is passed to the drafter as
  `resubmissionNotes`, so the model sees why its previous attempt did not close the gap and
  can address the specific shortfall (see [ai-jobs.md](./ai-jobs.md)).
- After two failed verifications for the same question (`CLOSURE_RETRY_CAP`), its gap is
  filed under **`needs_attention`** instead. That source parks the *whole question* from
  gap candidacy, so it stops auto-redrafting and waits for a human (`needs_attention`).
  The cap counts **distinct proposals** whose re-ask came back `still_open`, not raw rows,
  so a `verify_gap_closure` job retry re-recording the same proposal's outcome (the job has
  no idempotency guard) costs 1 toward the cap however many times it retries. The count is
  also bounded to *since the question's verification lineage last reset* — the
  resolved/dismissed timestamp of its prior `verification`/`needs_attention` gap row, if
  any — so a question parked once and later fixed or dismissed by a human gets a fresh
  retry budget instead of permanently carrying the old count (see `countPriorStillOpen` in
  `apps/api/src/stores/gap-closure-verification-store.ts`).

- If a triggering question's gap was **already resolved or dismissed** before verification
  runs (a sibling proposal's cross-proposal resolve, a reconciler critic dismissal, or a
  human), there is no open work left to verify. The re-ask is skipped — a deterministic gap
  read replaces a full `answer_question` chat call — and a `closed` audit row is recorded
  without re-asking. Crucially, this also stops a needless still-open verdict from re-filing
  a fresh open `verification` gap over a **dismissed** one (which would resurrect a gap a
  human deliberately dismissed back into candidacy). Relatedly, `resolveGaps` never flips an
  already-**dismissed** gap to resolved — a dismissal is a deliberate settlement a merge must
  not override.

- If an earlier run of *this same proposal's* verification already recorded a **`closed`**
  verdict for a question, the re-ask is skipped. The `verify_gap_closure` job has no
  idempotency guard, so a job that closes some questions and then dies mid-loop — before
  `closureStatus` is persisted (the short-circuit below only fires once a full round
  completes) — is retried from the top; without this check every question would be re-asked
  again. `questionsWithClosedVerdict(proposalId)` reads the proposal's prior `closed` verdicts
  once up front, and each already-closed question is carried forward as `closed` (its
  idempotent gap resolution re-driven, no duplicate audit row recorded) instead of spending a
  fresh `answer_question` chat call. This turns a retried verification's re-ask cost from
  O(N × rounds) into O(N + failing × rounds).

- If a triggering question's log itself cannot be found (e.g. it was deleted), there is
  nothing to re-ask, so that question is recorded `still_open` with no re-ask and — because
  none of the usual `recordVerificationGap`/retry-cap bookkeeping applies to a question with
  no log to attach it to — the whole verification escalates straight to `needs_attention`
  (with a loud warning log) rather than leaving the proposal silently parked at `reopened`
  forever with no gap filed and no signal for a human to act on.

Every re-ask is recorded in the `gap_closure_verification` table (verdict, confidence,
whether it cited a merged doc, and the detail) — an append-only audit trail; the retry cap
above is *derived* from it (scoped by distinct proposal + a reset boundary), not a raw tally
of this table's rows. Seed / clusterless proposals have no triggering questions, so nothing
is verified for them (and nothing was ever resolved).
The verification job and endpoint are documented in [ai-jobs.md](./ai-jobs.md); the
console surfaces the per-proposal outcome as a closure badge on the Proposals page.

The cascade — and therefore the `verify_gap_closure` enqueue — is idempotent per
proposal: `POST /proposals/:id/status` only schedules it on the actual transition into
`merged` (a repeated or retried request that finds the proposal already merged is a
no-op), and `verifyGapClosure` itself short-circuits once a proposal already carries a
`closureStatus`. Otherwise a duplicated request could re-run the LLM re-asks and record a
second `still_open` row for the same failure, double-counting it against
`CLOSURE_RETRY_CAP`.

### Operational requirement: run at least two watchers

Gap-closure verification is a *maintenance orchestrator*: the watcher that claims the
`verify_gap_closure` job blocks inside the `POST /api/proposals/:id/verify-closure`
callback while the API re-asks the triggering questions as ordinary `answer_question`
jobs. Because a watcher runs **one job at a time**, those re-asks can only be answered by
a *second* watcher. On a single-watcher deployment the lone watcher is busy in the
callback and can never claim its own re-asks, so they time out.

An infrastructure timeout is **not** a content verdict. A re-ask that never returns an
answer is treated as an *incomplete* verification (not `still_open`): `verifyGapClosure`
throws, the endpoint returns `503`, and the `verify_gap_closure` job simply retries
rather than the API recording a false `still_open` that would wrongly reopen — and
eventually park (`needs_attention`) — a correctly-merged doc. The proposal reads honestly
as *unverified* (no `closure_status`) until a re-ask actually completes. So **run at least
two watchers** for verification to make progress; the console shows a warning when only
one is connected. (The scheduled patrols and the gap reconciler share this
orchestrator shape and the same two-watcher requirement.)

## Queued Answers

Every answer runs through the queue. When a question is asked, the API logs it
immediately with unknown confidence and enqueues an `answer_question` job
carrying the question log ID. A watcher routes the question to a flow, retrieves
context, synthesises the answer, verifies it against the retrieved context (see
**Answer Grounding** above), and completes the job; completion updates the log
with the answer, confidence, chosen flow, and any detected gaps.

**Flow routing is embedding-first.** A caller-pinned flow (or a single configured
flow) skips routing entirely. Otherwise the watcher first calls the API's cheap
embedding-similarity router (`POST /api/route`): the API embeds the question and each
flow's text — its **name**, its admin-authored **routing summary** (a description of
the flow's topical scope, the strongest routing signal), and its **persona** — and
picks the closest flow, but only when it clears a score floor and beats the runner-up
by a margin (the abstain-biased `FLOW_ROUTER_MIN_SCORE` / `FLOW_ROUTER_MIN_MARGIN`
env). The routing summary (`routingSummary`/`summary` on a flow in `KNOWLEDGE_FLOWS`)
is distinct from `persona`: persona shapes the answer's *voice*, the routing summary
sharpens *routing* without touching the answer. It is resolved server-side from the
current config, so a flow only needs a good summary to route well — the name alone is
often too thin a signal. When the scores are too close
to call — or no embedding provider is configured, or the call fails — the router
abstains and the watcher falls back to the chat-completion router
(`ROUTE_QUESTION_TO_FLOW`). Abstaining is always safe: it only reproduces the
pre-embedding behaviour, so a mis-tuned threshold can cost savings but never routing
correctness. The answer trace records which router decided (`routing.method` =
`embedding` | `chat`).
