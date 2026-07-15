"use client";

import { useTheme } from "@emotion/react";
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

// AI token usage: one bar per (job type, provider) pair, input and output
// tokens stacked, heaviest pair first (the API pre-sorts). Answers "what is
// each job type costing per provider?" (#241). Pairs whose completed jobs
// reported no usage at all (CLI providers emit raw text and report nothing)
// still appear with a zero bar — the tooltip's "jobs metered" count shows how
// much spend is invisible rather than pretending it is free.
export function AiUsageChart({ usage }: { usage: AiUsageBreakdown[] }) {
  const theme = useTheme();
  const data = usage.map((row) => ({
    label: `${humanise(row.jobType)} · ${row.provider}`,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    metered: `${row.jobsWithUsage}/${row.jobs}`
  }));

  return (
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
            const metered = (payload?.[0]?.payload as { metered?: string } | undefined)?.metered;
            return metered ? `${String(label)} — ${metered} jobs metered` : String(label);
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
  );
}
