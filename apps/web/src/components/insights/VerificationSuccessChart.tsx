"use client";

import { useTheme } from "@emotion/react";
import styled from "@emotion/styled";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { VerificationSummary } from "../../lib/types";

const Wrap = styled.div({ position: "relative" });

const Centre = styled.div(({ theme }) => ({
  position: "absolute",
  top: "44%",
  left: 0,
  right: 0,
  textAlign: "center",
  pointerEvents: "none",
  color: theme.color.text,
  fontSize: 28,
  fontWeight: theme.font.weight.semibold
}));

const CentreLabel = styled.div(({ theme }) => ({
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.regular,
  color: theme.color.textMuted
}));

// Verification success rate: a donut of the overall closed-vs-still-open split of
// gap-closure verification outcomes, with the success percentage in the centre.
// Answers "do merged proposals actually close the gap they targeted?".
export function VerificationSuccessChart({ totals }: { totals: VerificationSummary }) {
  const theme = useTheme();
  const total = totals.closed + totals.stillOpen;
  const successRate = total > 0 ? Math.round((totals.closed / total) * 100) : 0;

  const data = [
    { key: "closed", name: "Closed", value: totals.closed, color: theme.color.status.completed.dot },
    { key: "stillOpen", name: "Still open", value: totals.stillOpen, color: theme.color.status.failed.dot }
  ];

  return (
    <Wrap>
      <ResponsiveContainer width="100%" height={320}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={70} outerRadius={110}>
            {data.map((slice) => (
              <Cell key={slice.key} fill={slice.color} />
            ))}
          </Pie>
          <Tooltip />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
      <Centre>
        {successRate}%
        <CentreLabel>closed</CentreLabel>
      </Centre>
    </Wrap>
  );
}
