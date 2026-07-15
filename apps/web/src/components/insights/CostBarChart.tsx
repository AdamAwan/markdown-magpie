"use client";

import { useTheme } from "@emotion/react";
import styled from "@emotion/styled";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Compact money for the value axis ("1200" → "1.2K"). Hoisted: recharts calls the
// tick formatter on every render and Intl.NumberFormat construction is expensive.
const COMPACT = Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
function compact(value: number): string {
  return COMPACT.format(value);
}

// One horizontal bar's worth of data. `label` doubles as the recharts category
// key, so callers must keep it unique per row. `inputCost`/`outputCost` are the
// stacked money segments (their sum is the bar length); everything else rides the
// tooltip.
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
// both money → total length = total cost), so the biggest bar is the biggest
// cost. Tokens ride the tooltip, never the axis. Presentational only — the caller
// pre-computes the header/coverage/footnote and filters to the priced rows worth
// drawing. This supersedes the earlier token-bar-with-cost-in-text design (#241):
// for a cost card, cost belongs on the axis.
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
              formatter={(value, name) => [typeof value === "number" ? value.toLocaleString() : value, name]}
              labelFormatter={(label, payload) => {
                // recharts hands the hovered row's datum on the payload — no lookup.
                const datum = payload?.[0]?.payload as CostBarDatum | undefined;
                const parts = [String(label)];
                if (datum?.costLabel) parts.push(datum.costLabel);
                if (datum?.tokens) parts.push(datum.tokens);
                if (datum?.states) parts.push(datum.states);
                return parts.join(" — ");
              }}
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
