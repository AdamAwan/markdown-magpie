"use client";

import type { AiCostByFlow } from "../../lib/types";
import { CostBarChart, type CostBarDatum } from "./CostBarChart";
import { formatCost } from "./format";

// Per-flow AI spend: one horizontal bar per flow whose spend priced, with cost on
// the axis (input-cost + output-cost stacked) and tokens in the tooltip. Flows
// with no priced usage are footnoted rather than drawn as empty bars. Each
// tooltip keeps the flow's priced/unpriced/unmetered job counts so a flow's spend
// is never misreported as $0. The "Unattributed" bucket holds jobs whose input
// carried no flowId. Flow display names come from config. (#241, cost now plotted.)
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
    if (cost === undefined) {
      return [];
    }
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
