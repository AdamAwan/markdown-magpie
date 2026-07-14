"use client";

import styled from "@emotion/styled";
import { UiNotification } from "../lib/types";
import { IconButton } from "./ui";
import type { StatusTone } from "../theme/theme";

const toastStatusTone: Record<UiNotification["tone"], StatusTone> = {
  danger: "failed",
  success: "completed",
  info: "pending"
};

// Fixed-position overlay: toasts float over the content, so feedback never
// moves the page the way the old inline banner did.
const Stack = styled.div(({ theme }) => ({
  position: "fixed",
  right: theme.space.xl,
  bottom: theme.space.xl,
  zIndex: 60,
  display: "grid",
  gap: theme.space.md,
  width: "min(340px, calc(100vw - 32px))"
}));

const Toast = styled.div<{ $tone: StatusTone }>(({ theme, $tone }) => ({
  display: "flex",
  alignItems: "flex-start",
  gap: theme.space.md,
  border: `1px solid ${theme.color.status[$tone].border}`,
  borderLeft: `4px solid ${theme.color.status[$tone].dot}`,
  borderRadius: theme.radius.md,
  background: theme.color.surface,
  color: theme.color.text,
  boxShadow: "0 10px 28px -16px rgba(23, 33, 29, 0.5)",
  padding: `${theme.space.md} ${theme.space.lg}`,
  fontSize: theme.font.size.base,
  fontWeight: theme.font.weight.medium,
  "& > span": { flex: 1, minWidth: 0, paddingTop: "3px" },
  animation: "magpie-toast-in 160ms ease",
  "@keyframes magpie-toast-in": {
    from: { transform: "translateY(8px)", opacity: 0 },
    to: { transform: "none", opacity: 1 }
  },
  "@media (prefers-reduced-motion: reduce)": { animation: "none" }
}));

interface ToastStackProps {
  toasts: UiNotification[];
  onDismiss: (id: number) => void;
}

// Transient view of the newest notifications: the provider adds each shown
// message here and removes it after its timeout (or on manual dismiss). The
// notification itself stays in the status pill's Recent list.
export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <Stack role="status" aria-live="polite">
      {toasts.map((toast) => (
        <Toast $tone={toastStatusTone[toast.tone]} data-tone={toast.tone} key={toast.id}>
          <span>{toast.text}</span>
          <IconButton label="Dismiss" size="sm" onClick={() => onDismiss(toast.id)}>
            ✕
          </IconButton>
        </Toast>
      ))}
    </Stack>
  );
}
