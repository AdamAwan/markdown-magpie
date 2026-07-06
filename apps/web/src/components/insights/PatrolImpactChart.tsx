"use client";

import { useTheme } from "@emotion/react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PatrolImpact } from "../../lib/types";

// Humanise a maintenance task type ("correctness_patrol" → "Correctness patrol")
// for the axis label.
function humanise(taskType: string): string {
  const spaced = taskType.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Maintenance patrol impact: grouped bars per task type showing how many runs
// happened and what they surfaced — findings (verify-lens) and proposals drafted.
// Answers "are the patrols finding and fixing things?".
export function PatrolImpactChart({ runs }: { runs: PatrolImpact[] }) {
  const theme = useTheme();
  const data = runs.map((row) => ({
    label: humanise(row.taskType),
    runs: row.runs,
    findings: row.findings,
    proposals: row.proposals
  }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <Tooltip />
        <Legend />
        <Bar dataKey="runs" name="Runs" fill={theme.color.status.pending.dot} radius={[3, 3, 0, 0]} />
        <Bar dataKey="findings" name="Findings" fill={theme.color.status.running.dot} radius={[3, 3, 0, 0]} />
        <Bar dataKey="proposals" name="Proposals" fill={theme.color.status.completed.dot} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
