import styled from "@emotion/styled";

export interface Stat {
  label: string;
  value: number;
}

// A wrapping row of labelled count tiles. Presentational only — callers derive
// the numbers. Used by the questionnaire detail page for its item-state
// breakdown; kept generic so other summaries can reuse it.
export function StatBanner({ stats }: { stats: Stat[] }) {
  return (
    <Banner>
      {stats.map((stat) => (
        <Tile key={stat.label}>
          <Value>{stat.value}</Value>
          <Label>{stat.label}</Label>
        </Tile>
      ))}
    </Banner>
  );
}

const Banner = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space.md
}));

const Tile = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xs,
  flex: "1 1 auto",
  minWidth: "96px",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  padding: `${theme.space.md} ${theme.space.lg}`
}));

const Value = styled.span(({ theme }) => ({
  color: theme.color.text,
  fontSize: theme.font.size.xxl,
  fontWeight: theme.font.weight.semibold,
  fontVariantNumeric: "tabular-nums",
  lineHeight: 1.1
}));

const Label = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.medium
}));
