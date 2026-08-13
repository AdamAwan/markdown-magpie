"use client";

import { useCallback, useEffect, useState } from "react";
import styled from "@emotion/styled";
import { apiGet, apiPatch, errorMessage } from "../lib/api";
import { Actions, Badge, Button, EmptyState, ScrollList, Surface, Textarea } from "./ui";

// One side of a disagreement, as the verify agent read it.
interface SourceConflictPosition {
  sourceId: string;
  path: string;
  statement: string;
  lines?: string;
}

interface SourceConflict {
  id: string;
  flowId?: string;
  documentPath: string;
  anchor: string;
  topic: string;
  summary: string;
  claim: string;
  positions: SourceConflictPosition[];
  status: "open" | "resolved" | "dismissed";
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  agreedStatement?: string;
  dismissalNote?: string;
}

const FILTERS = ["open", "resolved", "dismissed"] as const;
type Filter = (typeof FILTERS)[number];

const Intro = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.sm,
  color: theme.color.textMuted,
  maxWidth: "70ch",
  lineHeight: 1.5
}));

const Filters = styled.div(({ theme }) => ({
  display: "flex",
  gap: theme.space.xs
}));

const ConflictRow = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  "&:not(:last-child)": {
    paddingBottom: theme.space.lg,
    borderBottom: `1px solid ${theme.color.border}`
  }
}));

const TopicRow = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: theme.space.md,
  flexWrap: "wrap",
  "& h3": {
    margin: 0,
    fontSize: theme.font.size.base,
    fontWeight: theme.font.weight.semibold
  }
}));

const Summary = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.sm,
  lineHeight: 1.5
}));

const Positions = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm,
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))"
}));

const Position = styled.div(({ theme }) => ({
  padding: theme.space.md,
  background: theme.color.surfaceMuted,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.sm,
  display: "grid",
  gap: theme.space.xs
}));

const PositionPath = styled.code(({ theme }) => ({
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted,
  wordBreak: "break-all"
}));

const Statement = styled.span(({ theme }) => ({
  fontSize: theme.font.size.sm,
  lineHeight: 1.4
}));

const Meta = styled.div(({ theme }) => ({
  display: "flex",
  gap: theme.space.lg,
  flexWrap: "wrap",
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted
}));

const Error = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.sm,
  color: theme.color.danger
}));

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function SourceConflictsPanel() {
  const [filter, setFilter] = useState<Filter>("open");
  const [conflicts, setConflicts] = useState<SourceConflict[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [dismissingId, setDismissingId] = useState<string | undefined>();
  const [note, setNote] = useState("");

  const load = useCallback(async (status: Filter) => {
    try {
      const body = await apiGet<{ conflicts: SourceConflict[] }>(`/source-conflicts?status=${status}`);
      setConflicts(body.conflicts);
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const dismiss = async (id: string): Promise<void> => {
    try {
      await apiPatch(`/source-conflicts/${id}`, { status: "dismissed", note });
      setDismissingId(undefined);
      setNote("");
      await load(filter);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <Surface>
      <Surface.Header>
        <h2>Source conflicts</h2>
        <Filters>
          {FILTERS.map((value) => (
            <Button key={value} variant={value === filter ? "primary" : "ghost"} onClick={() => setFilter(value)}>
              {value}
            </Button>
          ))}
        </Filters>
      </Surface.Header>
      <Surface.Body>
        <Intro>
          Places where the sources disagree with each other about something the knowledge base asserts. Magpie does not
          choose between sources — fix the disagreement in the sources themselves and the next correctness patrol will
          close this and restate the agreed value. Dismiss a conflict that is not real.
        </Intro>

        {error ? <Error>{error}</Error> : null}

        {conflicts.length === 0 ? (
          <EmptyState>{filter === "open" ? "No open source conflicts." : `No ${filter} source conflicts.`}</EmptyState>
        ) : (
          <ScrollList>
            {conflicts.map((conflict) => (
              <ConflictRow key={conflict.id}>
                <TopicRow>
                  <h3>{conflict.topic}</h3>
                  <Badge>{conflict.status}</Badge>
                </TopicRow>
                <Summary>{conflict.summary}</Summary>
                <Positions>
                  {conflict.positions.map((position, index) => (
                    <Position key={`${position.sourceId}:${position.path}:${index}`}>
                      <Badge>{position.sourceId}</Badge>
                      <PositionPath>
                        {position.path}
                        {position.lines ? ` (${position.lines})` : ""}
                      </PositionPath>
                      <Statement>{position.statement}</Statement>
                    </Position>
                  ))}
                </Positions>
                <Meta>
                  <span>
                    Document: <code>{conflict.documentPath}</code>
                    {conflict.anchor ? ` · ${conflict.anchor}` : ""}
                  </span>
                  {conflict.flowId ? <span>Flow: {conflict.flowId}</span> : null}
                  <span>First seen {formatDate(conflict.firstSeenAt)}</span>
                  <span>
                    Last seen {formatDate(conflict.lastSeenAt)} ({conflict.seenCount}×)
                  </span>
                </Meta>
                {conflict.agreedStatement ? <Meta>Sources now agree: {conflict.agreedStatement}</Meta> : null}
                {conflict.dismissalNote ? <Meta>Dismissed: {conflict.dismissalNote}</Meta> : null}
                {conflict.status === "open" ? (
                  dismissingId === conflict.id ? (
                    <>
                      <Textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Why is this not a real conflict?"
                        rows={2}
                      />
                      <Actions>
                        <Button onClick={() => void dismiss(conflict.id)}>Confirm dismiss</Button>
                        <Button variant="ghost" onClick={() => setDismissingId(undefined)}>
                          Cancel
                        </Button>
                      </Actions>
                    </>
                  ) : (
                    <Actions>
                      <Button variant="ghost" onClick={() => setDismissingId(conflict.id)}>
                        Dismiss
                      </Button>
                    </Actions>
                  )
                ) : null}
              </ConflictRow>
            ))}
          </ScrollList>
        )}
      </Surface.Body>
    </Surface>
  );
}
