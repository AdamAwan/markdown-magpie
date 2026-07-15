import assert from "node:assert/strict";
import test from "node:test";
import type { AiCostByFlow } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { AiCostByFlowChart } from "./AiCostByFlowChart";

const fixture: AiCostByFlow[] = [
  {
    flowId: "flow-eng",
    jobs: 10,
    jobsWithUsage: 8,
    pricedJobs: 6,
    inputTokens: 120_000,
    outputTokens: 20_000,
    totalTokens: 140_000,
    estimatedCost: { input: 0.9, output: 0.33, total: 1.23 }
  },
  {
    // Unattributed bucket: no flowId, no priced usage.
    jobs: 4,
    jobsWithUsage: 0,
    pricedJobs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  }
];

const flowName = (flowId?: string) => (flowId ? ({ "flow-eng": "Engineering" }[flowId] ?? flowId) : "Unattributed");

test("AiCostByFlowChart renders the total and flow count", () => {
  const html = renderMarkup(<AiCostByFlowChart flows={fixture} flowName={flowName} />);
  assert.match(html, /Est\. cost/);
  assert.match(html, /across 2 flows/);
});

test("AiCostByFlowChart renders without throwing for empty data", () => {
  const html = renderMarkup(<AiCostByFlowChart flows={[]} flowName={flowName} />);
  assert.equal(typeof html, "string");
});
