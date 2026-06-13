# Manual Knowledge-Gap Flagging & MCP Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin manually flag a logged question as a knowledge gap from the web console, and let MCP tool users report feedback (helpful / unhelpful / knowledge gap) against a question via its `questionId`.

**Architecture:** A manual gap is stored as a flag (`manual_gap`) separate from the existing `feedback` enum, reusing the `gap_summary` column for clustering. Gap candidates widen to include manually-flagged questions, so they flow into the existing Gaps panel and proposal workflow unchanged. The MCP `kb_ask` result surfaces the `questionId` already minted by the API; a new `kb.feedback` tool routes feedback to existing/new API endpoints.

**Tech Stack:** TypeScript (Node 22), PostgreSQL, Next.js 15 / React 19, Node's built-in test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-06-13-manual-knowledge-gap-feedback-design.md`

**Conventions observed:**
- Stores have an in-memory and a Postgres implementation behind `QuestionLogStore`.
- The in-memory store holds `QuestionLog` objects directly; clustering reads a `gapSummary` field (added in this plan) so both stores cluster identically.
- API handlers are thin; real logic lives in the stores. Only store logic is unit-tested (HTTP layer has top-level `server.listen`, so it is verified by typecheck/build — matching the existing repo pattern).
- The MCP package has no test harness and imports with side effects (`stdin.on`), so MCP changes are verified by typecheck/build.
- `gap_summary` resolution uses `COALESCE(provided, existing gap_summary, question)` so manually flagging never destroys an auto-detected summary, and falls back to the question text. (This is a deliberate, more-correct refinement of the spec's `summary ?? question`.)

---

## File structure

- `packages/db/migrations/0006_manual_knowledge_gap.sql` — **create**: new columns + index.
- `packages/core/src/index.ts` — **modify**: add `manualGap`, `manualGapAt`, `gapSummary` to `QuestionLog`.
- `apps/api/src/question-log-store.ts` — **modify**: interface + in-memory store methods and clustering.
- `apps/api/src/question-log-store.test.ts` — **create**: unit tests for in-memory store.
- `apps/api/src/postgres-question-log-store.ts` — **modify**: new methods, row mapping, gap-candidate query.
- `apps/api/src/main.ts` — **modify**: `POST`/`DELETE /questions/:id/gap`, CORS `DELETE`.
- `apps/api/package.json` — **modify**: include new test file in `test` script.
- `apps/mcp/src/main.ts` — **modify**: surface `questionId` from `kb.ask`; add `kb.feedback` tool.
- `apps/web/src/app/page.tsx` — **modify**: `manualGap` field, gap-toggle handler, `apiDelete`, chip.
- `docs/api.md`, `docs/mcp.md`, `docs/question-logging.md` — **modify**: document new endpoints/tool/flag.

---

## Task 1: Database migration + core types

**Files:**
- Create: `packages/db/migrations/0006_manual_knowledge_gap.sql`
- Modify: `packages/core/src/index.ts:81-92` (`QuestionLog`)

- [ ] **Step 1: Write the migration**

Create `packages/db/migrations/0006_manual_knowledge_gap.sql`:

```sql
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS manual_gap boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_gap_at timestamptz;

CREATE INDEX IF NOT EXISTS questions_manual_gap_idx ON questions (manual_gap) WHERE manual_gap = true;
```

- [ ] **Step 2: Extend the `QuestionLog` type**

In `packages/core/src/index.ts`, replace the `QuestionLog` interface (currently lines 81-92) with:

```typescript
export interface QuestionLog {
  id: string;
  question: string;
  executionMode: AiExecutionMode;
  chatProvider: string;
  confidence: Confidence;
  retrievedSectionIds: string[];
  askedAt: string;
  answer?: AnswerResult;
  feedback?: QuestionFeedback;
  feedbackAt?: string;
  gapSummary?: string;
  manualGap?: boolean;
  manualGapAt?: string;
}
```

- [ ] **Step 3: Typecheck core**

Run: `npm run typecheck -w @magpie/core`
Expected: PASS (no output / exit 0).

- [ ] **Step 4: Commit**

```bash
git add packages/db/migrations/0006_manual_knowledge_gap.sql packages/core/src/index.ts
git commit -m "feat: add manual knowledge-gap columns and core type fields"
```

---

## Task 2: In-memory store — methods, clustering, tests

**Files:**
- Modify: `apps/api/src/question-log-store.ts`
- Create: `apps/api/src/question-log-store.test.ts`
- Modify: `apps/api/package.json:test`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/question-log-store.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerResult } from "@magpie/core";
import { InMemoryQuestionLogStore } from "./question-log-store.js";

