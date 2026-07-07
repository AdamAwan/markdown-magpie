import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import styled from "@emotion/styled";

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Whether the chip is currently active/toggled on. */
  selected?: boolean;
  children: ReactNode;
}

const StyledChip = styled.button<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: theme.space.sm,
  minHeight: "24px",
  padding: `3px ${theme.space.md}`,
  borderRadius: theme.radius.sm,
  fontFamily: theme.font.sans,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  whiteSpace: "nowrap",
  cursor: "pointer",
  transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
  border: `1px solid ${$selected ? theme.color.accentBorder : theme.color.border}`,
  background: $selected ? theme.color.accentBg : theme.color.surface,
  color: $selected ? theme.color.accent : theme.color.textMuted,
  "&:hover:not(:disabled)": {
    borderColor: $selected ? theme.color.accent : theme.color.borderStrong,
    color: $selected ? theme.color.accent : theme.color.text
  },
  "&:disabled": { cursor: "not-allowed", opacity: 0.55 }
}));

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected = false, type = "button", children, ...rest },
  ref
) {
  return (
    <StyledChip
      ref={ref}
      type={type}
      $selected={selected}
      aria-pressed={selected}
      data-selected={selected}
      {...rest}
    >
      {children}
    </StyledChip>
  );
});
