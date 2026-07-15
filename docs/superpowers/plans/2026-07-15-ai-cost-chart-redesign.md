# AI Cost Charts: Plot Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two AI-cost insight cards plot *cost* (input-cost + output-cost stacked, horizontal) with tokens moved to the tooltip, backed by a structured `AiCostEstimate` cost type.

**Architecture:** Read-time cost gains a `{ input, output, total }` shape carried on the rollup types. The two near-identical cost cards render through one shared presentational `CostBarChart`. Cost is computed exactly as before (never persisted); only its shape and where it is displayed change.

**Tech Stack:** TypeScript (ESM/NodeNext, Node ≥22.13), npm workspaces, Recharts + Emotion (web), `node:test` (all tests).

## Global Constraints

- Never cast through `unknown`/`any` to silence types — fix types properly.
- No hacky workarounds — fix the root cause.
- Validate as you go: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` — don't batch.
- Commit little and often; update docs alongside code.
- Cost is computed at read time from `AI_PRICING` and never persisted.
- The priced/unpriced/unmetered invariant is unchanged: `estimatedCost` present ⇔ *priced* (a matched `(provider, model)`, including a legitimate zero-rate free model).

---

### Task 1: Structured `AiCostEstimate` cost model (backend + compile-safe consumer updates)

Introduce the object cost type and thread it through every `estimatedCost` consumer. Behaviour is unchanged — the charts still draw token bars in this task (they just read `.total`). This is a pure, fully-green refactor and the review checkpoint before any visual change.

**Files:**
- Modify: `packages/core/src/index.ts` (add type; retype 3 interfaces; update doc-comments)
- Modify: `apps/api/src/platform/ai-pricing.ts` (`estimateTokenCost` returns the object)
- Modify: `apps/api/src/stores/postgres-insights-store.ts:882-901` (`priceUsageRow`)
- Modify: `apps/api/src/features/insights/cost.ts` (`summariseAiCost` object sum)
- Modify: `apps/api/src/features/insights/service.ts:121` (sort by `.total`)
- Modify: `apps/web/src/lib/types.ts:308-311` (re-export `AiCostEstimate`)
- Modify: `apps/web/src/components/insights/AiUsageChart.tsx` (read `.total`)
- Modify: `apps/web/src/components/insights/AiCostByFlowChart.tsx` (read `.total`)
- Modify: `apps/web/src/components/SchedulesPanel.tsx:369-370` (`.total`)
- Test: `apps/api/src/platform/ai-pricing.test.ts`
- Test: `apps/api/src/features/insights/cost.test.ts`
- Test: `apps/api/src/stores/postgres-insights-store.integration.test.ts` (gated by `RUN_PG_INTEGRATION`)
- Test: `apps/web/src/components/insights/AiUsageChart.test.tsx` (fixture)
- Test: `apps/web/src/components/insights/AiCostByFlowChart.test.tsx` (fixture)
- Test: `apps/web/src/components/SchedulesPanel.test.tsx` (fixture)

**Interfaces:**
- Produces: `interface AiCostEstimate { input: number; output: number; total: number }` exported from `@magpie/core` (and re-exported from `apps/web/src/lib/types.ts`); `estimatedCost?: AiCostEstimate` on `AiUsageBreakdown`, `AiCostByFlow`, `AiScheduleCost`; `estimateTokenCost(...) => AiCostEstimate | undefined`.

- [ ] **Step 1: Update the `estimateTokenCost` test to expect the object**

In `apps/api/src/platform/ai-pricing.test.ts`, add (and adjust any existing numeric expectation of `estimateTokenCost`):

```ts
import { estimateTokenCost, parseAiPricing } from "./ai-pricing.js";

