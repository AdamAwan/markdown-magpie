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

export interface StackProps {
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

export interface RowProps {
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
export const Row = styled.div<RowProps>(
  ({ theme, gap = "md", align = "center", justify = "start", wrap = false }) => ({
    display: "flex",
    flexDirection: "row",
    gap: theme.space[gap],
    alignItems: alignMap[align],
    justifyContent: justifyMap[justify],
    flexWrap: wrap ? "wrap" : "nowrap",
    minWidth: 0
  })
);
