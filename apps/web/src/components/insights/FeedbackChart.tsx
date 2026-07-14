"use client";

import { useTheme } from "@emotion/react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { FeedbackBucket } from "../../lib/types";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Answer feedback: stacked areas of the helpful/unhelpful verdicts users gave
// per bucket — the unhelpful stack split into rejections of CONFIDENT answers
// (the strongest quality signal: the system believed the answer and the user
// did not) and the rest — plus a line for the unhelpful rate. Answers "are
// users rejecting our answers, and especially the ones we were sure of?" (#241).
export function FeedbackChart({ series }: { series: FeedbackBucket[] }) {
  const theme = useTheme();
  const data = series.map((bucket) => {
    const total = bucket.helpful + bucket.unhelpful;
    return {
      ...bucket,
      unhelpfulOther: bucket.unhelpful - bucket.unhelpfulConfident,
      // Rate is null (not 0) on buckets with no feedback at all, so quiet days
      // read as "no signal" rather than "perfect".
      unhelpfulRate: total > 0 ? Math.round((bucket.unhelpful / total) * 100) : null,
      label: shortDate(bucket.bucketStart)
    };
  });

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
        <YAxis
          yAxisId="counts"
          allowDecimals={false}
          tick={{ fontSize: 12, fill: theme.color.textMuted }}
          tickLine={false}
        />
        <YAxis
          yAxisId="rate"
          orientation="right"
          domain={[0, 100]}
          unit="%"
          tick={{ fontSize: 12, fill: theme.color.textMuted }}
          tickLine={false}
        />
        <Tooltip />
        <Legend />
        <Area
          yAxisId="counts"
          type="monotone"
          dataKey="helpful"
          name="Helpful"
          stackId="verdicts"
          stroke={theme.color.status.completed.dot}
          fill={theme.color.status.completed.bg}
        />
        <Area
          yAxisId="counts"
          type="monotone"
          dataKey="unhelpfulOther"
          name="Unhelpful — other"
          stackId="verdicts"
          stroke={theme.color.status.pending.dot}
          fill={theme.color.status.pending.bg}
        />
        <Area
          yAxisId="counts"
          type="monotone"
          dataKey="unhelpfulConfident"
          name="Unhelpful — confident answer"
          stackId="verdicts"
          stroke={theme.color.status.failed.dot}
          fill={theme.color.status.failed.bg}
        />
        <Line
          yAxisId="rate"
          type="monotone"
          dataKey="unhelpfulRate"
          name="Unhelpful rate"
          stroke={theme.color.accent}
          strokeWidth={2}
          dot={false}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
