# AI cost charts: plot cost, not tokens — design

Date: 2026-07-15
Status: approved (brainstorm)
Related: #241 (AI token usage & cost), `docs/insights-charts.md` (C11, AI cost by flow, per-schedule cost)

## Problem

The **AI token usage & cost** card (`AiUsageChart`) and its sibling **AI cost by
flow** card (`AiCostByFlowChart`) are titled and headlined around *cost*, but the
bars encode *tokens*. Input and output tokens are priced at different per-MTok
rates, and every model has its own rate, so **bar height is not proportional to
spend** — the tallest bar can be the cheapest job. Cost is exiled to a header
total and a tooltip line, by an explicit earlier decision ("cost rides text…
never a series colour or a second y-axis").

Symptoms visible on a live instance:

- The card reads **"No priced usage · 0 priced · 2 unpriced · 13 unmetered"** —
  the cost promise is unfulfilled because no `AI_PRICING` entry matches the
  running models, and the chart gives no guidance to fix that.
- 13 of 15 categories are empty (unmetered CLI providers), yet each still claims
  an x-axis slot, so the plot is mostly whitespace.
- The (job type · provider · model) category labels are long, repetitive, and
  rendered rotated and clipped; the legend floats over the plot.

This reverses the earlier "cost rides text" decision on purpose: for a card whose
job is "what is costing me money", cost belongs on the primary axis.

## Goals

1. **Plot cost.** Bar length = real spend, so the biggest bar is the biggest cost.
2. **Tokens move to the tooltip** (input / output / total).
3. **Degrade gracefully when sparse.** Unmetered rows leave the plot (footnote);
   unpriced rows surface as an actionable coverage nudge naming the
   `(provider, model)` pairs to price; a first-class empty state replaces a wall
   of empty bars when nothing is priced.
4. **Keep the two cost cards consistent** by construction — share one component.

## Non-goals

- Cost-over-time. No time-bucketed cost endpoint exists; that is a separate
  feature (would need a new `bucketStart`-keyed rollup like the trend charts).
- Configuring `AI_PRICING`. Operator's choice; out of scope for this work.

## Design

### Backend: cost split by direction (structured object)

Cost is computed at read time (never persisted) in
`postgres-insights-store.ts#priceUsageRow` via
`ai-pricing.ts#estimateTokenCost`, which already computes
`(inputTokens × inputPerMTok + outputTokens × outputPerMTok) / 1e6`.

Introduce a structured cost type in `@magpie/core` and thread it through in place
of the bare `number`:

```ts
export interface AiCostEstimate {
  input: number;  // inputTokens × inputPerMTok / 1e6
  output: number; // outputTokens × outputPerMTok / 1e6
  total: number;  // input + output
}
```

- `estimateTokenCost(...)` returns `AiCostEstimate | undefined` (undefined for a
  NULL model or an unmatched `(provider, model)` — the *unpriced* signal is
  unchanged; only its shape when present changes).
- `estimatedCost?: number` → `estimatedCost?: AiCostEstimate` on
  `AiUsageBreakdown`, `AiCostByFlow`, and `AiScheduleCost`. The present-iff-priced
  invariant is unchanged and still documented on `AiUsageBreakdown`.
- `summariseAiCost` (`cost.ts`) sums `.input`/`.output`/`.total` across the
  priced rows into one `AiCostEstimate`, present iff `anyPriced`.
- `service.ts` cost sort: `(b.estimatedCost?.total ?? 0) - (a.estimatedCost?.total ?? 0)`.

Chosen over adding parallel `estimatedInputCost?`/`estimatedOutputCost?` optionals
because the structured object makes the "all three or none" invariant unrepresentable-if-broken,
matches the repo's "fix the types properly" rule, and the wider blast radius is
mechanical and fully enumerated below.

### Frontend: one shared cost-bar chart

`AiUsageChart` and `AiCostByFlowChart` are near-identical today (same stacked-token
idiom, same summary header, same tooltip shape). Extract the rendering into a new
`apps/web/src/components/insights/CostBarChart.tsx`; both cards feed it their rows
plus a small adapter (label accessor + any extra tooltip lines). The shared
component:

- **Horizontal** bars (recharts `layout="vertical"`; numeric value axis, category
  label axis) so labels read left-to-right with room to breathe.
- Bar length = **cost**: `estimatedCost.input` + `estimatedCost.output` stacked
  (both money → total length = total spend). Legend "Input cost / Output cost",
  positioned outside the plot area.
- **Plots only priced rows** (those carrying an `AiCostEstimate`, including a
  legitimate zero-cost free-model row → a zero-length bar). Unmetered rows are
  excluded and summarised in a footnote (e.g. "13 unmetered jobs — CLI providers
  report no usage"). *Unpriced* rows (usage but no price) are excluded from the
  bars but named in a coverage line: "N unpriced — add an AI_PRICING entry for:
  `provider · model`…".
- **Tooltip** carries input/output/total tokens and the priced/unpriced/unmetered
  job counts (the existing three-state honesty).
- **Empty state**: when nothing is priced, render the CTA (coverage line naming
  the unpriced pairs + `AI_PRICING` hint) instead of an empty plot.
- Cost formatting stays via `format.ts#formatCost`.

`AiCostByFlowChart` keeps all flows (few in number); a flow with no priced usage
shows a zero-length bar marked "no priced usage" in its tooltip, consistent with
the per-bar honesty it has today.

`SchedulesPanel.tsx` "Cost (30d)" column: `formatCost(cost.estimatedCost.total)`.

## Affected files

Backend
- `packages/core/src/index.ts` — add `AiCostEstimate`; retype `estimatedCost` on
  `AiUsageBreakdown`, `AiCostByFlow`, `AiScheduleCost`; update doc-comments.
- `apps/api/src/platform/ai-pricing.ts` — `estimateTokenCost` returns
  `AiCostEstimate | undefined`.
- `apps/api/src/stores/postgres-insights-store.ts` — `priceUsageRow` builds the
  object.
- `apps/api/src/features/insights/cost.ts` — `summariseAiCost` object sum.
- `apps/api/src/features/insights/service.ts` — sort by `.total`.

Frontend
- `apps/web/src/components/insights/CostBarChart.tsx` — new shared component.
- `apps/web/src/components/insights/AiUsageChart.tsx` — render via shared component.
- `apps/web/src/components/insights/AiCostByFlowChart.tsx` — render via shared component.
- `apps/web/src/components/SchedulesPanel.tsx` — `.estimatedCost.total`.

Tests
- `apps/api/src/platform/ai-pricing.test.ts` — breakdown shape.
- `apps/api/src/features/insights/cost.test.ts` — object sum.
- `apps/api/src/stores/postgres-insights-store.integration.test.ts` — priced row shape.
- `apps/web/src/components/insights/AiUsageChart.test.tsx` — cost bars, empty state, tokens-in-tooltip.
- `apps/web/src/components/insights/AiCostByFlowChart.test.tsx` — same.
- `apps/web/src/components/SchedulesPanel.test.tsx` — `.total`.

Docs
- `docs/insights-charts.md` — rewrite the C11 / AI-cost-by-flow / per-schedule
  entries: cost is now the bar (input-cost + output-cost stacked), tokens in the
  tooltip, plus the empty/coverage state. Explicitly note this supersedes the
  earlier "cost rides text… never a second axis" decision.

## Testing strategy

- Unit (node:test) for `estimateTokenCost` breakdown and `summariseAiCost` sum,
  including the free-local-vLLM zero-rate row (`input: 0, output: 0, total: 0` is
  *priced*, distinct from unpriced/undefined).
- Component tests (existing harness) assert: bars bind to cost not tokens; tokens
  appear only in the tooltip; unmetered rows are excluded and footnoted; the empty
  state renders the CTA naming unpriced pairs.
- Integration test asserts a priced row carries the `{ input, output, total }`
  object with `total === input + output`.

## Risks

- **Blast radius of the retype.** Mechanical but wide (every `estimatedCost`
  consumer). Mitigated by the enumerated file list and by TypeScript flagging each
  site; validate with `npm run typecheck` early and often.
- **Empty-by-default.** With no `AI_PRICING` configured the chart is honestly
  empty — the empty-state CTA is what makes that a feature, not a regression.
