"use client";

import { useEffect, useState } from "react";
import styled from "@emotion/styled";
import { apiGet, errorMessage } from "../lib/api";
import type { CitationUsageResponse, CitationUsageRow } from "../lib/types";
import { Badge, Button, EmptyState, Row, ScrollList, Surface } from "./ui";
import { StatBanner } from "./StatBanner";

// Citation usage: how often each section (or document) of the knowledge base has
// actually been cited by an answer, ranked least-used first. Read-only evidence
// for a human deciding what a trim would cost — nothing here acts on the numbers.
//
// Fetched page-locally (the Insights pattern) rather than through ConsoleProvider:
// it is a whole-index aggregate, too heavy for the console's 4s poll.

type Group = "section" | "document";
type Sort = "least" | "most";

const PAGE_SIZE = 25;

export function CitationUsagePanel() {
  const [group, setGroup] = useState<Group>("document");
  const [sort, setSort] = useState<Sort>("least");
  const [data, setData] = useState<CitationUsageResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    apiGet<CitationUsageResponse>(`/knowledge/citation-usage?group=${group}&sort=${sort}&limit=${PAGE_SIZE}`, {
      signal: controller.signal
    })
      .then(setData)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [group, sort]);

  return (
    <CitationUsageView
      data={data}
      error={error}
      group={group}
      loading={loading}
      onGroupChange={setGroup}
      onSortChange={setSort}
      sort={sort}
    />
  );
}

// The presentational half, split out so the rendering can be tested without a
// fetch (static rendering never runs the effect above).
export function CitationUsageView({
  data,
  error,
  group,
  loading,
  onGroupChange,
  onSortChange,
  sort
}: {
  data: CitationUsageResponse | undefined;
  error: string | undefined;
  group: Group;
  loading: boolean;
  onGroupChange: (next: Group) => void;
  onSortChange: (next: Sort) => void;
  sort: Sort;
}) {
  const summary = data?.summary;
  const stats =
    group === "document"
      ? [
          { label: "Documents", value: summary?.indexedDocuments ?? 0 },
          { label: "Never cited", value: summary?.uncitedDocuments ?? 0 },
          { label: "Citations", value: summary?.totalCitations ?? 0 }
        ]
      : [
          { label: "Sections", value: summary?.indexedSections ?? 0 },
          { label: "Never cited", value: summary?.uncitedSections ?? 0 },
          { label: "Citations", value: summary?.totalCitations ?? 0 }
        ];

  return (
    <Surface>
      <Surface.Header>
        <h2>Citation usage</h2>
        <Row gap="sm">
          <Toggle
            options={[
              { value: "document", label: "Documents" },
              { value: "section", label: "Sections" }
            ]}
            value={group}
            onChange={onGroupChange}
          />
          <Toggle
            options={[
              { value: "least", label: "Least used" },
              { value: "most", label: "Most used" }
            ]}
            value={sort}
            onChange={onSortChange}
          />
        </Row>
      </Surface.Header>
      <Surface.Body>
        <Intro>
          How often each {group === "document" ? "document" : "section"} has been cited in an answer, counted once per
          question. Verification re-asks are excluded. Use it to see what a trim would actually cost — nothing is
          removed automatically.
        </Intro>
        <StatBanner stats={stats} />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {!error && !loading && (data?.rows.length ?? 0) === 0 ? (
          <EmptyState>Nothing indexed yet — index a knowledge destination to see its citation usage.</EmptyState>
        ) : null}
        {data && data.rows.length > 0 ? (
          <>
            <ScrollList>
              {data.rows.map((row) => (
                <UsageRow key={row.key} row={row} />
              ))}
            </ScrollList>
            {data.total > data.rows.length ? (
              <Footnote>
                Showing {data.rows.length} of {data.total}.
              </Footnote>
            ) : null}
            {summary && summary.unindexedUsageRows > 0 ? (
              <Footnote>
                {summary.unindexedUsageRows} counted {summary.unindexedUsageRows === 1 ? "section is" : "sections are"}{" "}
                no longer indexed — renamed headings, or cited content that has since been removed.
              </Footnote>
            ) : null}
          </>
        ) : null}
      </Surface.Body>
    </Surface>
  );
}

function UsageRow({ row }: { row: CitationUsageRow }) {
  const cited = row.citationCount > 0;
  return (
    <Entry>
      <EntryTop>
        <EntryLabel>
          <h4>{row.label}</h4>
          <Path>
            {row.path}
            {row.anchor ? `#${row.anchor}` : ""}
          </Path>
        </EntryLabel>
        <Badge tone={cited ? "completed" : "neutral"} title={cited ? "Cited by answers" : "Never cited by an answer"}>
          {row.citationCount} {row.citationCount === 1 ? "citation" : "citations"}
        </Badge>
      </EntryTop>
      <Meta>
        {row.sectionCount !== undefined ? (
          <span>
            {row.citedSectionCount ?? 0}/{row.sectionCount} sections cited
          </span>
        ) : null}
        <span>{row.lastCitedAt ? `Last cited ${formatDay(row.lastCitedAt)}` : "Never cited"}</span>
        {row.firstCitedAt ? <span>First cited {formatDay(row.firstCitedAt)}</span> : null}
        {row.indexed ? null : <Badge tone="pending">No longer indexed</Badge>}
      </Meta>
    </Entry>
  );
}

// Date only — the report is about months-long usage trends, so a time of day
// would be noise. Falls back to the raw value if it is not a parseable date.
function formatDay(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}

function Toggle<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <Row gap="xs">
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={option.value === value ? "primary" : "secondary"}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </Row>
  );
}

const Intro = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  lineHeight: 1.5
}));

const Entry = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm,
  padding: `${theme.space.md} 0`,
  "&:not(:last-child)": {
    borderBottom: `1px solid ${theme.color.border}`
  }
}));

const EntryTop = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: theme.space.md,
  "& h4": {
    margin: 0,
    fontSize: theme.font.size.base,
    fontWeight: theme.font.weight.semibold
  }
}));

const EntryLabel = styled.div({
  display: "grid",
  gap: "2px",
  minWidth: 0
});

const Path = styled.span(({ theme }) => ({
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted,
  overflowWrap: "anywhere"
}));

const Meta = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: theme.space.lg,
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted
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
