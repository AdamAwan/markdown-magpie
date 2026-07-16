# Questionnaire MCP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose questionnaire mode (docs/questionnaires.md, PR #276) through the MCP
server (`apps/mcp`) so MCP clients can create questionnaires, read worksheets, and
approve answers into the match corpus.

**Architecture:** Three new `kb_*` tools following the existing seven-tool pattern
exactly — `apps/mcp` is a thin client over the HTTP API (`kb-client.ts` does the HTTP,
`main.ts` registers tools for stdio, `http.ts` maps per-tool OAuth scopes for the HTTP
transport). No API changes: the questionnaire routes shipped in PR #276.

**Tech Stack:** TypeScript ESM/NodeNext, MCP SDK (as already used in apps/mcp),
node:test.

## Global Constraints

- Relative imports carry explicit `.js` extensions; never cast through `unknown`/`any`.
- Validate as you go (`npm run build`, `npm run typecheck`, `npm run lint`,
  `npm run deadcode`, `npm test -w apps/mcp`); commit little and often.
- knip is STRICT: de-export anything only used in-file.
- Branch: continue on `claude/repeated-questions-efficiency-02f0b3` (PR #276) or a
  stacked branch — the API surface this consumes is on that branch, NOT on main yet.

## The three tools

| Tool | API call(s) | Scope (http.ts map) | Returns |
|---|---|---|---|
| `kb_questionnaire_create` | `POST /questionnaires` `{name, flowId, questions[]}` | `ask:knowledge` | created questionnaire (id + per-item statuses; reused items already carry answers) |
| `kb_questionnaire_get` | `GET /questionnaires/:id` | `read:knowledge` | full worksheet (items with status/outcome/answer/changeReason/citations) |
| `kb_questionnaire_approve` | `POST /questionnaires/:id/approve-reused` or `POST /questionnaires/:id/items/:itemId/approve` (when `item` argument given) | `manage:knowledge` | `{approved}` or `{ok}` |

Notes that shape the design:

- **Create is asynchronous by design.** Fresh/changed items drip through the
  `answer_question` queue; the create response legitimately contains
  `pending|answering` items. Do NOT poll to completion inside the tool by default —
  return immediately and tell the model (in the tool description) to re-read with
  `kb_questionnaire_get` until no items are `pending|answering`. (Contrast with
  `generateOutline` in kb-client.ts:520, which does poll — outlining is one job;
  a questionnaire can be 200.)
- Flow ids are discoverable with the existing `kb_flows` tool — reference it in the
  create tool's description the way `kb_outline`'s description references it.
- Questions argument: `questions: string[]` (1–500), mirroring the route schema
  (`apps/api/src/features/questionnaires/schema.ts`).

### Task 1: kb-client functions

**Files:**
- Modify: `apps/mcp/src/kb-client.ts`
- Test: `apps/mcp/src/kb-client.test.ts` (existing harness pattern: it stubs fetch —
  follow how approveSeedPlan/generateOutline are tested)

**Interfaces (produces):**

```ts
export async function createQuestionnaire(args, options?): Promise<QuestionnaireView>
// args: { name: string; flow: string; questions: string[] }  → POST /questionnaires
export async function getQuestionnaire(args, options?): Promise<QuestionnaireView>
// args: { questionnaire: string }                            → GET /questionnaires/:id
export async function approveQuestionnaire(args, options?): Promise<{ approved: number } | { ok: true }>
// args: { questionnaire: string; item?: string }
```

`QuestionnaireView` = the API's questionnaire JSON passed through with light shaping:
keep `id, name, flowId, status, items[{position, question, status, outcome, answer,
changeReason, citations[{path, heading}]}]` — drop embeddings/log ids the model has no
use for. Reuse the existing `stringArgument`/`optionalStringArgument`/`asObject`
helpers; add a `stringArrayArgument` helper if one doesn't exist (check first).

- [ ] Failing tests (arg validation, happy path per function, API-error passthrough) →
      implement → `npm test -w apps/mcp` → commit `feat(mcp): questionnaire kb-client`.

### Task 2: stdio tool registration (main.ts)

**Files:** Modify `apps/mcp/src/main.ts` — add three tool definitions to the tool list
(JSON Schema `inputSchema`, `satisfies JsonSchema`, like `kb_outline` at main.ts:132)
and three `if (params.name === …)` dispatch branches (like `kb_seed` at main.ts:339).
Test: extend `apps/mcp/src/main.test.ts` (tools/list contains the new names; call
dispatch reaches the client fns).

Description copy (tune for model consumption):
- create: "Create a questionnaire — a named batch of questions answered against one
  flow's knowledge base, with verbatim reuse of previously approved answers when the
  KB hasn't changed. Returns immediately; items may still be answering — re-read with
  kb_questionnaire_get until no items are pending/answering. Discover flow ids with
  kb_flows."
- get: "Read a questionnaire worksheet: per-item status (reused/fresh/changed/
  unanswerable), answers, citations, and change explanations."
- approve: "Approve answers into the match corpus for future questionnaires: all
  reused items (default) or one item by id."

- [ ] Failing tests → implement → run mcp tests → commit `feat(mcp): questionnaire tools (stdio)`.

### Task 3: HTTP transport scopes + docs

**Files:**
- Modify: `apps/mcp/src/http.ts` — add the three tools to the per-tool scope map
  (http.ts:30-37: `kb_questionnaire_create: "ask:knowledge"`,
  `kb_questionnaire_get: "read:knowledge"`,
  `kb_questionnaire_approve: "manage:knowledge"`) and to the registered-tools list
  (http.ts:205 area, zod schemas mirroring Task 2's JSON schemas).
- Test: `apps/mcp/src/http.test.ts` — scope enforcement per new tool (existing pattern:
  wrong scope → rejected, right scope → dispatched).
- Docs: `docs/mcp.md` (seven tools → ten; add rows), `docs/questionnaires.md` (add an
  MCP section), `.claude/skills/magpie-orientation/SKILL.md` §2.19 ("seven tools" →
  "ten tools" + names).

- [ ] Failing tests → implement → full validation sweep (build/typecheck/lint/deadcode/
      tests) → commit `feat(mcp): questionnaire tool scopes + docs`.

### Task 4: live verification

- [ ] Run the stack (run-magpie skill; NOTE: second watcher needs
      `WATCHER_HEALTH_PORT=4003`). Start `apps/mcp` stdio against the local API and
      drive: `kb_questionnaire_create` on the flowerbi flow (2 questions, one matching
      an approved prior) → `kb_questionnaire_get` until settled → assert one item
      `reused` → `kb_questionnaire_approve`. Screenshot/transcript on the PR.

## Context for a fresh session

- Feature reference: `docs/questionnaires.md`. API routes:
  `apps/api/src/features/questionnaires/routes.ts`. Everything is on branch
  `claude/repeated-questions-efficiency-02f0b3` / PR #276.
- The MCP server uses a separate M2M credential downstream + on-behalf-of headers
  (docs/mcp.md); nothing questionnaire-specific needed there — the pattern is uniform.
- The magpie-orientation skill's §1/§2 explain the queue-only model; questionnaire
  create fans out `answer_question` jobs a watcher must serve, so live verification
  needs the full stack.
