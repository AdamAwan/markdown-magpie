# Questionnaire mode — design

**Date:** 2026-07-16
**Status:** Proposed
**Problem:** The same questions get asked repeatedly. Security questionnaires arrive in
bulk (50–200 questions a session, heavily overlapping quarter over quarter) and today
each one pays the full ask pipeline and can come back differently worded each time —
which reads badly to the compliance reviewers consuming the answers. Product questions
trickle in repeatedly too, but that's a separate (deferred) concern; see Non-goals.

**Goal:** Verbatim answer consistency for questionnaire-type questions — an equivalent
question gets the *same wording* back until the underlying knowledge actually changes —
with reduced AI spend as a side effect. Never via canned responses: every reused answer
must be provably still valid against the current KB.

## Core principle

**The questionnaire's memory is its own answer history; freshness is inherited from the
KB.** There is no new store of truth, no TTLs, no manually curated canonical answers.
An old answer is reusable exactly when the KB says it is: the sections it was built from
are unchanged AND nothing newer has become relevant to the question. Patrols keep the KB
correct; answers derive their validity from the KB transitively.

## Concepts

- **Questionnaire** — a named batch ("Acme SIG Q3 2026") of ordered question items,
  pinned to a flow at creation (security questionnaires map naturally onto a
  security/compliance flow; pinning slots into flow-scoped authorization and uses the
  existing `requestedFlowId` on `answer_question` input).
- **Item** — one question in a questionnaire. Lifecycle:
  `pending → matched | answering → answered | unanswerable → approved`.
- **Match corpus** — the *approved* items of previous questionnaires in the same flow.
  Approval is the human act that admits an answer into future reuse.

## Lifecycle

### 1. Create

`POST /api/questionnaires` with a name, a flow id, and the question list (console page
takes a paste — one question per line — or a CSV upload; parsing stays deliberately
dumb in v1). Stored as `questionnaires` + `questionnaire_items`.

### 2. Match (inline, embeddings only)

For each item, embed the question (embeddings are the sanctioned inline exception) and
search approved items of prior questionnaires in the same flow by cosine similarity.
Match threshold: near-verbatim only — start at **0.84**, the same conservative bar the
gap-cluster assignment landed on for "near-identical rewordings only" with
text-embedding-3-small; expose as `QUESTIONNAIRE_MATCH_THRESHOLD`. Below the bar the
item is simply unmatched — no fuzzy middle tier in v1.

### 3. Reuse check (the load-bearing bit)

A matched item reuses the prior answer **verbatim** iff both hold:

1. **Cited sections byte-unchanged.** The prior item snapshotted
   `(sectionId, contentHash)` per citation at approval time. Every snapshotted section
   must still exist under the same id with byte-identical content. A vanished id
   (deleted section, or ordinal shift from an upstream edit) counts as changed —
   over-triggering is the safe direction.
2. **No new relevant content.** Run retrieval (the existing hybrid search — inline,
   no chat model, ~one embedding call, often zero via the query LRU) for the question
   against today's index. If any top-k hit above the score floor has
   `content_changed_at` **later than the prior answer's `answered_at`**, reuse is off.
   This is what catches the new-certificate-file case: additions anywhere in the KB
   surface through retrieval scoring, with no watch-lists to maintain. Rankings
   shuffling among old sections can never trigger a refresh; only genuinely newer
   content can.

Outcomes are badged on the item:

