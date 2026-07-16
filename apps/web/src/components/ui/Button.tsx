import { forwardRef, type ButtonHTMLAttributes } from "react";
import styled from "@emotion/styled";
import type { CSSObject } from "@emotion/react";
import type { AppTheme } from "../../theme/theme";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function variantStyles(theme: AppTheme, variant: ButtonVariant): CSSObject {
  switch (variant) {
    case "primary":
      return {
        background: theme.color.primary,
        borderColor: theme.color.primary,
        color: theme.color.primaryText,
        "&:hover:not(:disabled)": {
          background: theme.color.primaryHover,
          borderColor: theme.color.primaryHover
        }
      };
    case "danger":
      return {
        background: theme.color.surface,
        borderColor: theme.color.dangerBorder,
        color: theme.color.dangerText,
        "&:hover:not(:disabled)": { background: theme.color.dangerBg }
      };
    case "ghost":
      return {
        background: "transparent",
        borderColor: "transparent",
        color: theme.color.textMuted,
        "&:hover:not(:disabled)": {
          background: theme.color.surfaceMuted,
          color: theme.color.text
        }
      };
    case "secondary":
    default:
      return {
        background: theme.color.surface,
        borderColor: theme.color.borderStrong,
        color: theme.color.text,
        "&:hover:not(:disabled)": { background: theme.color.surfaceMuted }
      };
  }
}

const StyledButton = styled.button<{ $variant: ButtonVariant; $size: ButtonSize }>(({ theme, $variant, $size }) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: theme.space.sm,
  border: "1px solid transparent",
  borderRadius: theme.radius.sm,
  fontFamily: theme.font.sans,
  fontWeight: theme.font.weight.semibold,
  lineHeight: 1.2,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 120ms ease, border-color 120ms ease",
  minHeight: $size === "sm" ? "30px" : "36px",
  padding: $size === "sm" ? `4px ${theme.space.md}` : `8px ${theme.space.lg}`,
  fontSize: $size === "sm" ? theme.font.size.sm : theme.font.size.md,
  ...variantStyles(theme, $variant),
  "&:disabled": { cursor: "not-allowed", opacity: 0.55 }
}));

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", type = "button", ...rest },
  ref
) {
  return <StyledButton ref={ref} type={type} $variant={variant} $size={size} {...rest} />;
});
