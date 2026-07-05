import { useCallback, useEffect, useState } from "react";
import styled from "@emotion/styled";
import { apiGet, apiPost, errorMessage } from "../lib/api";
import type { ParkedView } from "../lib/types";
import { FlowTag } from "./common";
import { Actions, Badge, Button, EmptyState, ListRow, Row, ScrollList, Surface } from "./ui";

// Parked questions: gap-closure verification failed past the retry cap, so the
// question is frozen from auto-redrafting and waits for a human (issue #158). This
// panel is the human's surface — the diagnostic note plus Retry / Dismiss.

const Question = styled.p(({ theme }) => ({
  margin: 0,
  fontWeight: theme.font.weight.semibold,
  color: theme.color.text,
  minWidth: 0
}));

const Note = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.sm,
  lineHeight: 1.45,
  color: theme.color.textMuted,
  whiteSpace: "pre-wrap"
}));

const ErrorLine = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.status.failed.fg,
  fontSize: theme.font.size.sm
}));

export function ParkedQuestionsPanel({ flowLabels }: { flowLabels: Record<string, string> }) {
  const [view, setView] = useState<ParkedView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setView(await apiGet<ParkedView>("/api/questions/parked"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (questionId: string, action: "retry" | "dismiss") => {
      setBusyId(questionId);
      try {
        await apiPost(`/api/questions/${questionId}/gap/${action}`, {});
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const questions = view?.questions ?? [];
  const proposals = view?.proposals ?? [];
  const total = questions.length + proposals.length;

  return (
    <Surface id="parked-questions">
      <Surface.Header>
        <Row gap="md">
          <strong>Parked questions</strong>
          {total > 0 ? <Badge tone="failed">{total}</Badge> : null}
        </Row>
      </Surface.Header>
      <Surface.Body>
        {error ? <ErrorLine role="alert">{error}</ErrorLine> : null}
        {loading ? (
          <EmptyState>Loading…</EmptyState>
        ) : total === 0 ? (
          // Only claim "all clear" when we actually loaded — a failed fetch keeps
          // view null, which must not read as "nothing is parked" (#158 review #3).
          error ? null : (
            <EmptyState>No questions are parked — every escalation has been handled.</EmptyState>
          )
        ) : (
          <ScrollList>
            {questions.map((q) => (
              <ListRow key={q.questionId}>
                <Row gap="sm" justify="between" align="start">
                  <Question>{q.question}</Question>
                  <FlowTag flowId={q.flowId} flowLabels={flowLabels} />
                </Row>
                <Note>{q.note ?? "Verification failed repeatedly; awaiting a human."}</Note>
                <Actions>
                  <span>Parked {new Date(q.parkedAt).toLocaleString()}</span>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busyId === q.questionId}
                    onClick={() => void act(q.questionId, "retry")}
                  >
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === q.questionId}
                    onClick={() => void act(q.questionId, "dismiss")}
                  >
                    Dismiss
                  </Button>
                </Actions>
              </ListRow>
            ))}
            {proposals.map((p) => (
              <ListRow key={p.proposalId}>
                <Row gap="sm" justify="between" align="start">
                  <Question>{p.title}</Question>
                  <Badge tone="failed">Triggering question deleted</Badge>
                </Row>
                <Note>
                  This merged proposal was parked, but its triggering question was deleted — there is nothing to retry.
                  Review the proposal directly on the Proposals page.
                </Note>
              </ListRow>
            ))}
          </ScrollList>
        )}
      </Surface.Body>
    </Surface>
  );
}