const lowGapAnswer: AnswerResult = {
  answer: "I could not find reliable source material.",
  confidence: "low",
  citations: [],
  gap: { summary: "No source material for: vaccines", question: "vaccines?", confidence: "low", citedSectionIds: [] }
};

test("recordManualGap flags the question and stores the provided summary", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: [] });

  const updated = await store.recordManualGap(log.id, "Adoption process is undocumented");

  assert.equal(updated?.manualGap, true);
  assert.ok(updated?.manualGapAt);
  assert.equal(updated?.gapSummary, "Adoption process is undocumented");
});

test("recordManualGap defaults the summary to the question text", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: [] });

  const updated = await store.recordManualGap(log.id);

  assert.equal(updated?.gapSummary, "How do I adopt?");
});

test("recordManualGap returns undefined for an unknown question", async () => {
  const store = new InMemoryQuestionLogStore();
  assert.equal(await store.recordManualGap("missing"), undefined);
});

test("clearManualGap unsets the flag but keeps the gap summary", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Adoption undocumented");

  const cleared = await store.clearManualGap(log.id);

  assert.equal(cleared?.manualGap, false);
  assert.equal(cleared?.manualGapAt, undefined);
  assert.equal(cleared?.gapSummary, "Adoption undocumented");
});

test("listGapCandidates includes a manually flagged high-confidence question", async () => {
  const store = new InMemoryQuestionLogStore();
  const helpful: AnswerResult = { answer: "Yes.", confidence: "high", citations: [] };
  const log = await store.record({ question: "Partial answer?", executionMode: "direct", chatProvider: "mock", answer: helpful, retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Needs a full guide");

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "Needs a full guide");
  assert.deepEqual(candidates[0].questionIds, [log.id]);
});

test("listGapCandidates still includes auto-detected low-confidence gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  await store.record({ question: "vaccines?", executionMode: "direct", chatProvider: "mock", answer: lowGapAnswer, retrievedSectionIds: [] });

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "No source material for: vaccines");
});

test("listGapCandidates excludes a question whose manual gap was cleared", async () => {
  const store = new InMemoryQuestionLogStore();
  const helpful: AnswerResult = { answer: "Yes.", confidence: "high", citations: [] };
  const log = await store.record({ question: "Partial answer?", executionMode: "direct", chatProvider: "mock", answer: helpful, retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Needs a full guide");
  await store.clearManualGap(log.id);

  assert.equal((await store.listGapCandidates(50)).length, 0);
});
```

- [ ] **Step 2: Wire the new test file into the test script**

In `apps/api/package.json`, change the `test` script from:

```json
"test": "node --import tsx --test src/ai-job-queue.test.ts",
```

to:

```json
"test": "node --import tsx --test src/ai-job-queue.test.ts src/question-log-store.test.ts",
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -w @magpie/api`
Expected: FAIL — `recordManualGap`/`clearManualGap` are not functions, and the high-confidence candidate test fails because clustering still requires `confidence === "low"`.

- [ ] **Step 4: Update the store interface**

In `apps/api/src/question-log-store.ts`, add two methods to the `QuestionLogStore` interface (after `recordFeedback`, around line 7):

```typescript
  recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined>;
  clearManualGap(id: string): Promise<QuestionLog | undefined>;
```

- [ ] **Step 5: Populate `gapSummary` on record/update**

In `InMemoryQuestionLogStore.record`, add `gapSummary` to the constructed log object (after the `answer` line):

```typescript
      answer: input.answer,
      gapSummary: input.answer?.gap?.summary,
      askedAt: new Date().toISOString()
```

In `InMemoryQuestionLogStore.updateAnswer`, add `gapSummary` to the `updated` object (after the `answer` line):

```typescript
      answer: input.answer,
      gapSummary: input.answer.gap?.summary
```

- [ ] **Step 6: Implement `recordManualGap` and `clearManualGap`**

In `apps/api/src/question-log-store.ts`, add these methods to `InMemoryQuestionLogStore` (after `recordFeedback`):

```typescript
  async recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const trimmed = summary?.trim();
    const updated: QuestionLog = {
      ...existing,
      manualGap: true,
      manualGapAt: new Date().toISOString(),
      gapSummary: trimmed || existing.gapSummary || existing.question
    };

    this.logs.set(id, updated);
    return updated;
  }

  async clearManualGap(id: string): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: QuestionLog = {
      ...existing,
      manualGap: false,
      manualGapAt: undefined
    };

    this.logs.set(id, updated);
    return updated;
  }
