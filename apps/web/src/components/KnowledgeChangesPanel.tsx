"use client";

import { useEffect, useState } from "react";
import styled from "@emotion/styled";
import { apiGet, errorMessage } from "../lib/api";
import type { KnowledgeChange, KnowledgeChangesResponse } from "../lib/types";
import { Badge, EmptyState, Button, Row, ScrollList, Surface } from "./ui";
import { StatBanner } from "./StatBanner";

// The knowledge change log (docs/knowledge-changes.md): what changed in the
// destination knowledge base, when, and what caused it. It answers the two
// questions retrieval structurally cannot — "what's new this week?" (a time
// filter, not a similarity search) and "when did this change?".
//
// Fetched page-locally (the CitationUsagePanel pattern) rather than through
// ConsoleProvider, so an unbounded log query stays out of the console's 4s poll.

type Window = "week" | "month" | "all";

const PAGE_SIZE = 25;
const TIMELINE_SIZE = 8;

const WINDOWS: Array<{ value: Window; label: string; days?: number }> = [
  { value: "week", label: "Week", days: 7 },
  { value: "month", label: "Month", days: 30 },
  { value: "all", label: "All" }
];

function windowStart(window: Window, now: number): string | undefined {
  const days = WINDOWS.find((option) => option.value === window)?.days;
  return days === undefined ? undefined : new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

export function KnowledgeChangesPanel() {
  const [window, setWindow] = useState<Window>("week");
  const [data, setData] = useState<KnowledgeChangesResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const since = windowStart(window, Date.now());
    apiGet<KnowledgeChangesResponse>(
      `/knowledge/changes?limit=${PAGE_SIZE}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
      { signal: controller.signal }
    )
      .then(setData)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [window]);

  return (
    <KnowledgeChangesView data={data} error={error} loading={loading} onWindowChange={setWindow} window={window} />
  );
}

// The presentational half, split out so the rendering can be tested without a
// fetch (static rendering never runs the effect above).
export function KnowledgeChangesView({
  data,
  error,
  loading,
  onWindowChange,
  window
}: {
  data: KnowledgeChangesResponse | undefined;
  error: string | undefined;
  loading: boolean;
  onWindowChange: (next: Window) => void;
  window: Window;
}) {
  const summary = data?.summary;
  const stats = [
    { label: "Changes", value: summary?.total ?? 0 },
    { label: "Documents touched", value: summary?.documentsTouched ?? 0 },
    { label: "Sections changed", value: summary?.byKind.section_changed ?? 0 }
  ];

  return (
    <Surface>
      <Surface.Header>
        <h2>Recent changes</h2>
        <Row gap="sm">
          {WINDOWS.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={option.value === window ? "primary" : "secondary"}
              aria-pressed={option.value === window}
              onClick={() => onWindowChange(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </Row>
      </Surface.Header>
      <Surface.Body>
        <Intro>
          What actually changed in the knowledge base, observed at index time — so a hand edit or a merge that landed
          outside Magpie is recorded just as a Magpie proposal is.
        </Intro>
        <StatBanner stats={stats} />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {!error && !loading && (data?.changes.length ?? 0) === 0 ? (
          <EmptyState>{emptyMessage(summary?.logStartedAt)}</EmptyState>
        ) : null}
        {data && data.changes.length > 0 ? (
          <>
            <ScrollList>
              {data.changes.map((change) => (
                <ChangeEntry change={change} key={change.id} showPath />
              ))}
            </ScrollList>
            <Footnote>{startedNote(summary?.logStartedAt)}</Footnote>
            {summary && summary.total > data.changes.length ? (
              <Footnote>
                Showing {data.changes.length} of {summary.total}.
              </Footnote>
            ) : null}
          </>
        ) : null}
      </Surface.Body>
    </Surface>
  );
}

// One document's timeline, on the document view. Its own fetch, keyed on the
// document — a timeline is a per-document read, not part of the console poll.
export function DocumentChangeTimeline({ documentId }: { documentId: string }) {
  const [data, setData] = useState<KnowledgeChangesResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setData(undefined);
    apiGet<KnowledgeChangesResponse>(
      `/knowledge/changes?limit=${TIMELINE_SIZE}&documentId=${encodeURIComponent(documentId)}`,
      { signal: controller.signal }
    )
      .then(setData)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [documentId]);

  return <DocumentChangeTimelineView data={data} error={error} loading={loading} />;
}

export function DocumentChangeTimelineView({
  data,
  error,
  loading
}: {
  data: KnowledgeChangesResponse | undefined;
  error: string | undefined;
  loading: boolean;
}) {
  return (
    <Timeline>
      <TimelineHead>
        <h4>Change history</h4>
        {data && data.summary.total > 0 ? (
          <Badge tone="neutral" title="Recorded changes to this document">
            {data.summary.total} recorded
          </Badge>
        ) : null}
      </TimelineHead>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!error && !loading && (data?.changes.length ?? 0) === 0 ? (
        <Footnote>{emptyMessage(data?.summary.logStartedAt)}</Footnote>
      ) : null}
      {data?.changes.map((change) => (
        <ChangeEntry change={change} key={change.id} />
      ))}
    </Timeline>
  );
}

// `§ Rate tiers changed — source product-repo a1b2f3…c3d4e5 — 12 Aug`, linking to
// the proposal where one is attributed.
function ChangeEntry({ change, showPath }: { change: KnowledgeChange; showPath?: boolean }) {
  const truncation = truncationNote(change);
  return (
    <Entry>
      <EntryTop>
        <EntryLabel>
          <strong>{entryLabel(change)}</strong>
          <Meta>
            <span>{attributionLabel(change)}</span>
            <span>{formatDay(change.changedAt)}</span>
            {change.proposalId ? <a href={`/proposals#proposal-${change.proposalId}`}>Proposal</a> : null}
          </Meta>
        </EntryLabel>
        <Badge tone={kindTone(change)} title={`Change kind: ${change.kind}`}>
          {kindLabel(change.kind)}
        </Badge>
      </EntryTop>
      {showPath ? <Path>{change.path}</Path> : null}
      {change.summary ? <Summary>{change.summary}</Summary> : null}
      {truncation ? <Footnote>{truncation}</Footnote> : null}
    </Entry>
  );
}

function entryLabel(change: KnowledgeChange): string {
  const verb = change.kind.endsWith("_added") ? "added" : change.kind.endsWith("_removed") ? "removed" : "changed";
  if (change.anchor) {
    return `§ ${change.heading ?? change.anchor} ${verb}`;
  }
  return `${change.path} ${verb}`;
}

const CAUSE_LABELS: Record<KnowledgeChange["cause"], string> = {
  gap: "gap",
  source_sync: "source sync",
  patrol: "patrol",
  seed: "seed",
  // The honest label for a hand edit or a merge that happened outside Magpie.
  external: "external edit"
};

// The causing upstream commit range where one resolved, the cause otherwise.
function attributionLabel(change: KnowledgeChange): string {
  if (change.sourceId && change.sourceToSha) {
    const from = change.sourceFromSha ? `${shortSha(change.sourceFromSha)}…` : "";
    return `source ${change.sourceId} ${from}${shortSha(change.sourceToSha)}`;
  }
  return CAUSE_LABELS[change.cause];
}

// Honesty about truncation: a sync run caps the files it materializes while
// recording the true total, so an entry showing a commit range shows both numbers.
// A log that implies a completeness it does not have is the failure worth avoiding.
function truncationNote(change: KnowledgeChange): string | undefined {
  const upstream = change.upstream;
  if (!upstream || upstream.examinedFileCount >= upstream.changedFileCount) {
    return undefined;
  }
  return `${upstream.changedFileCount.toLocaleString("en-GB")} files changed upstream (${upstream.examinedFileCount.toLocaleString("en-GB")} examined)`;
}

function emptyMessage(logStartedAt: string | undefined): string {
  return logStartedAt
    ? `Nothing recorded in this window. The change log starts ${formatDay(logStartedAt)}.`
    : "Nothing recorded yet — the log starts at install and is never backfilled, so it stays empty until the knowledge base next changes.";
}

function startedNote(logStartedAt: string | undefined): string {
  return logStartedAt
    ? `Recording since ${formatDay(logStartedAt)} — the log is never backfilled, so anything older is simply unrecorded.`
    : "The log is never backfilled, so anything predating it is simply unrecorded.";
}

function kindLabel(kind: KnowledgeChange["kind"]): string {
  return kind.replace("_", " ");
}

function kindTone(change: KnowledgeChange): "completed" | "failed" | "neutral" {
  if (change.kind.endsWith("_added")) return "completed";
  if (change.kind.endsWith("_removed")) return "failed";
  return "neutral";
}

function shortSha(value: string): string {
  return value.slice(0, 8);
}

// Day and month — a change log is read at the granularity of "when did this
// move?", so a time of day would be noise. UTC-pinned so the same entry reads the
// same everywhere. Falls back to the raw value if it is not a parseable date.
const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function formatDay(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : DAY_FORMAT.format(parsed);
}

const Intro = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  lineHeight: 1.5
}));

const Entry = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xs,
  padding: `${theme.space.md} 0`,
  "&:not(:last-child)": {
    borderBottom: `1px solid ${theme.color.border}`
  }
}));

const EntryTop = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: theme.space.md
}));

const EntryLabel = styled.div(({ theme }) => ({
  display: "grid",
  gap: "2px",
  minWidth: 0,
  "& strong": {
    fontSize: theme.font.size.base,
    fontWeight: theme.font.weight.semibold
  }
}));

const Meta = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: theme.space.md,
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted,
  "& a": { color: theme.color.accent }
}));

const Path = styled.span(({ theme }) => ({
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted,
  overflowWrap: "anywhere"
}));

const Summary = styled.span(({ theme }) => ({
  fontSize: theme.font.size.sm,
  color: theme.color.text
}));

const Timeline = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xs,
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.md
}));

const TimelineHead = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.md,
  "& h4": {
    margin: 0,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.semibold
  }
}));

const Footnote = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted
}));

const ErrorNote = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.sm,
  color: theme.color.dangerText
}));
