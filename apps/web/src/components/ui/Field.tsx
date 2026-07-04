import type { LabelHTMLAttributes, ReactNode } from "react";
import styled from "@emotion/styled";
import type { CSSObject } from "@emotion/react";
import type { AppTheme } from "../../theme/theme";

const controlBase = (theme: AppTheme): CSSObject => ({
  width: "100%",
  minHeight: "38px",
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.sm,
  background: theme.color.surface,
  color: theme.color.text,
  fontFamily: theme.font.sans,
  fontSize: theme.font.size.base,
  padding: `8px ${theme.space.lg}`,
  transition: "border-color 120ms ease, box-shadow 120ms ease",
  "&:focus": {
    outline: "none",
    borderColor: theme.color.accent,
    boxShadow: `0 0 0 3px ${theme.color.accentBg}`
  },
  "&:disabled": { cursor: "not-allowed", opacity: 0.55 }
});

export const Input = styled.input(({ theme }) => controlBase(theme));

export const Textarea = styled.textarea(({ theme }) => ({
  ...controlBase(theme),
  minHeight: "96px",
  resize: "vertical",
  lineHeight: 1.5
}));

export const Select = styled.select(({ theme }) => controlBase(theme));

const FieldRoot = styled.label(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm,
  minWidth: 0
}));

const FieldLabel = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold
}));

interface FieldProps extends LabelHTMLAttributes<HTMLLabelElement> {
  label: ReactNode;
  children: ReactNode;
}

/** Labelled form control wrapper: `<label>` with a small caption above its control. */
export function Field({ label, children, ...rest }: FieldProps) {
  return (
    <FieldRoot {...rest}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </FieldRoot>
  );
}