```

- [ ] **Step 7: Update in-memory clustering**

In `InMemoryQuestionLogStore.listGapCandidates`, replace the grouping loop (currently lines ~77-85) with one that uses `gapSummary` and includes manual gaps:

```typescript
    const groups = new Map<string, QuestionLog[]>();
    for (const log of this.logs.values()) {
      const summary = log.gapSummary;
      if (!summary || (log.confidence !== "low" && !log.manualGap)) {
        continue;
      }

      groups.set(summary, [...(groups.get(summary) ?? []), log]);
    }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run test -w @magpie/api`
Expected: PASS (all tests, including the existing job-queue tests).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/question-log-store.ts apps/api/src/question-log-store.test.ts apps/api/package.json
git commit -m "feat: in-memory store support for manual knowledge-gap flagging"
```

---

## Task 3: Postgres store — methods, row mapping, gap-candidate query

**Files:**
- Modify: `apps/api/src/postgres-question-log-store.ts`

- [ ] **Step 1: Add new methods**

In `apps/api/src/postgres-question-log-store.ts`, add these methods after `recordFeedback` (after line 179):

```typescript
  async recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined> {
    const trimmed = summary?.trim();
    const result = await this.pool.query(
      `
        UPDATE questions
        SET manual_gap = true,
            manual_gap_at = now(),
            gap_summary = COALESCE($2, gap_summary, question)
        WHERE id = $1
      `,
      [id, trimmed && trimmed.length > 0 ? trimmed : null]
    );

    if (result.rowCount !== 1) {
      return undefined;
    }

    return this.get(id);
  }

  async clearManualGap(id: string): Promise<QuestionLog | undefined> {
    const result = await this.pool.query(
      `
        UPDATE questions
        SET manual_gap = false,
            manual_gap_at = null
        WHERE id = $1
      `,
      [id]
    );

    if (result.rowCount !== 1) {
      return undefined;
    }

    return this.get(id);
  }
```

- [ ] **Step 2: Widen the gap-candidate query**

In `listGapCandidates`, replace the `WHERE` clause (currently lines 198-199):

```sql
        WHERE confidence = 'low'
          AND gap_summary IS NOT NULL
```

with:

```sql
        WHERE gap_summary IS NOT NULL
          AND (confidence = 'low' OR manual_gap = true)
```

- [ ] **Step 3: Map the new columns**

In the `QuestionRow` interface (after `feedback_at`), add:

```typescript
  gap_summary: string | null;
  manual_gap: boolean;
  manual_gap_at: Date | null;
```

In `mapQuestionRow`, add these fields to the returned object (after `feedbackAt`):

```typescript
    feedbackAt: row.feedback_at?.toISOString(),
    gapSummary: row.gap_summary ?? undefined,
    manualGap: row.manual_gap,
    manualGapAt: row.manual_gap_at?.toISOString()
```

- [ ] **Step 4: Typecheck the API workspace**

Run: `npm run typecheck -w @magpie/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/postgres-question-log-store.ts
git commit -m "feat: postgres store support for manual knowledge-gap flagging"
```

---

## Task 4: API endpoints

**Files:**
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: Add the route matchers**

In `route()`, immediately after the existing feedback route block (after line 146), add:

```typescript
  const gapMatch = /^\/questions\/([^/]+)\/gap$/.exec(path);
  if (request.method === "POST" && gapMatch) {
    await handleRecordManualGap(gapMatch[1], request, response);
    return;
  }

  if (request.method === "DELETE" && gapMatch) {
    await handleClearManualGap(gapMatch[1], response);
    return;
  }
```

- [ ] **Step 2: Add the handlers**

After `handleQuestionFeedback` (after line 410), add:

```typescript
async function handleRecordManualGap(
  questionId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ summary?: string }>(request);
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;

  const question = await questionLogs.recordManualGap(questionId, summary);
  if (!question) {
    writeJson(response, 404, { error: "question_not_found" });
    return;
  }

  writeJson(response, 200, { question });
}

async function handleClearManualGap(questionId: string, response: ServerResponse): Promise<void> {
  const question = await questionLogs.clearManualGap(questionId);
  if (!question) {
    writeJson(response, 404, { error: "question_not_found" });
    return;
  }

  writeJson(response, 200, { question });
}
```

- [ ] **Step 3: Allow DELETE through CORS**

In `writeJson` (line 625), update the allowed methods header:

```typescript
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
```

- [ ] **Step 4: Typecheck the API workspace**

Run: `npm run typecheck -w @magpie/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/main.ts
git commit -m "feat: API endpoints to set and clear a manual knowledge gap"
```