- **reused** — both checks pass. Prior answer text copied verbatim onto the item, with
  provenance ("reused from Acme SIG Q2, answered 2026-04-12; sources unchanged").
  Zero AI spend. A reused item carries the **original** `answered_at` forward — the
  generation time is the freshness baseline. (If Q4 compared newcomers against Q3's
  *reuse* time instead, content that changed between Q2 and Q3 but only entered top-k
  at Q4 would slip through; against the original generation time it can't.)
- **changed** — check 1 or 2 failed. Item is re-answered (step 4) and the review UI
  shows the prior answer alongside, with the machine-readable reason: which cited
  section changed, or which newer section entered top-k (path + heading + changed
  date). Wording changes are always explained, never arbitrary.
- Unmatched items are simply **fresh** — answered with no prior context.

Tunables (`k`, score floor) trade token spend against re-answer frequency, never
against correctness: an irrelevant newcomer in top-k costs one unnecessary re-answer.

### 4. Answer (existing pipeline, drip-fed)

Fresh and changed items go through the **existing** `answer_question` job — same
type, queue, watcher runner, prompts, grounding verification. Per item:
`recordAnswerQuestionLog` with a new purpose value `"questionnaire"` (union grows to
`"live" | "verification" | "questionnaire"`), then enqueue with `requestedFlowId` =
the questionnaire's flow. The item stores the question-log id; the existing
completion path fills in answer + citations, and the questionnaire feature reads them
back through the question-log store.

**Purpose semantics for `"questionnaire"`:**

- **Gap candidacy: yes.** An unanswerable questionnaire question is a real knowledge
  gap — this is the flywheel: this quarter's "couldn't answer question 37" becomes a
  gap → proposal → merged doc, and next quarter question 37 answers itself. Gap
  clustering already absorbs a burst of related misses into few clusters.
- **Questions list: excluded** (like verification re-asks) — 200 near-duplicate rows
  would bury the live-ask log. Items are visible on their questionnaire page instead.

**Drip, don't flood.** Items are enqueued progressively, not all at once: the
questionnaire service keeps at most `QUESTIONNAIRE_MAX_INFLIGHT` (default 3) items
in flight per questionnaire, enqueueing the next as each completes. `answer_question`
is interactive-class, so a bulk enqueue would consume the interactive reservation
that protects live asks; the drip keeps a questionnaire from monopolising it.
Progress is asynchronous by design — the user returns to the review page.

### 5. Review, approve, export

The `/questionnaires/:id` console page is a worksheet: each item with its badge
(**reused / fresh / changed / unanswerable**), answer text, citations, and — for
*changed* items — the prior answer and the change reason side by side.

- **Approve** (per item, plus approve-all-reused convenience): marks the item's answer
  as reviewed and snapshots its citation fingerprints
  (`sectionId`, `contentHash`, `path`, `heading`) onto the item. For fresh/changed
  items the fingerprints come from the answer's citations; for reused items, from the
  reused-from item's snapshot (already verified byte-identical by reuse check 1). Approval is what
  admits the item into the match corpus for future questionnaires. Snapshotting at
  approval — into the questionnaire's own tables, not `answer_citations` — matters
  because `answer_citations` rows cascade-delete when a re-index removes a section id;
  the questionnaire must own a durable record of what its answers were built from.
- **Export**: Markdown and CSV of question → answer for the whole questionnaire.
- Unanswerable items stay visible with their gap linkage (the gap/cluster the miss fed)
  so the user can watch the flywheel turn.

## Data model

Migration `00xx_questionnaires.sql` (append-only, per the migration skill):

```sql
CREATE TABLE questionnaires (
  id text PRIMARY KEY,
  name text NOT NULL,
  flow_id text NOT NULL,
  status text NOT NULL DEFAULT 'open',      -- open | completed | archived
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questionnaire_items (
  id text PRIMARY KEY,
  questionnaire_id text NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
  position integer NOT NULL,
  question text NOT NULL,
  question_embedding vector(1536),
  embedding_model text,
  status text NOT NULL DEFAULT 'pending',   -- pending | answering | answered | unanswerable | approved
  outcome text,                             -- reused | fresh | changed (null until decided)
  answer text,
  answered_at timestamptz,
  question_log_id text,                     -- linkage to the ask pipeline for fresh/changed items
  reused_from_item_id text REFERENCES questionnaire_items(id),
  change_reason jsonb,                      -- {kind: 'section_changed'|'new_content', sectionId, path, heading, changedAt}
  approved_at timestamptz,
  UNIQUE (questionnaire_id, position)
);

-- Durable citation fingerprints, snapshotted at approval. Deliberately NOT a FK to
-- document_sections: the fingerprint must survive the section's deletion.
CREATE TABLE questionnaire_item_citations (
  item_id text NOT NULL REFERENCES questionnaire_items(id) ON DELETE CASCADE,
  section_id text NOT NULL,
  content_hash text NOT NULL,
  path text NOT NULL,
  heading text NOT NULL,
  excerpt text NOT NULL,
  PRIMARY KEY (item_id, section_id)
);
```

Plus one KB-side migration + store change (independently useful):

```sql
ALTER TABLE document_sections
  ADD COLUMN content_changed_at timestamptz NOT NULL DEFAULT now();
```

`upsertSections` (`apps/api/src/stores/postgres-knowledge-store.ts`) already computes
"content AND heading byte-identical" to decide embedding carry-forward; the same
condition now also carries `content_changed_at` forward, and resets it to `now()`
exactly when the embedding resets. Backfill: `now()` at migration time — conservative
(briefly suppresses reuse for content that predates the column, i.e. the first
questionnaire after deployment sees slightly fewer reuses; converges immediately after).

`question_embedding` is stamped with `embedding_model` (mirroring migration 0052's
convention): matching only compares vectors from the configured model, and a model
change re-embeds items lazily the next time they're candidates.

## API surface

Feature module `apps/api/src/features/questionnaires/`, mounted at
`/api/questionnaires` (following the existing feature-module pattern):

- `POST /api/questionnaires` — create (name, flowId, questions[]). Runs match + reuse
  checks inline, marks reused items, starts the answer drip. Scope: `ask:knowledge` +
  flow `ask` capability.
- `GET /api/questionnaires` / `GET /api/questionnaires/:id` — list / worksheet detail.
  Flow `read` capability; cross-flow ids read as 404 per the authorization convention.
- `POST /api/questionnaires/:id/items/:itemId/approve` — approve one item
  (snapshot citations). `manage:knowledge` + flow `manage`.
- `POST /api/questionnaires/:id/approve-reused` — bulk-approve all reused items.
- `GET /api/questionnaires/:id/export?format=md|csv` — export.

Rate limiting: creation sits under the `trigger` tier (it fans out work); reads are
normal. The drip governor is the real protection for AI capacity (see step 4).

## Console

One new nav section `/questionnaires` (added to `src/lib/sections.ts`): a list page
(name, flow, progress, reuse rate) and the worksheet detail page described in step 5.
Built from the existing UI primitives (Workbench, ListRow, Badge, etc.); no new CSS.

## What this reuses vs adds

**Reused wholesale:** the entire ask/answer pipeline (`answer_question` job, watcher
runners, agentic retrieval, grounding verification), hybrid retrieval, inline
embeddings + query LRU, gap detection/clustering, flow-scoped authorization, the
feature-module and store patterns.

**Net-new:** two feature tables + one citations table, one `document_sections` column,
one purpose enum value, one feature module, one console section, two config knobs
(`QUESTIONNAIRE_MATCH_THRESHOLD`, `QUESTIONNAIRE_MAX_INFLIGHT`). **No new job type, no
watcher changes, no new prompts.**

## Error handling

- **Answer job fails terminally** → item marked `unanswerable` with the error surfaced
  on the worksheet; the drip governor moves on. Retry is a per-item console action
  (re-enqueue; replay-safe because the item just gets a fresh question-log id).
- **API restart mid-drip** → drip state is derived, not held in memory: on any item
  completion or worksheet read, the service tops the in-flight count back up from
  `pending` items. A questionnaire can never wedge from a lost timer.
- **Section deleted between answering and approval** → approval snapshots from the
  answer's citations (which carry excerpts) plus current section content; if a cited
  section is already gone at approval time, the item is approved but flagged
  `stale-at-approval` — it will never pass reuse check 1, which is correct.
- **Embedding provider down** → creation still works; matching degrades to
  "everything is fresh" (no reuse), mirroring how retrieval degrades to keyword-only.
  Items answer normally.

## Testing

- **Unit** (colocated, `node:test`): match threshold behaviour; reuse-check logic
  (both conditions, each failure mode, vanished-section id, `stale-at-approval`);
  drip governor top-up (including the restart-derivation property); export formatting;
  change-reason construction.
- **Postgres integration** (`RUN_PG_INTEGRATION`, throwaway-container harness):
  migration applies; `content_changed_at` carry-forward vs reset matches the embedding
  carry-forward condition exactly (edit one section of a many-section doc → only that
  section's timestamp moves); citation snapshot survives a re-index that deletes the
  section; approved items become matchable.
- **Queue e2e**: extend `e2e:jobs` with a questionnaire round-trip — create with the
  deterministic provider fixtures, drain, approve, create a second questionnaire with
  an overlapping question, assert verbatim reuse; then touch a cited doc, re-index,
  assert the third pass re-answers with a `section_changed` reason.

## Non-goals (v1)

- **Hot-question promotion for the product-question trickle** — repeated
  confidently-answered live questions clustering into a proposal for a KB doc. Deferred
  as its own design; shares the embedding foundation but is an independent subsystem.
- **Promoting approved answers into KB documents** via the proposal flow. More
  machinery (a proposal per answer, PR round-trips) and it pollutes the retrieval
  corpus ordinary asks ground on. History-as-memory achieves the freshness guarantee
  transitively.
- **Detecting questionnaire-ness in ordinary ask traffic.** Explicit mode only; no
  classifier, no flow-based inference. Revisit only if one-off compliance questions
  between questionnaire seasons prove painful.
- **Source-repo blind spot.** Reuse checks see the *indexed KB*. A new certificate
  sitting un-merged in a source repo is invisible to any reuse check by construction;
  surfacing it is the source-change-sync pipeline's job, not this feature's.
- **Rich questionnaire file parsing** (xlsx portals, PDF forms). Paste/CSV in v1.
- **An "is this answer still complete?" AI verification tier on reuse.** It would
  reintroduce per-reuse token spend; the retrieval newcomer check covers the
  identified mechanism. Reconsider if reuse ever produces a stale answer in practice.
