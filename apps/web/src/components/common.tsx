import Link from "next/link";
import styled from "@emotion/styled";
import { Citation, ConsoleNotice } from "../lib/types";
import { Badge, Chip } from "./ui";
import type { StatusTone } from "../theme/theme";

const noticeTone: Record<ConsoleNotice["tone"], StatusTone> = {
  warning: "running",
  info: "pending",
  danger: "failed"
};

const AttentionList = styled.section(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  marginBottom: theme.space.lg
}));

const Notice = styled.article<{ $tone: StatusTone }>(({ theme, $tone }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: theme.space.lg,
  alignItems: "center",
  border: `1px solid ${theme.color.status[$tone].border}`,
  borderRadius: theme.radius.card,
  background: theme.color.status[$tone].bg,
  padding: `${theme.space.lg} ${theme.space.xl}`,
  "& h2": { marginBottom: theme.space.xs }
}));

export function AttentionPanel({ notices }: { notices: ConsoleNotice[] }) {
  return (
    <AttentionList aria-label="System notices">
      {notices.map((notice) => (
        <Notice $tone={noticeTone[notice.tone]} key={notice.id}>
          <div>
            <h2>{notice.title}</h2>
            <p>{notice.body}</p>
          </div>
          {notice.action && notice.actionLabel ? (
            <Chip onClick={notice.action}>{notice.actionLabel}</Chip>
          ) : null}
        </Notice>
      ))}
    </AttentionList>
  );
}

const NavLink = styled(Link)<{ $active: boolean }>(({ theme, $active }) => ({
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
}));

const NavGlyph = styled.span(({ theme }) => ({
  display: "inline-grid",
  width: "24px",
  height: "24px",
  placeItems: "center",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.sm,
  color: theme.color.accent,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.bold
}));

export function NavButton({
  active,
  count,
  glyph,
  label,
  href
}: {
  active: boolean;
  count?: number;
  glyph: string;
  label: string;
  href: string;
}) {
  return (
    <NavLink
      $active={active}
      href={href}
      title={`Open ${label}`}
      aria-current={active ? "page" : undefined}
    >
      <NavGlyph>{glyph}</NavGlyph>
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
        <CitationRelevance title="Retrieval relevance">
          {Math.round(citation.relevance * 100)}%
        </CitationRelevance>
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
