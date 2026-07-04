import type { HTMLAttributes, ReactNode } from "react";
import styled from "@emotion/styled";
import type { StatusTone } from "../../theme/theme";

type BadgeTone = StatusTone | "accent";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Show a leading status dot in the tone colour. */
  dot?: boolean;
  /** Render the label in the monospace family (job types, keys, ids). */
  mono?: boolean;
  children: ReactNode;
}

const StyledBadge = styled.span<{ $tone: BadgeTone; $mono: boolean }>(({ theme, $tone, $mono }) => {
  const palette = $tone === "accent"
    ? { fg: theme.color.accent, bg: theme.color.accentBg, border: theme.color.accentBorder }
    : theme.color.status[$tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: theme.space.sm,
    minHeight: "24px",
    padding: `3px ${theme.space.md}`,
    border: `1px solid ${palette.border}`,
    borderRadius: theme.radius.sm,
    background: palette.bg,
    color: palette.fg,
    fontFamily: $mono ? theme.font.mono : theme.font.sans,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.semibold,
    whiteSpace: "nowrap"
  };
});

const Dot = styled.span<{ $tone: BadgeTone }>(({ theme, $tone }) => ({
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  flexShrink: 0,
  background: $tone === "accent" ? theme.color.accent : theme.color.status[$tone].dot
}));

export function Badge({ tone = "neutral", dot = false, mono = false, children, ...rest }: BadgeProps) {
  return (
    <StyledBadge $tone={tone} $mono={mono} data-tone={tone} {...rest}>
      {dot ? <Dot $tone={tone} aria-hidden /> : null}
      {children}
    </StyledBadge>
  );
}

const GREEN = new Set([
  "high", "medium", "completed", "good", "ready", "branch-pushed", "pr-opened", "merged",
  "repository-root", "succeeded", "success"
]);
const RED = new Set(["low", "failed", "bad", "rejected", "not-git", "error", "cancelled"]);
const BLUE = new Set(["unknown", "pending", "claimed", "subdirectory", "queued", "created"]);
const ORANGE = new Set(["running", "active", "in-progress"]);

/**
 * Map a raw backend status string (job state, confidence, git context, …) to a Badge tone.
 * Consolidates the ~20 `.status.<value>` CSS variants the stylesheet used to carry.
 */
export function statusTone(value: string | undefined | null): StatusTone {
  if (!value) {
    return "neutral";
  }
  const key = value.toLowerCase();
  if (GREEN.has(key)) {
    return "completed";
  }
  if (RED.has(key)) {
    return "failed";
  }
  if (ORANGE.has(key)) {
    return "running";
  }
  if (BLUE.has(key)) {
    return "pending";
  }
  return "neutral";
}
