"use client";

import { useTheme } from "@emotion/react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LatencyBin } from "../../lib/types";

// Answer-latency histogram: one bar per fixed latency range, its height the number
// of completed answers that fell in the range. Answers "how long do answers take,
// and where's the slow tail?".
export function LatencyHistogramChart({ bins }: { bins: LatencyBin[] }) {
  const theme = useTheme();
  const data = bins.map((bin) => ({ label: bin.label, count: bin.count }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <Tooltip />
        <Bar dataKey="count" name="Answers" fill={theme.color.accent} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
