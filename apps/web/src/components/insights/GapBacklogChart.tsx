"use client";

import { useTheme } from "@emotion/react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GapBacklogBucket } from "../../lib/types";
import { shortDate } from "./format";

// Open-gap backlog trend: stacked areas for the transitions that happened in
// each bucket (opened/resolved/dismissed/parked) plus a line for the running net
// open total. Answers "is knowledge debt growing or shrinking?".
export function GapBacklogChart({ series }: { series: GapBacklogBucket[] }) {
  const theme = useTheme();
  const data = series.map((bucket) => ({ ...bucket, label: shortDate(bucket.bucketStart) }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <Tooltip />
        <Legend />
        <Area
          type="monotone"
          dataKey="opened"
          name="Opened"
          stackId="transitions"
          stroke={theme.color.status.pending.dot}
          fill={theme.color.status.pending.bg}
        />
        <Area
          type="monotone"
          dataKey="resolved"
          name="Resolved"
          stackId="transitions"
          stroke={theme.color.status.completed.dot}
          fill={theme.color.status.completed.bg}
        />
        <Area
          type="monotone"
          dataKey="dismissed"
          name="Dismissed"
          stackId="transitions"
          stroke={theme.color.status.neutral.dot}
          fill={theme.color.status.neutral.bg}
        />
        <Area
          type="monotone"
          dataKey="parked"
          name="Parked"
          stackId="transitions"
          stroke={theme.color.status.running.dot}
          fill={theme.color.status.running.bg}
        />
        <Line
          type="monotone"
          dataKey="openTotal"
          name="Net open (cumulative)"
          stroke={theme.color.accent}
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
