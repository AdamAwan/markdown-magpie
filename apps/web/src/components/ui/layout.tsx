import styled from "@emotion/styled";
import type { AppTheme } from "../../theme/theme";

type SpaceKey = keyof AppTheme["space"];
type Align = "start" | "center" | "end" | "stretch" | "baseline";

const alignMap: Record<Align, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline"
};

interface StackProps {
  gap?: SpaceKey;
  align?: Align;
}

/** Vertical flex column with a token-based gap. */
export const Stack = styled.div<StackProps>(({ theme, gap = "md", align = "stretch" }) => ({
  display: "flex",
  flexDirection: "column",
  gap: theme.space[gap],
  alignItems: alignMap[align],
  minWidth: 0
}));

interface RowProps {
  gap?: SpaceKey;
  align?: Align;
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
}

const justifyMap = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between"
} as const;

/** Horizontal flex row with a token-based gap. */
export const Row = styled.div<RowProps>(({ theme, gap = "md", align = "center", justify = "start", wrap = false }) => ({
  display: "flex",
  flexDirection: "row",
  gap: theme.space[gap],
  alignItems: alignMap[align],
  justifyContent: justifyMap[justify],
  flexWrap: wrap ? "wrap" : "nowrap",
  minWidth: 0
}));

/** Scrollable grid list — the standard capped-height feed used across panels. */
export const ScrollList = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  maxHeight: "560px",
  overflow: "auto"
}));

/** A single record in a feed: divider-topped grid block. */
export const ListRow = styled.article(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  borderTop: `1px solid ${theme.color.border}`,
  padding: `${theme.space.lg} 0`,
  minWidth: 0
}));

/** Wrapping action/metadata cluster with muted caption styling. */
export const Actions = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: theme.space.md,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

/** Empty-state line shown when a feed has no rows. */
export const EmptyState = styled.p(({ theme }) => ({
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.lg,
  color: theme.color.textMuted
}));

/** The route-level content column each page mounts its Surface(s) into. */
export const Workbench = styled.section(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: theme.space.lg,
  alignItems: "start"
}));
