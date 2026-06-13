# Manual Knowledge-Gap Flagging & MCP Feedback — Design

**Date:** 2026-06-13
**Status:** Approved

## Goal

Three related capabilities:

1. Let an admin, via the web console, manually mark a logged question/answer as a
   **knowledge gap** when the system failed to detect one automatically.
2. Let the MCP tooling user **report feedback** (helpful, unhelpful, or knowledge
   gap) back against a previously-asked question.
3. To support (2), surface the **`questionId`** through the MCP `kb_ask` tool so it
   can be passed back and forth between asking and giving feedback.

## Key decision: gap is a separate axis from feedback

`feedback` (`helpful | unhelpful`) describes answer *quality*. A knowledge gap
describes content *coverage*. These are orthogonal: an answer can be `helpful`
(gives enough to help the user) and still expose a gap (could not give a full
answer). Therefore the manual gap flag is stored **separately** from `feedback`,
not folded into the feedback enum.

## 1. Data model

New migration `packages/db/migrations/0006_manual_knowledge_gap.sql`:

```sql
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS manual_gap boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_gap_at timestamptz;
```

The existing `gap_summary` column is reused for the summary text. `feedback` /
`feedback_at` are untouched.

Core type `QuestionLog` (`packages/core/src/index.ts`) gains:

- `manualGap?: boolean`
- `manualGapAt?: string`

## 2. How manual gaps surface in existing workflows

`listGapCandidates` currently clusters questions `WHERE confidence = 'low'`. It is
widened to:

```sql
WHERE gap_summary IS NOT NULL AND (confidence = 'low' OR manual_gap = true)
```

A manually-flagged item then flows into the existing Gaps panel and the existing
"Draft Proposal" workflow with no new downstream plumbing.

When flagging, `gap_summary` is set to the provided summary, or falls back to the
question text when no summary is supplied (the "optional, defaults to question"
choice).

## 3. API

New endpoints in `apps/api/src/main.ts`:

- `POST /questions/:id/gap` — body `{ summary?: string }`.
  Sets `manual_gap = true`, `gap_summary = summary ?? question`,
  `manual_gap_at = now()`. Returns the updated `QuestionLog`. Returns `404` if the
  question does not exist (mirrors the feedback handler).
- `DELETE /questions/:id/gap` — clears the manual flag (`manual_gap = false`,
  `manual_gap_at = null`). Leaves any auto-detected `gap_summary` intact so an
  auto-detected gap is not lost by un-flagging a manual one. Enables a clean UI
  toggle.

New store methods on both the Postgres and in-memory question-log stores:

- `recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined>`
- `clearManualGap(id: string): Promise<QuestionLog | undefined>`

## 4. MCP

In `apps/mcp/src/main.ts`:

- `kb_ask` result gains **`questionId`**, captured from the API response. In queue
  mode the id is taken from the initial `202` response and retained across the
  poll loop, so it survives until the answer completes.
- New tool **`kb_feedback`** with input schema:

  ```json
  {
    "questionId": "string (required)",
    "kind": "helpful | unhelpful | knowledge_gap (required)",
    "gapSummary": "string (optional)"
  }
  ```

  Handler routing:
  - `helpful` / `unhelpful` → `POST /questions/:id/feedback`
  - `knowledge_gap` → `POST /questions/:id/gap` with `{ summary: gapSummary }`

  Returns a short confirmation. Invalid `kind` is rejected with a clear error.

## 5. Web UI

In the question-log list (`apps/web/src/app/page.tsx`), add a third toggle chip
**"Knowledge gap"** beside the existing Helpful / Unhelpful chips, bound to
`manualGap`. Clicking toggles via `POST` / `DELETE /questions/:id/gap` and updates
the local question state from the response. The Gaps panel then reflects the
flagged item automatically (see section 2).

## 6. Testing

Following existing test patterns:

- Store methods: `recordManualGap` / `clearManualGap` on the in-memory store (and
  Postgres store where covered), including summary fallback to question text.
- API handlers: set gap, clear gap, `404` for unknown id, `gap_summary` fallback.
- `listGapCandidates`: a manually-flagged high-confidence question appears as a
  candidate.
- MCP: `kb_feedback` routes each `kind` to the correct endpoint; `kb_ask` result
  includes `questionId`.

## Assumptions

- The web console is admin-only by deployment (no auth layer exists today), so
  "admin via UI" means the existing console. No new auth is added.
- Work happens in the `worktree-manual-knowledge-gap-feedback` worktree.
