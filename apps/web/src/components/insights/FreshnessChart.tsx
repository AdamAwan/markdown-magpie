"use client";

import { useTheme } from "@emotion/react";
import styled from "@emotion/styled";
import { Bar, BarChart, Cell, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FreshnessSummary } from "../../lib/types";

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

// Knowledge-base freshness: how much of the active KB is overdue for review, and
// how many synced sources have gone stale. Answers "how much of the KB is overdue,
// and which sources are stale?". Two small bar panels — documents (by review-cycle
// compliance) and sources (by last-sync recency) — share the card.
export function FreshnessChart({ summary }: { summary: FreshnessSummary }) {
  const theme = useTheme();

  const documents = [
    { label: "Fresh", value: summary.documents.fresh, fill: theme.color.status.completed.dot },
    { label: "Due", value: summary.documents.due, fill: theme.color.status.running.dot },
    { label: "Overdue", value: summary.documents.overdue, fill: theme.color.status.failed.dot }
  ];
  const sources = [
    { label: "Fresh", value: summary.sources.fresh, fill: theme.color.status.completed.dot },
    { label: "Stale", value: summary.sources.stale, fill: theme.color.status.failed.dot }
  ];

  return (
    <Grid>
      <Panel>
        <Caption>Documents by review cycle</Caption>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={documents} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
            <Tooltip />
            <Bar dataKey="value" name="Documents" radius={[3, 3, 0, 0]}>
              {documents.map((entry) => (
                <Cell key={entry.label} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Panel>
      <Panel>
        <Caption>Sources by last sync</Caption>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={sources} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.color.border} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: theme.color.textMuted }} tickLine={false} />
            <Tooltip />
            <Bar dataKey="value" name="Sources" radius={[3, 3, 0, 0]}>
              {sources.map((entry) => (
                <Cell key={entry.label} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Panel>
    </Grid>
  );
}
