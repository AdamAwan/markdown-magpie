"use client";

import type { ReactNode } from "react";
import styled from "@emotion/styled";
import { Surface, EmptyState } from "../ui";

const Title = styled.h2(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.lg,
  fontWeight: theme.font.weight.semibold
}));

const Subtitle = styled.p(({ theme }) => ({
  margin: `${theme.space.xs} 0 0`,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

const Message = styled(EmptyState)({ borderTop: "none", paddingTop: 0 });

export interface ChartCardProps {
  title: string;
  subtitle?: string;
  loading: boolean;
  error?: string;
  // True when the fetch succeeded but there is nothing to plot.
  empty: boolean;
  emptyMessage?: string;
  children: ReactNode;
}

// Shared chrome for every insight chart: a titled Surface that renders the chart
// only once data has loaded, and shows loading/error/empty states otherwise so
// each chart component can assume it always has data to draw.
export function ChartCard({
  title,
  subtitle,
  loading,
  error,
  empty,
  emptyMessage = "No data in the last 30 days yet.",
  children
}: ChartCardProps) {
  return (
    <Surface>
      <Surface.Header>
        <div>
          <Title>{title}</Title>
          {subtitle ? <Subtitle>{subtitle}</Subtitle> : null}
        </div>
      </Surface.Header>
      <Surface.Body>
        {loading ? (
          <Message>Loading…</Message>
        ) : error ? (
          <Message role="alert">Couldn’t load this chart: {error}</Message>
        ) : empty ? (
          <Message>{emptyMessage}</Message>
        ) : (
          children
        )}
      </Surface.Body>
    </Surface>
  );
}
