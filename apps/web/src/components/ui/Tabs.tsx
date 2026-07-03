import type { ReactNode } from "react";
import styled from "@emotion/styled";

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
}

export interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
}

const TabList = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space.xs
}));

const Tab = styled.button<{ $active: boolean }>(({ theme, $active }) => ({
  minHeight: "32px",
  padding: `6px ${theme.space.lg}`,
  border: `1px solid ${$active ? theme.color.accentBorder : "transparent"}`,
  borderRadius: theme.radius.sm,
  background: $active ? theme.color.accentBg : "transparent",
  color: $active ? theme.color.accent : theme.color.textMuted,
  fontFamily: theme.font.sans,
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.semibold,
  cursor: "pointer",
  transition: "background 120ms ease, color 120ms ease",
  "&:hover:not(:disabled)": { color: $active ? theme.color.accent : theme.color.text },
  "&:disabled": { cursor: "not-allowed", opacity: 0.55 }
}));

export function Tabs<T extends string>({ items, value, onChange, ...rest }: TabsProps<T>) {
  return (
    <TabList role="tablist" aria-label={rest["aria-label"]}>
      {items.map((item) => (
        <Tab
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          $active={item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </Tab>
      ))}
    </TabList>
  );
}
