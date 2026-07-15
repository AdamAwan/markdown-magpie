"use client";

import { useTheme } from "@emotion/react";
import styled from "@emotion/styled";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { JobErrorBreakdown } from "../../lib/types";
import { humanise } from "./format";

const Grid = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: theme.space.md
}));

const Panel = styled.div({ minWidth: 0 });

const Caption = styled.h3(({ theme }) => ({
  margin: `0 0 ${theme.space.xs}`,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  color: theme.color.textMuted
}));

// One horizontal bar panel: failed-job counts for a single breakdown dimension,
// most-frequent-first (the API already orders them).
function BreakdownPanel({ caption, rows, fill }: { caption: string; rows: JobErrorBreakdown[]; fill: string }) {
  const theme = useTheme();
  const data = rows.map((row) => ({ label: humanise(row.key), count: row.count }));
  // Horizontal bars so long category/type labels stay readable; height grows with
  // the number of bars so they never crush together.
  const height = Math.max(160, data.length * 40 + 40);

  return (
    <Panel>
      <Caption>{caption}</Caption>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 12, bottom: 0, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} horizontal={false} />
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fontSize: 12, fill: theme.color.textMuted }}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={120}
            tick={{ fontSize: 12, fill: theme.color.textMuted }}
            tickLine={false}
          />
          <Tooltip />
          <Bar dataKey="count" name="Failures" fill={fill} radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// Job error breakdown: failed jobs over the window, split by error category and by
// job type. Answers "what's breaking, and in which job type?". Data unions the
// live job table with the archive so finished failures stay in the history.
export function JobErrorBreakdownChart({
  byCategory,
  byType
}: {
  byCategory: JobErrorBreakdown[];
  byType: JobErrorBreakdown[];
}) {
  const theme = useTheme();
  return (
    <Grid>
      <BreakdownPanel caption="By error category" rows={byCategory} fill={theme.color.status.failed.dot} />
      <BreakdownPanel caption="By job type" rows={byType} fill={theme.color.status.running.dot} />
    </Grid>
  );
}
