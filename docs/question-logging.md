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
  `manual` (flagged by an admin), `feedback` (a user marked a confident answer
  unhelpful — see [Unhelpful feedback on a confident answer](#unhelpful-feedback-on-a-confident-answer)),
  or `verification` (a merged proposal failed to
  close this gap — see [Gap-closure verification](#gap-closure-verification)). A
  `verification` gap may carry a `note` — the detail of why the merged document
  still did not answer the question — and, once verification has failed past the
  retry cap, a `parkedAt` timestamp: the whole question is then **parked**,
  awaiting a human (see [Parked questions](#parked-questions)). Parking is a
  first-class *state* on a verification gap, not a distinct source.
- Helpful or unhelpful feedback, when submitted.
- Manual knowledge-gap flag, when set.
- Conversation id and standalone question (#239), for multi-turn conversations —
  see [Multi-turn conversations](#multi-turn-conversations) below.
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
DELETE /api/questions/:id          # purge a question (manage:admin); ?scrub=true also cleans downstream
POST /api/questions/:id/feedback
POST /api/questions/:id/gap
DELETE /api/questions/:id/gap
GET /api/gaps/candidates
```

`DELETE /api/questions/:id` is the **sensitive-info purge** (`manage:admin`). By default it
deletes just the question row (the DB cascade takes its citations, gaps and cluster
memberships). With `?scrub=true` it also cleans the artifacts the question's gap text
propagated into: an emptied gap cluster is dismissed and its label overwritten, a
still-populated one has its representative embedding cleared for lazy recompute, and the
**unpublished** proposals the question seeded are deleted — while **published** ones (a
pushed branch / open PR / merged doc) are reported as warnings for a human to handle, never
touched. See [api.md](api.md) for the full request/response shape.

Gap candidates are grouped by gap summary, across the individual gaps of every question, and the reconciler's phase-1 assignment then buckets candidates by **embedding similarity within their flow**: a new gap joins the nearest active cluster whose representative embedding clears `GAP_CLUSTER_ASSIGN_THRESHOLD` (default 0.84; a conservative floor chosen by the offline sweep `npm run eval:gap-threshold` — it collapses near-identical rewordings only, and blank/out-of-range values fall back like the `FLOW_ROUTER_*` knobs), otherwise it seeds a new cluster together with any equally-close new gaps. Without an embedding provider, candidates bucket by exact summary as before; see [architecture.md](architecture.md) for the full mechanism. Answer synthesis asks the model to return structured JSON with `isKnowledgeGap` and a `gaps` array of summaries; `isKnowledgeGap` is reserved for a missed **core** of the question, and each summary becomes its own `auto` gap eligible for grouping. A gap-flagged answer that still substantively answers the core (the model rated itself medium/high and grounded the answer in honoured citations) ships at `medium` — capped below `high`, since a declared gap contradicts "fully answered" — while a gap answer with nothing behind it (self-rated low, no real citations, or empty retrieval) is forced to `low`; the `auto` gaps are emitted either way. This means a single multi-topic question — for example "how do I set this up with React so I can export dashboards?" — records one gap per unanswered topic, so each can cluster with the same gap from other questions and become its own proposal, rather than being condensed into one summary. (The model may still return a single gap, or the legacy singular `gapSummary` string, which is wrapped into a one-element array.)

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
  answer is kept) so a flaky verifier cannot downgrade every answer; out-of-scope
  and already-`low` answers skip the extra call because they already ship
  distrusted, while a gap-flagged **partial** answer (which ships at `medium`) is
  verified like any other `medium` answer.

The model can also mark an answer **out of scope**: when the question is unrelated to the picked flow's subject area — e.g. a question about cats asked of a product flow — it sets `outOfScope`, and the answer is returned at `unknown` confidence with **no gaps at all**. This is distinct from `isKnowledgeGap` ("this flow *should* cover the topic but the docs don't"): an off-topic question is not a gap, so it never clusters or drafts a proposal. The out-of-scope signal rides on the answer result (`outOfScope`) so the console and MCP can surface it distinctly from a low-confidence answer. This is the picked flow's counterpart to the router's `flowSelectionRequired` abstain, which fires earlier when no flow can be chosen at all.

Gaps can also be flagged manually — via the **Knowledge gap** chip in the console, or the MCP `kb_feedback` tool — when the system fails to detect one automatically. A manual flag is separate from helpful/unhelpful feedback (an answer can be helpful and still expose a gap), and a manually-flagged question joins the same gap-candidate clustering and proposal workflow regardless of its answer confidence. Manual flagging adds a `manual` gap (its summary falls back to the question text) alongside any auto-detected gaps; clearing the flag removes only the manual gap and leaves auto-detected gaps intact.

## Unhelpful feedback on a confident answer

`unhelpful` feedback on a **confident** (high/medium) live answer is a strong quality
signal — the user rejected an answer the system believed in — so it feeds gap candidacy
the way followup misses do (#241). Recording the feedback raises a server-side
**`feedback`** gap whose summary falls back to the question text (like the manual flag);
it clusters and drafts through the same candidate workflow as every other gap source.
The mechanics:

- The gap is raised only for **confident** answers. A low/unknown-confidence answer
  already recorded its own `auto` gaps (or was deliberately gap-less, e.g. out of
  scope), so an unhelpful verdict there adds nothing the system does not know.
- Like `verification`, the source is written by the API only — the `answer_question`
  output schema stays narrow to `auto`/`manual`/`followup`.
- A repeated `unhelpful` keeps the existing live row (and its gap id, so any cluster
  membership survives). Flipping the feedback to `helpful` **withdraws** the live
  feedback gap — the signal was retracted — while resolved/dismissed rows are retained
  for audit. Re-answering the question replaces only the answer-derived (`auto` +
  `followup`) gaps; a feedback gap survives alongside `manual`/`verification` rows.
- The console's Insights page charts the helpful/unhelpful trend, with the
  unhelpful-on-confident subset called out (`GET /api/insights/feedback`).

## Multi-turn conversations

`POST /api/ask` (and MCP `kb_ask`) accept an optional `conversationId` (#239). The API mints one
on the first ask and returns it; a client attaches a follow-up by passing it back. Conversations
are stored on the question log itself — `questions.conversation_id` groups the turns of one thread
(migration 0056) — so no separate conversation table exists.

On a follow-up, the API reconstructs bounded prior context **before** enqueueing: the recent
answered live turns (last N, oldest-first, each answer char-capped) and the conversation's **sticky
flow** (the most recent prior turn's flow). Both ride the `answer_question` job input (`priorTurns`,
`conversationFlowId`). Assembly happens in the API; no chat/generative call is made inline
(queue-only).

The watcher **condenses** the follow-up into a self-contained question using those prior turns —
`"what about the EU?"` → `"What is the data retention policy for the EU region?"` — and uses the
condensed form for routing, retrieval, answering, and grounding. Routing is sticky within the
conversation: the sticky flow is used unless the caller pins a `flow` explicitly. Condensation is a
single provider call in the watcher's answer loop that fails safe — on any error it falls back to the
raw follow-up, so a conversation never breaks answering.

**Gap hygiene.** The raw follow-up text (`"what about the EU?"`) is not self-contained, so logging it
verbatim would pollute gap candidacy and clustering. Instead the watcher reports the condensed
standalone form on completion; it is persisted on the question log (`questions.standalone_question`)
and every place a gap summary would otherwise fall back to the raw question text — the `manual` and
`feedback` gap fallbacks — uses the standalone form when present. Follow-ups stay `purpose: "live"`
(they are real user questions that belong in the questions list and gap candidacy); only the *text
used for gaps* changes, not the log's status.

Streaming responses are out of scope: the `202` + `links.wait` model is unchanged.

## Gap-closure verification

Merging a proposal used to *assume* it closed its gaps. It no longer does: a merge is
**verified before it resolves anything**. When a proposal is marked `merged`, the merge
cascade re-indexes the destination and — for any proposal with triggering questions —
enqueues a `verify_gap_closure` job. The API then **re-asks each triggering question**
through the normal queued `answer_question` path against the freshly re-indexed knowledge
base, and applies a deterministic closure test: the question is *closed* only when the
re-ask comes back with a confident answer (`high`/`medium`) that **cites one of the merged
proposal's target documents** (a confident answer citing unrelated docs does not count)
and **raises no `auto` gap of its own** — a substantive partial answer ships at `medium`
while still declaring a whole-question gap, so confidence alone no longer proves the
question was answered gap-free (`followup` gaps do not block closure; they accompany
confident answers by design).
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
- After two failed verifications for the same question (`CLOSURE_RETRY_CAP`), its live
  `verification` gap is stamped **`parkedAt`** (with `parkedReason`), which **parks the
  *whole question*** from gap candidacy and clustering — it stops auto-redrafting and waits
  for a human (see [Parked questions](#parked-questions)). Parking is a first-class *state*
  on the verification gap, not a separate source; the proposal's `closure_status` records
  `needs_attention` as its outcome. The cap counts **distinct proposals** whose re-ask came
  back `still_open`, not raw rows, so a `verify_gap_closure` job retry re-recording the same
  proposal's outcome (the job has no idempotency guard) costs 1 toward the cap however many
  times it retries. The count is also bounded to *since the question's verification lineage
  last reset* — the resolved/dismissed timestamp of the most recent *settled* `verification`
  gap row, if any — so a question parked once and later retried, fixed, or dismissed by a
  human gets a fresh retry budget instead of permanently carrying the old count (see
  `countPriorStillOpen` in `apps/api/src/stores/gap-closure-verification-store.ts` and
  `verificationLineageResetSince` in the proposals service).

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
  no log to attach it to — the proposal's `closure_status` escalates straight to
  `needs_attention` (with a loud warning log) rather than leaving it silently parked at
  `reopened` forever. There is **no parked gap row** in this case (there is no log to attach
  one to), so the proposal is surfaced on the parked-questions listing as a read-only entry
  (`reason: triggering_question_deleted`) instead of a retry/dismiss-able question — see
  [Parked questions](#parked-questions).

Every re-ask is recorded in the `gap_closure_verification` table (verdict, confidence,
whether it cited a merged doc, and the detail) — an append-only audit trail; the retry cap
above is *derived* from it (scoped by distinct proposal + a reset boundary), not a raw tally
of this table's rows. Seed / clusterless proposals have no triggering questions, so nothing
is verified for them (and nothing was ever resolved).

**Verification re-asks are synthetic (`purpose = "verification"`).** Each re-ask records an
ordinary `answer_question` question log so the pipeline is exercised exactly as a user
re-asking would be — but the log is stamped `purpose: "verification"` (question logs default
to `"live"`; questionnaire item asks are stamped `"questionnaire"` — those DO stay in gap
candidacy, because an unanswerable questionnaire question is a real gap, but stay out of the
questions list — see `docs/questionnaires.md`). A verification log records its answer +
citations for the audit trail, but its
answer's gap signals are **not** ingested and it is excluded from gap candidacy, the
questions list, and gap clustering. Otherwise those synthetic logs would re-enter candidacy
under a fresh question id and auto-redraft the very gap that was just parked (issue #154).
The verification job and endpoint are documented in [ai-jobs.md](./ai-jobs.md); the
console surfaces the per-proposal outcome as a closure badge on the Proposals page.

The cascade — and therefore the `verify_gap_closure` enqueue — is idempotent per
proposal: `POST /proposals/:id/status` only schedules it on the actual transition into
`merged` (a repeated or retried request that finds the proposal already merged is a
no-op), and `verifyGapClosure` itself short-circuits once a proposal already carries a
`closureStatus`. Otherwise a duplicated request could re-run the LLM re-asks and record a
second `still_open` row for the same failure, double-counting it against
`CLOSURE_RETRY_CAP`.

**The cascade is also durable, not just idempotent (#282).** The merge status is
persisted synchronously, but the cascade that enqueues `verify_gap_closure` runs off the
request thread — in the fire-and-forget in-process background runner (manual / local-git
merges) or inside the replayable `completeJob` side-effect block (GitHub PR-poll). Either
can be interrupted after the merge is recorded but before verification is enqueued (an API
restart, or an enqueue that throws), which would otherwise strand a proposal permanently
`merged` with unset `closureStatus` and its gaps never verified — after which the
reconciler keeps re-drafting proposals for questions already answered. Two backstops
prevent that permanent orphan, both keyed on the durable *cascade-done marker*
(`mergeCascadeIncomplete`: `merged` + triggering questions + no `closureStatus` + **no
`verify_gap_closure` job in any state**) rather than on the proposal status the transition
guard mutates:

- **Replay-safe PR transition.** `applyPullRequestTransition` re-drives `runMergeCascade`
  when a `completeJob` replay re-invokes it against an already-`merged` proposal whose
  cascade never completed. Keying the guard only on `status === "pr-opened"` (as before)
  let the 500-replay idempotency contract be defeated by the guard's own status write — the
  cascade was dropped forever. Re-driving is a no-op once the verify job has landed.
- **Reconciler sweep.** Each `process_gaps_to_pull_requests` tick sweeps this flow's
  `merged`-but-uncascaded proposals and re-drives their cascade (recorded in the run
  details as `mergedCascadesRecovered`), recovering any orphan the fast path lost —
  including rows orphaned before this backstop existed. `runMergeCascade` is idempotent, so
  a proposal is swept at most once.

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

When the callback POST does exceed the watcher's `maintenanceTimeoutMs`, the watcher
aborts the request and pg-boss retries the `verify_gap_closure` job. To keep the retry
from overlapping the original run — two concurrent runs would enqueue duplicate re-asks
and write duplicate `gap_closure_verification` audit rows — the API threads the request's
`AbortSignal` into `verifyGapClosure`. The abort cancels the in-flight re-ask bounded
waits, and the run checks the signal **before committing any verdict**, so an aborted run
unwinds (throwing `VerificationAbortedError`, mapped to `503`) having written nothing. The
retry is then the only run that records a verdict. This is distinct from the internal
`closure_status` entry guard, which only prevents a *sequential* re-run after the first
has finished — it cannot see an overlap while the first run is still mid-flight (its
`closure_status` is not yet set) (#195).

## Parked questions

When gap-closure verification fails past the retry cap, the question is **parked** — its
live `verification` gap carries a `parkedAt` timestamp (and `parkedReason`), which excludes
the *whole question* from gap candidacy and clustering so it stops auto-redrafting and waits
for a human. Parking is first-class *state*, not a gap source: the "is parked" test is one
predicate (`parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL`), used
identically by candidacy, clustering, and the parked listing.

A human acts on parked questions through the console's **Parked questions** panel (on the
Gaps page; the proposal's "Needs attention" closure badge links here) or the API:

```bash
GET  /api/questions/parked        # parked questions (+ note) and missing-log proposals
POST /api/questions/:id/gap/retry
POST /api/questions/:id/gap/dismiss
```

- **Retry** re-admits the question to the draft pipeline with a **fresh retry budget**. It
  dismisses the live parked row (which becomes the lineage-reset boundary, so
  `countPriorStillOpen` restarts) and re-files a fresh live `verification` row **carrying the
  note**, so the re-draft still sees why the previous attempt fell short — the note lives only
  on the (now-dismissed) verification row, so it would otherwise be lost even though the
  sibling `auto` gap re-drafts. The re-filed row is filed under the surviving live gap's
  summary when exactly one remains, so it dedups into a single candidate rather than forking
  a duplicate. It is never a silent no-op.
- **Dismiss** abandons the **parked topic**: the live gaps sharing the parked summary (the
  verification row + its sibling `auto` gap) are dismissed (`human_dismiss`) and never
  re-cluster. Unrelated topics on a multi-topic question — only hidden by question-level
  parking, never escalated — survive and re-enter candidacy.
- Both are no-ops (returning the current log) on a question that is not parked.

`GET /api/questions/parked` also returns the **missing-log** escalations: a proposal whose
`closure_status` is `needs_attention` but whose triggering question log was deleted before
verification files no parked gap row, so it is surfaced read-only
(`reason: triggering_question_deleted`) rather than as a retry/dismiss-able question.

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
