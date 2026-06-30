# Caller-specified flow with "unknown" routing

## Problem

Today every question is routed to exactly one flow by `routeQuestionToFlow`, and
the router prompt is forced to always guess ("If no flow clearly matches, pick the
closest one and set confidence to low."). Callers have no way to pin a question to
a known flow, and the router can never admit it doesn't know.

We want:

1. The question router to be able to respond **"unknown"** instead of guessing.
2. Callers (UI and MCP) to be able to **specify a flow**, with **`auto`** the
   default (= run the router as today).
3. When `auto` routing yields "unknown", **refuse to answer** and ask the caller to
   pick a flow, returning the list of configured flows.

## Current pipeline (for reference)

- UI / MCP → `POST /ask { question }` → API records a `QuestionLog`, enqueues an
  `answer_question` job carrying **all** flows → returns `202` + job links.
- The watcher's `answer()` calls `routeQuestionToFlow(question, flows, model)`,
  which returns a `FlowRouteDecision` or `undefined` (→ unscoped retrieval across
  everything), then retrieves scoped context and answers.
- MCP `kb.ask` posts `/ask` and polls the job to a terminal state, returning
  `{ answer, confidence, citations, gaps, questionId }`.
- The UI `AskPanel` reads the answer back off the logged question once the job
  completes.

## Decisions

### 1. Three routing outcomes (not two)

`routeQuestionToFlow` returns a discriminated result:

- **`routed`** — a flow was chosen (or only one flow is configured, the existing
  short-circuit).
- **`unknown`** — the model *deliberately* says no flow matches → **refuse + list
  flows**.
- **`unroutable`** — provider error, unparseable output, a model-named id that is
  not configured, or **zero** flows configured → **degrade to today's unscoped
  answer**.

Rationale: refusing on infrastructure failure is a worse, more confusing failure
mode and breaks the existing "routing must never fail the ask" contract. Only a
deliberate model "unknown" triggers a refusal. A *low-confidence* pick still
answers — only an explicit "no match" refuses.

With `requestedFlowId` set (an explicit caller choice), routing is skipped entirely
and the result is `routed` with that id.

### 2. Refusal is a successful completion, not a failure

When routing is `unknown`, the `answer_question` job still **completes
successfully**. Its output carries a new structured field:

```ts
flowSelectionRequired?: { availableFlows: Array<{ id: string; name: string }> }
```

When present: `answer` is a short human-readable note ("I could not determine which
knowledge area this question belongs to. Please choose a flow."), `confidence` is
`"unknown"`, and `citations` is empty. The UI and MCP key off the structured field,
not the prose.

This reuses the existing completion → `QuestionLog` path; no new job state. The
"unknown" log is left as-is — **re-asking with an explicit flow creates a fresh
question/job** rather than mutating the original.

## Changes by layer

### `@magpie/core` (`packages/core/src/index.ts`)
- `AnswerQuestionJobInput`: add `requestedFlowId?: string` (absent = `auto`).
- `AnswerQuestionJobOutput` and `AnswerResult`: add
  `flowSelectionRequired?: { availableFlows: Array<{ id: string; name: string }> }`.

### `@magpie/prompts` (`packages/prompts/src/catalog.ts`)
- `ROUTE_QUESTION_TO_FLOW`: replace "If no flow clearly matches, pick the closest
  one and set confidence to low." with an instruction to return `"flowId": null`
  when no flow clearly matches. Update `outputShape` accordingly.

### `@magpie/retrieval` (`packages/retrieval/src/routing.ts`)
- Change the return type from `FlowRouteDecision | undefined` to a discriminated
  union:
  ```ts
  export type FlowRoute =
    | { status: "routed"; flowId: string; confidence: Confidence; rationale?: string }
    | { status: "unknown" }
    | { status: "unroutable" };
  ```
- `0` flows → `unroutable`; `1` flow → `routed`. Provider error / unparseable / bad
  id → `unroutable`. Model returns `flowId: null` → `unknown`.
- Update `routing.test.ts`.

### `@magpie/jobs` (`packages/jobs/src/schemas.ts`)
- `answerQuestionInputSchema`: add `requestedFlowId: z.string().optional()`.
- `answerQuestionOutputSchema`: add optional `flowSelectionRequired` object.

### `apps/watcher` (`src/runners/generative.ts`, `src/job-prompts.ts`)
- `answer()`: if `input.requestedFlowId` is set, use it directly (skip routing);
  else route. On `unknown`, return a selection-required output built from the input
  flows. On `routed`/`unroutable`, behave as today (`unroutable` → unscoped).
- Add a `buildFlowSelectionRequiredOutput(flows)` helper in `job-prompts.ts`.
- Update `generative` / `job-prompts` tests.

### `apps/api`
- `features/ask/schema.ts`: `askBodySchema` gains `flow: z.string().optional()`
  (treated as `"auto"` when absent).
- `features/ask/service.ts`: `ask(ctx, question, flow)` — when `flow` is set and not
  `"auto"`, validate it against `ctx.knowledgeConfig.flows`; unknown id → throw a
  `400 unknown_flow`. Pass `requestedFlowId` into the job input.
- `features/ask/routes.ts`: read `flow` from the validated body, map a bad id to
  `400`.
- **New** `GET /knowledge/flows` (scope `read:knowledge`) → `{ flows: [{ id, name }] }`
  from `ctx.knowledgeConfig.flows`, for MCP discovery. (UI already gets flows via
  the admin `/config` endpoint.)
- Update `ask/service.test.ts` and knowledge route tests.

### `apps/mcp` (`src/http.ts`, `src/main.ts` if present, `src/kb-client.ts`)
- `kb.ask`: add `flow: z.string().optional()` describing `auto` default; pass it to
  `POST /ask`. When the terminal output has `flowSelectionRequired`, return a
  structured payload (`{ flowSelectionRequired: true, availableFlows, questionId }`)
  instead of an answer, and document in the tool description that the caller should
  re-call `kb.ask` with `flow` set.
- **New** `kb.flows` tool (scope `read:knowledge`) → `GET /knowledge/flows`. Add to
  `TOOL_SCOPES`.
- `kb-client.ts`: `askQuestion(question, options, flow?)` posts `flow`; `AskResult`
  gains optional `flowSelectionRequired` + `availableFlows`; add a `listFlows()`
  helper.

### `apps/web` (`components/AskPanel.tsx`, `components/ConsoleProvider.tsx`)
- `ConsoleProvider`: hold `askFlow` state (default `"auto"`); `ask()` posts
  `{ question, flow: askFlow }`; pass `flows` (from `knowledgeFlows(config)`),
  `askFlow`, `setAskFlow`, and a re-ask handler into `AskPanel`.
- `AskPanel`: a flow `<select>` next to the question form, first option **Auto**,
  then one per flow. When a logged answer carries `flowSelectionRequired`, render an
  inline picker ("I couldn't tell which area this fits — choose one:") that re-asks
  with the chosen flow.

## Testing

- `routing.test.ts`: routed / unknown (model `flowId: null`) / unroutable (error,
  bad id, zero flows) / single-flow short-circuit.
- watcher `generative` tests: `requestedFlowId` skips routing; `unknown` emits
  selection-required; `unroutable` answers unscoped.
- `ask/service.test.ts`: explicit valid flow → `requestedFlowId` set; unknown flow →
  `400`; absent/`auto` → no `requestedFlowId`.
- knowledge route test: `GET /knowledge/flows` shape + scope.
- web: AskPanel renders the selector and the re-ask picker on
  `flowSelectionRequired`.

## Out of scope (YAGNI)

- No numeric confidence threshold that auto-refuses low-confidence picks — refusal
  is driven solely by the model's explicit "unknown".
- No mutation/linking of the original "unknown" question log when re-asked.
- No new job state — refusal is an ordinary successful completion.
