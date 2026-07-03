import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import styled from "@emotion/styled";

export type IconButtonSize = "sm" | "md";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name — required because the button has no visible text. */
  label: string;
  size?: IconButtonSize;
  children: ReactNode;
}

const StyledIconButton = styled.button<{ $size: IconButtonSize }>(({ theme, $size }) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: $size === "sm" ? "30px" : "34px",
  height: $size === "sm" ? "30px" : "34px",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.sm,
  background: theme.color.surface,
  color: theme.color.textMuted,
  cursor: "pointer",
  transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
  "&:hover:not(:disabled)": {
    background: theme.color.surfaceMuted,
    borderColor: theme.color.borderStrong,
    color: theme.color.text
  },
  "&:disabled": { cursor: "not-allowed", opacity: 0.55 }
}));

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", type = "button", children, ...rest },
  ref
) {
  return (
    <StyledIconButton ref={ref} type={type} aria-label={label} title={label} $size={size} {...rest}>
      {children}
    </StyledIconButton>
  );
});
