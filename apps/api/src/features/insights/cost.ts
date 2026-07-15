import type { AiCostByFlow, AiUsageBreakdown } from "@magpie/core";

// Aggregate a set of per-(flow, job type, provider, model) usage rows into one
// cost summary. Pure and DB-free so both the per-flow cost view and the
// per-schedule attribution reduce the same rollup identically. The three cost
// states survive as counts (see AiCostByFlow): `pricedJobs` is the metered-job
// count of the triples that matched a price entry, so a summary is never
// misreported as $0 when some of its spend is unpriced or unmetered.
export function summariseAiCost(rows: AiUsageBreakdown[]): Omit<AiCostByFlow, "flowId"> {
  let jobs = 0;
  let jobsWithUsage = 0;
  let pricedJobs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  let anyPriced = false;
  for (const row of rows) {
    jobs += row.jobs;
    jobsWithUsage += row.jobsWithUsage;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    totalTokens += row.totalTokens;
    if (row.estimatedCost !== undefined) {
      anyPriced = true;
      estimatedCost += row.estimatedCost;
      // The metered jobs of a priced triple are the ones whose cost is counted.
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
    ...(anyPriced ? { estimatedCost } : {})
  };
}