---

## Task 5: MCP — surface questionId and add kb.feedback

**Files:**
- Modify: `apps/mcp/src/main.ts`

- [ ] **Step 1: Register the kb.feedback tool**

In the `tools` array (after the `kb.search` entry, before the closing `]` at line 66), add:

```typescript
  ,
  {
    name: "kb.feedback",
    description:
      "Report feedback on a previously asked question using the questionId returned by kb.ask. " +
      "kind is 'helpful', 'unhelpful', or 'knowledge_gap'. For 'knowledge_gap', optionally pass " +
      "gapSummary describing the missing knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        questionId: {
          type: "string",
          description: "The questionId returned by kb.ask."
        },
        kind: {
          type: "string",
          enum: ["helpful", "unhelpful", "knowledge_gap"],
          description: "The kind of feedback to record."
        },
        gapSummary: {
          type: "string",
          description: "Optional summary of the missing knowledge. Only used when kind is 'knowledge_gap'."
        }
      },
      required: ["questionId", "kind"],
      additionalProperties: false
    } satisfies JsonSchema
  }
```

- [ ] **Step 2: Route the tool call**

In `callTool`, after the `kb.search` block (after line 179), add:

```typescript
  if (params.name === "kb.feedback") {
    const result = await submitFeedback(params.arguments);
    return textResult(result);
  }
```

- [ ] **Step 3: Surface questionId from kb.ask**

Add `questionId?: string` to the `AskResult` interface (after `gap?: unknown;`, line 218):

```typescript
interface AskResult {
  answer: string;
  confidence: string;
  citations: unknown[];
  gap?: unknown;
  questionId?: string;
}
```

Replace the body of `askQuestion` (lines 232-238) with:

```typescript
  const ask = asObject(await postJson("/ask", { question }));
  const questionId = typeof ask.questionId === "string" ? ask.questionId : undefined;
  const result = ask.result !== undefined ? extractAnswer(ask.result) : await waitForQueuedAnswer(readStatusPath(ask));

  return { ...result, questionId };
```

- [ ] **Step 4: Add the feedback helper and argument parsers**

After the `numberArgument` function (after line 212), add:

```typescript
type FeedbackKind = "helpful" | "unhelpful" | "knowledge_gap";

function feedbackKindArgument(args: Record<string, unknown> | undefined): FeedbackKind {
  const value = args?.kind;
  if (value === "helpful" || value === "unhelpful" || value === "knowledge_gap") {
    return value;
  }

  throw new Error("kind must be one of 'helpful', 'unhelpful', or 'knowledge_gap'");
}

function optionalStringArgument(args: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = args?.[name];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function submitFeedback(args: Record<string, unknown> | undefined): Promise<unknown> {
  const questionId = stringArgument(args, "questionId");
  const kind = feedbackKindArgument(args);

  if (kind === "knowledge_gap") {
    const gapSummary = optionalStringArgument(args, "gapSummary");
    const body = gapSummary ? { summary: gapSummary } : {};
    const response = asObject(await postJson(`/questions/${encodeURIComponent(questionId)}/gap`, body));
    return { questionId, kind, question: response.question };
  }

  const response = asObject(await postJson(`/questions/${encodeURIComponent(questionId)}/feedback`, { feedback: kind }));
  return { questionId, kind, question: response.question };
}
```

- [ ] **Step 5: Typecheck and build the MCP workspace**

Run: `npm run typecheck -w @magpie/mcp && npm run build -w @magpie/mcp`
Expected: PASS (the MCP package has no test harness; typecheck + build is its verification).

- [ ] **Step 6: Commit**

```bash
git add apps/mcp/src/main.ts
git commit -m "feat: MCP kb.feedback tool and questionId in kb.ask result"
```

---

## Task 6: Web UI — knowledge-gap toggle chip

**Files:**
- Modify: `apps/web/src/app/page.tsx`

- [ ] **Step 1: Add `manualGap` to the web `QuestionLog` interface**

In `apps/web/src/app/page.tsx`, add to the `QuestionLog` interface (after `feedback?: Feedback;`, line 133):

```typescript
  feedback?: Feedback;
  manualGap?: boolean;
```

- [ ] **Step 2: Add an `apiDelete` helper**

After `apiPost` (after line 1844), add:

```typescript
async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(`${resolveApiBaseUrl()}${path}`, { method: "DELETE" });
  return readResponse<T>(response);
}
```

- [ ] **Step 3: Add the toggle handler**

After `sendFeedback` (after line 419), add:

```typescript
  async function toggleKnowledgeGap(questionId: string, flagged: boolean) {
    clearMessage();
    try {
      const result = flagged
        ? await apiPost<{ question: QuestionLog }>(`/questions/${questionId}/gap`, {})
        : await apiDelete<{ question: QuestionLog }>(`/questions/${questionId}/gap`);
      setQuestions((current) => current.map((item) => (item.id === questionId ? result.question : item)));
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }
```

- [ ] **Step 4: Pass the handler into `RecentQuestions`**

Find the `<RecentQuestions ... onFeedback={sendFeedback}` usage (around line 651) and add the prop:

```typescript
                    onFeedback={sendFeedback}
                    onToggleGap={toggleKnowledgeGap}
```

- [ ] **Step 5: Accept the prop in `RecentQuestions`**

Update the `RecentQuestions` props (signature at lines 1048-1057). Add to both the destructure and the type:

Destructure (after `onFeedback,`):

```typescript
  onFeedback,
  onToggleGap,
```

Type (after the `onFeedback` line):

```typescript
  onFeedback: (questionId: string, feedback: Feedback) => Promise<void>;
  onToggleGap: (questionId: string, flagged: boolean) => Promise<void>;
```

- [ ] **Step 6: Render the chip**

After the "Unhelpful" button (after line 1098), add:

```typescript
              <button
                className={item.manualGap ? "chip selected" : "chip"}
                onClick={() => void onToggleGap(item.id, !item.manualGap)}
                title="Flag this answer as a knowledge gap the system missed"
                type="button"
              >
                Knowledge gap
              </button>
```

- [ ] **Step 7: Typecheck and build the web workspace**

Run: `npm run typecheck -w @magpie/web && npm run build -w @magpie/web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/page.tsx
git commit -m "feat: web console toggle to manually flag a knowledge gap"
```

---

## Task 7: Documentation

**Files:**
- Modify: `docs/api.md`, `docs/mcp.md`, `docs/question-logging.md`

- [ ] **Step 1: Document the API endpoints**

In `docs/api.md`, near the existing `POST /questions/:id/feedback` documentation, add entries describing:
- `POST /questions/:id/gap` — body `{ "summary"?: string }`; flags the question as a manual knowledge gap (summary defaults to the existing gap summary, then the question text); returns `{ question }`; `404` if not found.
- `DELETE /questions/:id/gap` — clears the manual flag (leaving any auto-detected `gap_summary`); returns `{ question }`; `404` if not found.

Note that manually-flagged questions appear in `GET /gaps/candidates` regardless of answer confidence.

- [ ] **Step 2: Document the MCP tool**

In `docs/mcp.md`, add a `kb.feedback` section: parameters `questionId` (from `kb.ask`), `kind` (`helpful` | `unhelpful` | `knowledge_gap`), optional `gapSummary`. Note that `kb.ask` results now include `questionId` for this round-trip.

- [ ] **Step 3: Document manual gaps in question logging**

In `docs/question-logging.md`, note that gaps can be flagged manually (via the console chip or `kb.feedback`) in addition to automatic detection, that manual flagging is separate from helpful/unhelpful feedback, and that manual gaps feed the same gap-candidate clustering and proposal workflow.

- [ ] **Step 4: Commit**

```bash
git add docs/api.md docs/mcp.md docs/question-logging.md
git commit -m "docs: document manual knowledge-gap flagging and kb.feedback"
```

---

## Task 8: Full validation

- [ ] **Step 1: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Build the whole repo**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Run all workspace tests**

Run: `npm run test`
Expected: PASS (api job-queue + question-log-store tests, retrieval, markdown).

---

## Self-review

**Spec coverage:**
- Manual flag separate from feedback → Task 1 (columns + type), Task 2/3 (stores). ✓
- Optional summary defaulting to question → Task 2 Step 6, Task 3 Step 1 (COALESCE). ✓
- Manual gaps surface in candidates/proposals → Task 2 Step 7, Task 3 Step 2. ✓
- API set/clear endpoints + 404 → Task 4. ✓
- MCP questionId round-trip + kb.feedback routing → Task 5. ✓
- Web toggle chip → Task 6. ✓
- Tests → Task 2; docs → Task 7; validation → Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full content. ✓

**Type consistency:** `manualGap`/`manualGapAt`/`gapSummary` used identically across core type, both stores, API, and web. `recordManualGap(id, summary?)` / `clearManualGap(id)` signatures match interface, in-memory, Postgres, and call sites. MCP `FeedbackKind` values match the API `feedback` enum (`helpful`/`unhelpful`) and the gap route. ✓
