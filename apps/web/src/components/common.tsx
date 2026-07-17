import { ReactNode } from "react";
import Link from "next/link";
import styled from "@emotion/styled";
import type { LucideIcon } from "lucide-react";
import { Citation } from "../lib/types";
import { Badge } from "./ui";

const NavLink = styled(Link, { shouldForwardProp: (prop) => prop !== "$active" })<{ $active: boolean }>(
  ({ theme, $active }) => ({
    display: "grid",
    gridTemplateColumns: "24px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: theme.space.md,
    minHeight: "40px",
    width: "100%",
    border: `1px solid ${$active ? theme.color.border : "transparent"}`,
    borderRadius: theme.radius.md,
    background: $active ? theme.color.surface : "transparent",
    color: $active ? theme.color.text : theme.color.textMuted,
    padding: theme.space.md,
    textAlign: "left",
    fontSize: theme.font.size.base,
    fontWeight: theme.font.weight.semibold,
    textDecoration: "none",
    transition: "background 120ms ease, color 120ms ease",
    "&:hover": { background: theme.color.surface, color: theme.color.text }
  })
);

// Wraps the nav icon so it sits centred in the 24px leading column. The icon
// inherits the link's colour (`currentColor`), so it tints with the active and
// hover states rather than carrying its own fixed accent.
const NavGlyph = styled.span({
  display: "inline-grid",
  width: "24px",
  height: "24px",
  placeItems: "center"
});

export function NavButton({
  active,
  count,
  icon: Icon,
  label,
  href
}: {
  active: boolean;
  count?: number;
  icon: LucideIcon;
  label: string;
  href: string;
}) {
  return (
    <NavLink $active={active} href={href} title={`Open ${label}`} aria-current={active ? "page" : undefined}>
      <NavGlyph>
        <Icon size={17} strokeWidth={2} aria-hidden="true" />
      </NavGlyph>
      <span>{label}</span>
      {count === undefined ? null : (
        <Badge tone="neutral" title={`${count} ${label.toLowerCase()} item${count === 1 ? "" : "s"}`}>
          {count}
        </Badge>
      )}
    </NavLink>
  );
}

const CitationCard = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  padding: theme.space.lg,
  textAlign: "left",
  "& strong": { fontSize: theme.font.size.md },
  "& code": { color: theme.color.textMuted, fontFamily: theme.font.mono, fontSize: theme.font.size.xs },
  "& > span": { color: theme.color.textMuted, fontFamily: theme.font.mono, fontSize: theme.font.size.sm }
}));

const CitationTop = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.lg,
  "& > strong": { flex: 1, minWidth: 0 }
}));

const CitationRelevance = styled.span(({ theme }) => ({
  flex: "none",
  color: theme.color.status.completed.fg,
  fontVariantNumeric: "tabular-nums",
  fontSize: theme.font.size.xs
}));

export function CitationRow({ citation }: { citation: Citation }) {
  return (
    <CitationCard>
      <CitationTop>
        <strong>{citation.heading}</strong>
        <code>{citation.sectionId}</code>
        <CitationRelevance title="Retrieval relevance">{Math.round(citation.relevance * 100)}%</CitationRelevance>
      </CitationTop>
      <span>
        {citation.path}
        {citation.anchor ? `#${citation.anchor}` : ""}
      </span>
      <p>{citation.excerpt}</p>
    </CitationCard>
  );
}

// A small tag naming the knowledge flow a question, gap, or cluster belongs to, so
// reviewers can see at a glance which audience/destination it routes to. Renders nothing
// for un-routed (legacy) items; falls back to the raw id when the flow is no longer
// configured.
export function FlowTag({ flowId, flowLabels }: { flowId?: string; flowLabels: Record<string, string> }) {
  if (!flowId) {
    return null;
  }
  return (
    <Badge tone="accent" title={`Knowledge flow: ${flowLabels[flowId] ?? flowId}`}>
      {flowLabels[flowId] ?? flowId}
    </Badge>
  );
}

const ContextCard = styled.div(({ theme }) => ({
  minWidth: 0,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  padding: theme.space.lg,
  "& > span": {
    display: "block",
    color: theme.color.textMuted,
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.semibold
  },
  "& > strong": {
    display: "block",
    minWidth: 0,
    marginTop: theme.space.sm,
    overflowWrap: "anywhere",
    color: theme.color.text,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
    lineHeight: 1.35
  }
}));

export function ContextValue({ label, value }: { label: string; value: string }) {
  return (
    <ContextCard>
      <span>{label}</span>
      <strong>{value}</strong>
    </ContextCard>
  );
}

// A single compact status line: muted label on the left, value on the right,
// the value truncating with an ellipsis so long model names/hosts never wrap or
// overflow their container. Shared by the topbar status popover's System group
// and the Build sub-block so the two render identically.
const StatusRowWrap = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.lg,
  fontSize: theme.font.size.sm,
  "& > span:first-of-type": {
    flexShrink: 0,
    color: theme.color.textMuted,
    fontWeight: theme.font.weight.semibold
  }
}));

const StatusRowValue = styled.span(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.sm,
  minWidth: 0,
  overflow: "hidden",
  color: theme.color.text,
  fontWeight: theme.font.weight.medium,
  whiteSpace: "nowrap",
  "& > span": { overflow: "hidden", textOverflow: "ellipsis" }
}));

export function StatusRow({
  label,
  value,
  leading,
  title
}: {
  label: string;
  value: string;
  // Optional leading adornment (e.g. a coloured status dot).
  leading?: ReactNode;
  title?: string;
}) {
  return (
    <StatusRowWrap>
      <span>{label}</span>
      <StatusRowValue title={title ?? value}>
        {leading}
        <span>{value}</span>
      </StatusRowValue>
    </StatusRowWrap>
  );
}
