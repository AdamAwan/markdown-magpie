"use client";

import { useTheme } from "@emotion/react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { JobThroughputBucket } from "../../lib/types";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Job throughput & health: pg-boss jobs bucketed by day and stacked by state
// (completed/failed/active/retry). Answers "is the queue keeping up? Is a runner
// failing?". Data unions the live job table with the archive so finished jobs
// stay in the history.
export function JobThroughputChart({ series }: { series: JobThroughputBucket[] }) {
  const theme = useTheme();
  const data = series.map((bucket) => ({ ...bucket, label: shortDate(bucket.bucketStart) }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <Tooltip />
        <Legend />
        <Area
          type="monotone"
          dataKey="completed"
          name="Completed"
          stackId="state"
          stroke={theme.color.status.completed.dot}
          fill={theme.color.status.completed.bg}
        />
        <Area
          type="monotone"
          dataKey="failed"
          name="Failed"
          stackId="state"
          stroke={theme.color.status.failed.dot}
          fill={theme.color.status.failed.bg}
        />
        <Area
          type="monotone"
          dataKey="active"
          name="Active"
          stackId="state"
          stroke={theme.color.status.running.dot}
          fill={theme.color.status.running.bg}
        />
        <Area
          type="monotone"
          dataKey="retry"
          name="Retry"
          stackId="state"
          stroke={theme.color.status.pending.dot}
          fill={theme.color.status.pending.bg}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