test("estimateTokenCost splits cost into input, output, and total", () => {
  const entries = parseAiPricing(
    JSON.stringify([{ provider: "openai-compatible", model: "m", inputPerMTok: 2, outputPerMTok: 6 }])
  ).entries;
  const cost = estimateTokenCost(entries, { provider: "openai-compatible", model: "m" }, {
    inputTokens: 1_000_000,
    outputTokens: 500_000
  });
  assert.deepEqual(cost, { input: 2, output: 3, total: 5 });
});

test("estimateTokenCost returns undefined for an unmatched model (unpriced)", () => {
  assert.equal(estimateTokenCost([], { provider: "openai-compatible", model: "m" }, {
    inputTokens: 10,
    outputTokens: 10
  }), undefined);
});

test("estimateTokenCost prices a zero-rate free model as a real zero", () => {
  const entries = parseAiPricing(
    JSON.stringify([{ provider: "openai-compatible", model: "free", inputPerMTok: 0, outputPerMTok: 0 }])
  ).entries;
  assert.deepEqual(
    estimateTokenCost(entries, { provider: "openai-compatible", model: "free" }, { inputTokens: 9, outputTokens: 9 }),
    { input: 0, output: 0, total: 0 }
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern "estimateTokenCost"`
Expected: FAIL — `estimateTokenCost` still returns a `number`, so `deepEqual` against the object fails.

- [ ] **Step 3: Add `AiCostEstimate` to core and retype the interfaces**

In `packages/core/src/index.ts`, add near the AI rollup types:

```ts
// Read-time AI spend for one priced rollup, split by token direction. Present
// only in the *priced* state (a matched AI_PRICING entry — including a
// legitimate zero-rate free model). `total === input + output`.
export interface AiCostEstimate {
  input: number;
  output: number;
  total: number;
}
```

Change the field on all three interfaces from `estimatedCost?: number` to `estimatedCost?: AiCostEstimate`:
- `AiUsageBreakdown` (~line 1754)
- `AiCostByFlow` (~line 1774)
- `AiScheduleCost` (~line 1793)

Update the `AiUsageBreakdown` doc-comment sentence "`estimatedCost` is money, computed at read time…" to note it is now the `{ input, output, total }` split (still present iff priced).

- [ ] **Step 4: Return the object from `estimateTokenCost`**

In `apps/api/src/platform/ai-pricing.ts`, import the type and rewrite the return:

```ts
import type { AiCostEstimate, AiProviderName } from "@magpie/core"; // merge with existing @magpie/core import

export function estimateTokenCost(
  entries: AiPricingEntry[],
  identity: { provider: string; model: string | null },
  tokens: { inputTokens: number; outputTokens: number }
): AiCostEstimate | undefined {
  if (identity.model === null) {
    return undefined;
  }
  const entry = entries.find(
    (candidate) => candidate.provider === identity.provider && candidate.model === identity.model
  );
  if (!entry) {
    return undefined;
  }
  const input = (tokens.inputTokens * entry.inputPerMTok) / 1_000_000;
  const output = (tokens.outputTokens * entry.outputPerMTok) / 1_000_000;
  return { input, output, total: input + output };
}
```

(If `@magpie/core` is already imported in this file, just add `AiCostEstimate` to that import rather than adding a second line.)

- [ ] **Step 5: Run the pricing test to verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern "estimateTokenCost"`
Expected: PASS.

- [ ] **Step 6: Update `summariseAiCost` to sum the object**

Update the cost.test first. In `apps/api/src/features/insights/cost.test.ts`, change each fixture `estimatedCost: 0.5` to `estimatedCost: { input: 0.3, output: 0.2, total: 0.5 }`, and change the summed assertion to expect the object, e.g.:

```ts
assert.deepEqual(summary.estimatedCost, { input: 0.6, output: 0.4, total: 1.0 });
```

(Use whatever per-row splits you set so the summed totals stay internally consistent; the "omits estimatedCost when nothing is priced" test is unchanged — it still asserts `undefined`.)

Then in `apps/api/src/features/insights/cost.ts` replace the numeric accumulation:

```ts
let inputCost = 0;
let outputCost = 0;
let totalCost = 0;
let anyPriced = false;
for (const row of rows) {
  jobs += row.jobs;
  jobsWithUsage += row.jobsWithUsage;
  inputTokens += row.inputTokens;
  outputTokens += row.outputTokens;
  totalTokens += row.totalTokens;
  if (row.estimatedCost !== undefined) {
    anyPriced = true;
    inputCost += row.estimatedCost.input;
    outputCost += row.estimatedCost.output;
    totalCost += row.estimatedCost.total;
    pricedJobs += row.jobsWithUsage;
  }
}
return {
  jobs,
  jobsWithUsage,
  pricedJobs,
  inputTokens,
  outputTokens,
  totalTokens,
  ...(anyPriced ? { estimatedCost: { input: inputCost, output: outputCost, total: totalCost } } : {})
};
```

- [ ] **Step 7: Run the cost test to verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern "summariseAiCost"`
Expected: PASS.

- [ ] **Step 8: Fix remaining backend consumers**

`apps/api/src/stores/postgres-insights-store.ts` `priceUsageRow` needs no logic change — `estimateTokenCost` now returns the object and the existing spread `...(estimatedCost !== undefined ? { estimatedCost } : {})` carries it. Confirm it typechecks.

`apps/api/src/features/insights/service.ts:121` sort — change:

```ts
.sort((a, b) => (b.estimatedCost?.total ?? 0) - (a.estimatedCost?.total ?? 0) || b.totalTokens - a.totalTokens);
```

- [ ] **Step 9: Fix the integration-test expectations**

In `apps/api/src/stores/postgres-insights-store.integration.test.ts`, the priced rows are asserted with `deepEqual` against `estimatedCost: 0.0006` (and similar). Replace each numeric `estimatedCost: N` in the expected objects with the object form. Because computing the exact `input`/`output` split for each fixture is error-prone, instead relax those specific assertions to check the total and the invariant. For each priced row `r`:

```ts
assert.equal(r.estimatedCost?.total, 0.0006);
assert.ok(r.estimatedCost && Math.abs(r.estimatedCost.input + r.estimatedCost.output - r.estimatedCost.total) < 1e-12);
```

Keep the unpriced/unmetered rows asserting `estimatedCost === undefined` as before.

- [ ] **Step 10: Fix the web consumers to read `.total` (visuals unchanged)**

`apps/web/src/lib/types.ts` — add `AiCostEstimate` to the `export type { … } from "@magpie/core";` block at line ~308.

`apps/web/src/components/insights/AiUsageChart.tsx` — the current file reads `row.estimatedCost` as a number in two spots. Change:
- `costState`: `if (row.estimatedCost !== undefined)` is unchanged (still a presence check).
- the tooltip cost string: `` `est. cost ${formatCost(row.estimatedCost?.total ?? 0)}` ``
- the header reduce: `usage.reduce((sum, row) => sum + (row.estimatedCost?.total ?? 0), 0)`

`apps/web/src/components/insights/AiCostByFlowChart.tsx` — same: `flow.estimatedCost !== undefined ? \`est. cost ${formatCost(flow.estimatedCost.total)}\`` and the reduce `sum + (flow.estimatedCost?.total ?? 0)`.

`apps/web/src/components/SchedulesPanel.tsx:369-370` — `formatCost(cost.estimatedCost.total)` (guarded by the existing `!== undefined`).

- [ ] **Step 11: Fix web test fixtures to the object form**

`AiUsageChart.test.tsx` — change `estimatedCost: 0.91` to `estimatedCost: { input: 0.7, output: 0.21, total: 0.91 }`.
`AiCostByFlowChart.test.tsx` — change `estimatedCost: 1.23` to `estimatedCost: { input: 0.9, output: 0.33, total: 1.23 }`.
`SchedulesPanel.test.tsx` — change any `estimatedCost: N` fixture to `{ input, output, total: N }` (pick a consistent split).

- [ ] **Step 12: Validate the whole workspace**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all green. (Visuals unchanged; this is a pure refactor.)

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "refactor: structured AiCostEstimate cost split across rollups"
```

---

### Task 2: Shared `CostBarChart` presentational component

A single Recharts horizontal cost-bar renderer both cards feed. Purely presentational — it takes pre-adapted data plus header/coverage/footnote/empty strings and owns no domain logic.

**Files:**
- Create: `apps/web/src/components/insights/CostBarChart.tsx`
- Test: `apps/web/src/components/insights/CostBarChart.test.tsx`

**Interfaces:**
- Consumes: `AiCostEstimate`, `formatCost` (`./format`).
- Produces:
```ts
export interface CostBarDatum {
  label: string;       // category / flow name (unique — doubles as recharts key)
  inputCost: number;   // estimatedCost.input
  outputCost: number;  // estimatedCost.output
  costLabel: string;   // "est. cost 0.91" (tooltip)
  tokens: string;      // "240,000 in · 31,000 out tokens" (tooltip)
  states?: string;     // "12/12 jobs metered" (tooltip)
}
export function CostBarChart(props: {
  data: CostBarDatum[];
  headerTotal: string;             // "Est. cost 4.82" | "No priced usage"
  coverage: string;                // "2 priced · 0 unpriced · 13 unmetered"
  footnote?: string;
  emptyState?: React.ReactNode;
}): React.JSX.Element;
```

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/insights/CostBarChart.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkup } from "../../test/render";
import { CostBarChart, type CostBarDatum } from "./CostBarChart";

const data: CostBarDatum[] = [
  {
    label: "Verify document · openai-compatible · deepseek-v4-flash",
    inputCost: 2.1,
    outputCost: 1.0,
    costLabel: "est. cost 3.10",
    tokens: "150,000 in · 40,000 out tokens",
    states: "5/5 jobs metered"
  }
];

test("CostBarChart renders the header total and coverage", () => {
  const html = renderMarkup(
    <CostBarChart data={data} headerTotal="Est. cost 3.10" coverage="1 priced · 0 unpriced · 2 unmetered" />
  );
  assert.match(html, /Est\. cost 3\.10/);
  assert.match(html, /1 priced · 0 unpriced · 2 unmetered/);
});

test("CostBarChart renders the footnote when given one", () => {
  const html = renderMarkup(
    <CostBarChart data={data} headerTotal="Est. cost 3.10" coverage="x" footnote="2 unmetered categories — providers reported no usage" />
  );
  assert.match(html, /2 unmetered categories/);
});

test("CostBarChart renders the empty state instead of a plot when data is empty", () => {
  const html = renderMarkup(
    <CostBarChart
      data={[]}
      headerTotal="No priced usage"
      coverage="0 priced · 1 unpriced · 3 unmetered"
      emptyState={<span>Add an AI_PRICING entry for openai-compatible · deepseek-v4-flash</span>}
    />
  );
  assert.match(html, /Add an AI_PRICING entry for openai-compatible · deepseek-v4-flash/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/web -- --test-name-pattern "CostBarChart"`
Expected: FAIL — module `./CostBarChart` does not exist.

- [ ] **Step 3: Implement `CostBarChart`**

`apps/web/src/components/insights/CostBarChart.tsx`:

```tsx
"use client";

import { useTheme } from "@emotion/react";
import styled from "@emotion/styled";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const COMPACT = Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
function compact(value: number): string {
  return COMPACT.format(value);
}

export interface CostBarDatum {
  label: string;
  inputCost: number;
  outputCost: number;
  costLabel: string;
  tokens: string;
  states?: string;
}

const Summary = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: theme.space.lg,
  marginBottom: theme.space.md,
  fontSize: theme.font.size.sm,
  color: theme.color.textMuted
}));

const TotalCost = styled.span(({ theme }) => ({
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.semibold,
  color: theme.color.text
}));

const Coverage = styled.span(({ theme }) => ({ color: theme.color.textSubtle }));

const Footnote = styled.p(({ theme }) => ({
  marginTop: theme.space.sm,
  fontSize: theme.font.size.sm,
  color: theme.color.textSubtle
}));

const Empty = styled.div(({ theme }) => ({
  padding: theme.space.lg,
  fontSize: theme.font.size.sm,
  color: theme.color.textMuted
}));

// Horizontal AI-cost bars: bar length is spend (input-cost + output-cost stacked,
// both money → total length = total cost). Tokens ride the tooltip, never the
// axis. Presentational only — the caller pre-computes header/coverage/footnote and
// filters to priced rows. Supersedes the earlier token-bar design (#241): for a
// cost card, cost belongs on the axis.
export function CostBarChart({
  data,
  headerTotal,
  coverage,
  footnote,
  emptyState
}: {
  data: CostBarDatum[];
  headerTotal: string;
  coverage: string;
  footnote?: string;
  emptyState?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <>
      <Summary>
        <TotalCost>{headerTotal}</TotalCost>
        <Coverage>{coverage}</Coverage>
      </Summary>
      {data.length === 0 ? (
        <Empty>{emptyState ?? "No priced usage to chart."}</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(160, 48 + data.length * 34)}>
          <BarChart layout="vertical" data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 12, fill: theme.color.textMuted }}
              tickLine={false}
              tickFormatter={compact}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={190}
              tick={{ fontSize: 11, fill: theme.color.textMuted }}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: theme.color.border }}
              labelFormatter={(label, payload) => {
                const datum = payload?.[0]?.payload as CostBarDatum | undefined;
                const parts = [String(label)];
                if (datum?.costLabel) parts.push(datum.costLabel);
                if (datum?.tokens) parts.push(datum.tokens);
                if (datum?.states) parts.push(datum.states);
                return parts.join(" — ");
              }}
              formatter={(value, name) => [typeof value === "number" ? value.toLocaleString() : value, name]}
            />
            <Legend />
            <Bar dataKey="inputCost" name="Input cost" stackId="cost" fill={theme.color.status.pending.dot} />
            <Bar
              dataKey="outputCost"
              name="Output cost"
              stackId="cost"
              fill={theme.color.status.completed.dot}
              radius={[0, 3, 3, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
      {footnote ? <Footnote>{footnote}</Footnote> : null}
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @magpie/web -- --test-name-pattern "CostBarChart"`
Expected: PASS.

- [ ] **Step 5: Validate & commit**

Run: `npm run typecheck && npm run lint -w @magpie/web`
```bash
git add apps/web/src/components/insights/CostBarChart.tsx apps/web/src/components/insights/CostBarChart.test.tsx
git commit -m "feat: shared CostBarChart (horizontal cost bars, tokens in tooltip)"
```

---

### Task 3: Redesign `AiUsageChart` to plot cost

Adapt the (job type · provider · model) rollup into `CostBarDatum`s (priced rows only), building the coverage line, the unmetered footnote + unpriced nudge, and the empty-state CTA.

**Files:**
- Modify: `apps/web/src/components/insights/AiUsageChart.tsx` (replace body)
- Test: `apps/web/src/components/insights/AiUsageChart.test.tsx`

**Interfaces:**
- Consumes: `CostBarChart`, `CostBarDatum` (Task 2); `humanise`, `formatCost` (`./format`); `AiUsageBreakdown` (`../../lib/types`).

- [ ] **Step 1: Extend the test for the new behaviour**

In `apps/web/src/components/insights/AiUsageChart.test.tsx` keep the existing coverage test and add:

```ts
test("AiUsageChart footnotes unmetered rows and names unpriced pairs", () => {
  const html = renderMarkup(<AiUsageChart usage={fixture} />);
  // unmetered claude row → footnoted; unpriced gpt-4o-mini → named for pricing.
  assert.match(html, /1 unmetered/);
  assert.match(html, /gpt-4o-mini/);
});

test("AiUsageChart shows an empty-state CTA when nothing is priced", () => {
  const unpricedOnly = fixture.filter((row) => row.estimatedCost === undefined);
  const html = renderMarkup(<AiUsageChart usage={unpricedOnly} />);
  assert.match(html, /No priced usage/);
  assert.match(html, /AI_PRICING/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/web -- --test-name-pattern "AiUsageChart"`
Expected: FAIL — no `AI_PRICING` / `gpt-4o-mini` nudge text yet.

- [ ] **Step 3: Rewrite `AiUsageChart`**

Replace the component body in `apps/web/src/components/insights/AiUsageChart.tsx`:

```tsx
"use client";

import type { AiUsageBreakdown } from "../../lib/types";
import { CostBarChart, type CostBarDatum } from "./CostBarChart";
import { formatCost, humanise } from "./format";

function label(row: AiUsageBreakdown): string {
  return `${humanise(row.jobType)} · ${row.provider}${row.model ? ` · ${row.model}` : ""}`;
}

function pricePair(row: AiUsageBreakdown): string {
  return `${row.provider}${row.model ? ` · ${row.model}` : ""}`;
}

// One bar per (job type, provider, model) triple whose usage priced (cost on the
// axis, tokens in the tooltip). Unmetered triples (CLI providers, no usage) drop
// to a footnote; unpriced triples (usage but no AI_PRICING match) are named so the
// operator knows exactly what to price. (#241, cost now plotted not text.)
export function AiUsageChart({ usage }: { usage: AiUsageBreakdown[] }) {
  const priced = usage.filter((row) => row.estimatedCost !== undefined);
  const unpriced = usage.filter((row) => row.estimatedCost === undefined && row.jobsWithUsage > 0);
  const unmetered = usage.filter((row) => row.jobsWithUsage === 0);

  const data: CostBarDatum[] = priced.flatMap((row) => {
    const cost = row.estimatedCost;
    if (cost === undefined) return [];
    return [
      {
        label: label(row),
        inputCost: cost.input,
        outputCost: cost.output,
        costLabel: `est. cost ${formatCost(cost.total)}`,
        tokens: `${row.inputTokens.toLocaleString()} in · ${row.outputTokens.toLocaleString()} out tokens`,
        states: `${row.jobsWithUsage}/${row.jobs} jobs metered`
      }
    ];
  });

  const total = priced.reduce((sum, row) => sum + (row.estimatedCost?.total ?? 0), 0);
  const headerTotal = priced.length > 0 ? `Est. cost ${formatCost(total)}` : "No priced usage";
  const coverage = `${priced.length} priced · ${unpriced.length} unpriced · ${unmetered.length} unmetered`;

  const unpricedPairs = [...new Set(unpriced.map(pricePair))];
  const footnoteParts: string[] = [];
  if (unmetered.length > 0) {
    footnoteParts.push(
      `${unmetered.length} unmetered ${unmetered.length === 1 ? "category" : "categories"} — providers reported no usage`
    );
  }
  if (unpricedPairs.length > 0) {
    footnoteParts.push(`Unpriced — add an AI_PRICING entry for: ${unpricedPairs.join(", ")}`);
  }
  const footnote = footnoteParts.length > 0 ? footnoteParts.join(" · ") : undefined;

  const emptyState =
    priced.length === 0
      ? `No priced usage yet. Add an AI_PRICING entry for ${
          unpricedPairs.length > 0 ? unpricedPairs.join(", ") : "your model"
        } to see cost here.`
      : undefined;

  return (
    <CostBarChart data={data} headerTotal={headerTotal} coverage={coverage} footnote={footnote} emptyState={emptyState} />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @magpie/web -- --test-name-pattern "AiUsageChart"`
Expected: PASS (existing coverage test + the two new ones).

- [ ] **Step 5: Validate & commit**

Run: `npm run typecheck && npm run lint -w @magpie/web`
```bash
git add apps/web/src/components/insights/AiUsageChart.tsx apps/web/src/components/insights/AiUsageChart.test.tsx
git commit -m "feat: AiUsageChart plots cost with tokens in the tooltip"
```

---

### Task 4: Redesign `AiCostByFlowChart` to plot cost

Same treatment, per flow. A flow's `estimatedCost` is its summed spend; flows with no priced usage are footnoted rather than drawn as empty bars. The per-flow priced/unpriced/unmetered job counts stay in the tooltip.

**Files:**
- Modify: `apps/web/src/components/insights/AiCostByFlowChart.tsx` (replace body)
- Test: `apps/web/src/components/insights/AiCostByFlowChart.test.tsx`

**Interfaces:**
- Consumes: `CostBarChart`, `CostBarDatum` (Task 2); `formatCost` (`./format`); `AiCostByFlow` (`../../lib/types`); the `flowName` prop.

- [ ] **Step 1: Extend the test**

In `apps/web/src/components/insights/AiCostByFlowChart.test.tsx` add:

```ts
test("AiCostByFlowChart plots priced flows and footnotes flows with no priced usage", () => {
  const flows = [
    { flowId: "a", jobs: 5, jobsWithUsage: 5, pricedJobs: 5, inputTokens: 100, outputTokens: 40, totalTokens: 140, estimatedCost: { input: 0.9, output: 0.33, total: 1.23 } },
    { flowId: "b", jobs: 4, jobsWithUsage: 0, pricedJobs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  ];
  const html = renderMarkup(<AiCostByFlowChart flows={flows} flowName={(id) => id ?? "Unattributed"} />);
  assert.match(html, /Est\. cost 1\.23/);
  assert.match(html, /no priced usage/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/web -- --test-name-pattern "AiCostByFlowChart"`
Expected: FAIL — no "no priced usage" footnote yet.

- [ ] **Step 3: Rewrite `AiCostByFlowChart`**

Replace the component body in `apps/web/src/components/insights/AiCostByFlowChart.tsx`:

```tsx
"use client";

import type { AiCostByFlow } from "../../lib/types";
import { CostBarChart, type CostBarDatum } from "./CostBarChart";
import { formatCost } from "./format";

// One bar per flow whose spend priced (cost on the axis, tokens in the tooltip).
// Flows with no priced usage are footnoted rather than drawn as empty bars. Each
// tooltip keeps the flow's priced/unpriced/unmetered job counts. "Unattributed"
// holds jobs whose input carried no flowId. Flow names come from config.
export function AiCostByFlowChart({
  flows,
  flowName
}: {
  flows: AiCostByFlow[];
  flowName: (flowId?: string) => string;
}) {
  const priced = flows.filter((flow) => flow.estimatedCost !== undefined);
  const unpricedFlows = flows.length - priced.length;

  const data: CostBarDatum[] = priced.flatMap((flow) => {
    const cost = flow.estimatedCost;
    if (cost === undefined) return [];
    const unpricedJobs = flow.jobsWithUsage - flow.pricedJobs;
    const unmeteredJobs = flow.jobs - flow.jobsWithUsage;
    return [
      {
        label: flowName(flow.flowId),
        inputCost: cost.input,
        outputCost: cost.output,
        costLabel: `est. cost ${formatCost(cost.total)}`,
        tokens: `${flow.inputTokens.toLocaleString()} in · ${flow.outputTokens.toLocaleString()} out tokens`,
        states: `${flow.pricedJobs} priced · ${unpricedJobs} unpriced · ${unmeteredJobs} unmetered jobs`
      }
    ];
  });

  const total = priced.reduce((sum, flow) => sum + (flow.estimatedCost?.total ?? 0), 0);
  const headerTotal = priced.length > 0 ? `Est. cost ${formatCost(total)}` : "No priced usage";
  const coverage = `across ${flows.length} flow${flows.length === 1 ? "" : "s"}`;
  const footnote =
    unpricedFlows > 0
      ? `${unpricedFlows} flow${unpricedFlows === 1 ? "" : "s"} with no priced usage not shown`
      : undefined;
  const emptyState =
    priced.length === 0 ? "No priced usage yet. Configure AI_PRICING to attribute spend to flows." : undefined;

  return (
    <CostBarChart data={data} headerTotal={headerTotal} coverage={coverage} footnote={footnote} emptyState={emptyState} />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @magpie/web -- --test-name-pattern "AiCostByFlowChart"`
Expected: PASS.

- [ ] **Step 5: Validate & commit**

Run: `npm run typecheck && npm test -w @magpie/web && npm run lint -w @magpie/web`
```bash
git add apps/web/src/components/insights/AiCostByFlowChart.tsx apps/web/src/components/insights/AiCostByFlowChart.test.tsx
git commit -m "feat: AiCostByFlowChart plots cost with tokens in the tooltip"
```

---

### Task 5: Documentation

Update the insights-charts doc to describe the new encoding and record the reversed decision.

**Files:**
- Modify: `docs/insights-charts.md` (C11, AI cost by flow, per-schedule cost entries; the Recharts row if it mentions token bars)

- [ ] **Step 1: Rewrite the C11 and AI-cost-by-flow descriptions**

In `docs/insights-charts.md`, update the **C11. AI token usage & cost** and **AI cost by flow** entries so the **Data** lines read that each bar is *cost* — input-cost + output-cost stacked, horizontal — with tokens and the priced/unpriced/unmetered job counts in the tooltip; unmetered rows footnoted and unpriced pairs named for pricing; an empty-state CTA when nothing is priced. Update the per-schedule entry's mention of `estimatedCost` if it describes the shape. Add one sentence noting `estimatedCost` is now the `{ input, output, total }` `AiCostEstimate` split, computed at read time as before. Explicitly note this supersedes the earlier "cost rides text… never a series colour or a second y-axis" decision.

- [ ] **Step 2: Verify no stale references remain**

Run: `grep -n "rides text\|second y-axis\|stacked bar (input + output tokens)\|input + output tokens" docs/insights-charts.md`
Expected: no lines describing the old token-bar-with-cost-in-text design remain for these three entries.

- [ ] **Step 3: Commit**

```bash
git add docs/insights-charts.md
git commit -m "docs: cost cards now plot cost, tokens in tooltip"
```

---

## Final validation

- [ ] Run the full gate: `npm run typecheck && npm test && npm run lint && npm run build`
- [ ] Optionally launch the stack (run-magpie skill) and eyeball the Insights page + a priced `AI_PRICING` entry to see real cost bars and the empty state.

## Self-review notes

- **Spec coverage:** structured `AiCostEstimate` (Task 1) ✓; cost split by direction (Task 1) ✓; shared component (Task 2) ✓; cost-on-axis + tokens-in-tooltip (Tasks 2–4) ✓; unmetered footnote + unpriced nudge + empty state (Tasks 2–4) ✓; both cards consistent (Tasks 3–4 via Task 2) ✓; SchedulesPanel consumer (Task 1) ✓; docs (Task 5) ✓.
- **Testing limitation:** Recharts renders its bars/tooltip inside `ResponsiveContainer`, which has no width under SSR `renderMarkup`, so tests assert the SSR-observable text (header total, coverage, footnote, empty-state CTA), not bar geometry or hover-only tooltip content. Tokens-in-tooltip is guaranteed by construction (passed into the `Tooltip` datum), matching the existing tests' approach.
