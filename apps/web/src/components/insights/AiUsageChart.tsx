"use client";

import { useTheme } from "@emotion/react";
import styled from "@emotion/styled";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AiUsageBreakdown } from "../../lib/types";
import { humanise } from "./format";

// Compact token counts for the axis ("12400" → "12.4K"). Hoisted: recharts
// calls the tick formatter on every render, and Intl.NumberFormat construction
// is expensive.
const COMPACT = Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
function compact(value: number): string {
  return COMPACT.format(value);
}

// Currency-agnostic cost formatter. AI_PRICING rates carry no currency symbol
// (an openai-compatible endpoint could bill in any currency, or nothing), so
// cost is rendered as a bare number the operator reads in their own unit. Small
// costs need more decimals than large ones so a fraction of a cent is not shown
// as "0".
function formatCost(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2
  });
}

// One row's cost state — the three states the chart must keep distinct and must
// never collapse to "0":
//   priced    — usage reported and an AI_PRICING entry matched → a real cost.
//   unpriced  — usage reported but no matching price entry → cost unknown.
//   unmetered — no usage reported at all (CLI providers) → nothing to price.
function costState(row: AiUsageBreakdown): "priced" | "unpriced" | "unmetered" {
  if (row.estimatedCost !== undefined) {
    return "priced";
  }
  return row.jobsWithUsage > 0 ? "unpriced" : "unmetered";
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

// AI token usage priced into cost: one bar per (job type, provider, model)
// triple, input and output tokens stacked, heaviest first (the API pre-sorts).
// The token bars answer "what is each job type spending?"; the header total and
// the per-bar tooltip answer "what does that cost?". Cost rides text (never a
// series colour or a second y-axis): unpriced and unmetered triples show their
// state in the tooltip instead of a misleading "0". (#241, monetary cost.)
export function AiUsageChart({ usage }: { usage: AiUsageBreakdown[] }) {
  const theme = useTheme();
  const data = usage.map((row) => {
    const state = costState(row);
    return {
      // The label doubles as the recharts category key, so it must be unique per
      // row: two triples sharing a job type + provider are told apart by model.
      label: `${humanise(row.jobType)} · ${row.provider}${row.model ? ` · ${row.model}` : ""}`,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      metered: `${row.jobsWithUsage}/${row.jobs}`,
      cost:
        state === "priced"
          ? `est. cost ${formatCost(row.estimatedCost ?? 0)}`
          : state === "unpriced"
            ? "unpriced — no AI_PRICING entry for this model"
            : "unmetered — provider reported no usage"
    };
  });

  const totalCost = usage.reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0);
  const priced = usage.filter((row) => costState(row) === "priced").length;
  const unpriced = usage.filter((row) => costState(row) === "unpriced").length;
  const unmetered = usage.filter((row) => costState(row) === "unmetered").length;

  return (
    <>
      <Summary>
        <TotalCost>
          {priced > 0 ? `Est. cost ${formatCost(totalCost)}` : "No priced usage"}
        </TotalCost>
        <Coverage>
          {priced} priced · {unpriced} unpriced · {unmetered} unmetered
        </Coverage>
      </Summary>
      <ResponsiveContainer width="100%" height={320}>
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
              // recharts hands the hovered row's datum on the payload — no lookup.
              const datum = payload?.[0]?.payload as { metered?: string; cost?: string } | undefined;
              const parts = [String(label)];
              if (datum?.cost) parts.push(datum.cost);
              if (datum?.metered) parts.push(`${datum.metered} jobs metered`);
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
