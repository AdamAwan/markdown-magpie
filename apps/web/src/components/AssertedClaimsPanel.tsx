"use client";

import type { AssertedClaim } from "@magpie/core";
import { useCallback, useEffect, useState } from "react";
import styled from "@emotion/styled";
import { apiGet, apiPatch, errorMessage } from "../lib/api";
import { Actions, Badge, Button, EmptyState, ScrollList, Surface, Textarea } from "./ui";

// The asserted-claims register (questionnaire ingestion): things the
// organisation has told customers that its own sources do not support.
//
// Two kinds down one pipe — `unsubstantiated` (nothing anywhere asserts it) and
// `contradicted` (the sources say otherwise) — because both resolve the same
// way: a human points at a source, corrects the record, or dismisses.

const FILTERS = ["open", "resolved", "dismissed"] as const;
type Filter = (typeof FILTERS)[number];
type Closing = { id: string; status: "resolved" | "dismissed" };

export function AssertedClaimsPanel() {
  const [filter, setFilter] = useState<Filter>("open");
  const [claims, setClaims] = useState<AssertedClaim[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [closing, setClosing] = useState<Closing | undefined>();
  const [note, setNote] = useState("");

  const load = useCallback(async (status: Filter) => {
    try {
      const body = await apiGet<{ claims: AssertedClaim[] }>(`/asserted-claims?status=${status}`);
      setClaims(body.claims);
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const close = async (): Promise<void> => {
    if (!closing) return;
    try {
      await apiPatch(`/asserted-claims/${closing.id}`, { status: closing.status, note });
      setClosing(undefined);
      setNote("");
      await load(filter);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <Surface>
      <Head>
        <div>
          <h2>Asserted claims</h2>
          <Intro>
            Claims made in questionnaire answers the organisation has already sent out, that its own sources do not
            support — either because nothing anywhere asserts them, or because the sources say something different.
            Resolve one by pointing at the source material that now backs it; dismiss one whose answer was wrong and has
            been withdrawn. Either way the reason is recorded, because that record is the point.
          </Intro>
        </div>
        <Filters>
          {FILTERS.map((value) => (
            <Button key={value} variant={value === filter ? "primary" : "ghost"} onClick={() => setFilter(value)}>
              {value}
            </Button>
          ))}
        </Filters>
      </Head>

      {error ? <ErrorText>{error}</ErrorText> : null}

      {claims.length === 0 ? (
        <EmptyState>
          {filter === "open" ? "Nothing unsupported on record." : `No ${filter} asserted claims.`}
        </EmptyState>
      ) : (
        <ScrollList>
          {claims.map((claim) => (
            <ClaimRow key={claim.id}>
              <Row>
                <Badge tone={claim.kind === "unsubstantiated" ? "failed" : "running"}>{claim.kind}</Badge>
                {claim.flowId ? <Badge tone="neutral">{claim.flowId}</Badge> : null}
                <Claim>{claim.claim}</Claim>
              </Row>
              <Question>Asked: {claim.question}</Question>

              {claim.positions.length > 0 ? (
                <Positions>
                  {claim.positions.map((position, index) => (
                    <Position key={`${position.sourceId}-${position.path}-${index}`}>
                      <PositionPath>
                        {position.sourceId} · {position.path}
                      </PositionPath>
                      <Statement>{position.statement}</Statement>
                    </Position>
                  ))}
                </Positions>
              ) : null}

              <Meta>
                <span>first seen {formatDate(claim.firstSeenAt)}</span>
                <span>seen {claim.seenCount}×</span>
                {claim.resolutionNote ? <span>note: {claim.resolutionNote}</span> : null}
              </Meta>

              {claim.status === "open" ? (
                closing?.id === claim.id ? (
                  <Stack>
                    <Textarea
                      rows={2}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder={
                        closing.status === "resolved"
                          ? "Which source now backs this claim?"
                          : "Why is this not a real problem?"
                      }
                    />
                    <Actions>
                      <Button variant="primary" disabled={note.trim().length === 0} onClick={() => void close()}>
                        Confirm {closing.status === "resolved" ? "resolve" : "dismiss"}
                      </Button>
                      <Button variant="ghost" onClick={() => setClosing(undefined)}>
                        Cancel
                      </Button>
                    </Actions>
                  </Stack>
                ) : (
                  <Actions>
                    <Button variant="secondary" onClick={() => setClosing({ id: claim.id, status: "resolved" })}>
                      Resolve
                    </Button>
                    <Button variant="ghost" onClick={() => setClosing({ id: claim.id, status: "dismissed" })}>
                      Dismiss
                    </Button>
                  </Actions>
                )
              ) : null}
            </ClaimRow>
          ))}
        </ScrollList>
      )}
    </Surface>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

const Head = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: theme.space.md,
  marginBottom: theme.space.lg,
  flexWrap: "wrap"
}));

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

const ClaimRow = styled.div(({ theme }) => ({
  padding: `${theme.space.lg} 0`,
  display: "grid",
  gap: theme.space.sm
}));

const Row = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.sm,
  flexWrap: "wrap"
}));

const Claim = styled.strong(({ theme }) => ({
  fontSize: theme.font.size.sm,
  lineHeight: 1.4
}));

const Question = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted
}));

const Positions = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm
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

const Stack = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm
}));

const ErrorText = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.sm,
  color: theme.color.danger
}));
