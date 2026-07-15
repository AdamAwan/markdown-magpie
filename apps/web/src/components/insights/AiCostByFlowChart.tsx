"use client";

import { useTheme } from "@emotion/react";
import styled from "@emotion/styled";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AiCostByFlow } from "../../lib/types";
import { formatCost } from "./format";

const COMPACT = Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
function compact(value: number): string {
  return COMPACT.format(value);
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

const Coverage = styled.span(({ theme }) => ({
  color: theme.color.textSubtle
}));

// Per-flow AI cost: one stacked token bar per flow (input + output), heaviest
// spend first (the API pre-sorts by cost), with cost carried in text — a header
// total and a per-bar tooltip — never a series colour or a second y-axis. Each
// flow's tooltip keeps the three states distinct (priced / unpriced / unmetered
// job counts) so a flow's spend is never misreported as $0. The "Unattributed"
// bucket holds jobs whose input carried no flowId (answer_question, the fold_*
// jobs, and unscoped-flow patrol/draft jobs). Flow names come from config.
export function AiCostByFlowChart({
  flows,
  flowName
}: {
  flows: AiCostByFlow[];
  flowName: (flowId?: string) => string;
}) {
  const theme = useTheme();
  const data = flows.map((flow) => {
    const unpricedJobs = flow.jobsWithUsage - flow.pricedJobs;
    const unmeteredJobs = flow.jobs - flow.jobsWithUsage;
    const costLabel =
      flow.estimatedCost !== undefined ? `est. cost ${formatCost(flow.estimatedCost.total)}` : "no priced usage";
    return {
      label: flowName(flow.flowId),
      inputTokens: flow.inputTokens,
      outputTokens: flow.outputTokens,
      cost: costLabel,
      // e.g. "5 priced · 2 unpriced · 4 unmetered jobs"
      states: `${flow.pricedJobs} priced · ${unpricedJobs} unpriced · ${unmeteredJobs} unmetered jobs`
    };
  });

  const totalCost = flows.reduce((sum, flow) => sum + (flow.estimatedCost?.total ?? 0), 0);
  const anyPriced = flows.some((flow) => flow.estimatedCost !== undefined);

  return (
    <>
      <Summary>
        <TotalCost>{anyPriced ? `Est. cost ${formatCost(totalCost)}` : "No priced usage"}</TotalCost>
        <Coverage>
          across {flows.length} flow{flows.length === 1 ? "" : "s"}
        </Coverage>
      </Summary>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 32, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: theme.color.textMuted }}
            tickLine={false}
            interval={0}
            angle={-25}
            textAnchor="end"
          />
          <YAxis tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} tickFormatter={compact} />
          <Tooltip
            formatter={(value, name) =>
              typeof value === "number" ? [value.toLocaleString(), name] : [value ?? "", name]
            }
            labelFormatter={(label, payload) => {
              const datum = payload?.[0]?.payload as { cost?: string; states?: string } | undefined;
              const parts = [String(label)];
              if (datum?.cost) parts.push(datum.cost);
              if (datum?.states) parts.push(datum.states);
              return parts.join(" — ");
            }}
          />
          <Legend />
          <Bar dataKey="inputTokens" name="Input tokens" stackId="tokens" fill={theme.color.status.pending.dot} />
          <Bar
            dataKey="outputTokens"
            name="Output tokens"
            stackId="tokens"
            fill={theme.color.status.completed.dot}
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}
