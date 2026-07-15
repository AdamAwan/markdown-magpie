"use client";

import type { AiUsageBreakdown } from "../../lib/types";
import { CostBarChart, type CostBarDatum } from "./CostBarChart";
import { formatCost, humanise } from "./format";

// The bar label doubles as the recharts category key, so it must be unique per
// row: two triples sharing a job type + provider are told apart by model.
function label(row: AiUsageBreakdown): string {
  return `${humanise(row.jobType)} · ${row.provider}${row.model ? ` · ${row.model}` : ""}`;
}

// The (provider, model) an operator would add to AI_PRICING to price this triple.
function pricePair(row: AiUsageBreakdown): string {
  return `${row.provider}${row.model ? ` · ${row.model}` : ""}`;
}

// AI spend by (job type, provider, model) triple: one horizontal bar per priced
// triple, with cost on the axis (input-cost + output-cost stacked) and tokens in
// the tooltip. Unmetered triples (CLI providers, no usage) drop to a footnote;
// unpriced triples (usage reported but no AI_PRICING match) are named so the
// operator knows exactly what to price; when nothing is priced the plot is
// replaced by an empty-state CTA. (#241, cost now plotted, not carried in text.)
export function AiUsageChart({ usage }: { usage: AiUsageBreakdown[] }) {
  const priced = usage.filter((row) => row.estimatedCost !== undefined);
  const unpriced = usage.filter((row) => row.estimatedCost === undefined && row.jobsWithUsage > 0);
  const unmetered = usage.filter((row) => row.jobsWithUsage === 0);

  const data: CostBarDatum[] = priced.flatMap((row) => {
    const cost = row.estimatedCost;
    if (cost === undefined) {
      return [];
    }
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
