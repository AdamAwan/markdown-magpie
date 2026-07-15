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
    <CostBarChart
      data={data}
      headerTotal="Est. cost 3.10"
      coverage="x"
      footnote="2 unmetered categories — providers reported no usage"
    />
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
