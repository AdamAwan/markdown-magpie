import { FormEvent, useEffect, useState } from "react";
import styled from "@emotion/styled";
import { AnswerResult, AnswerTrace, AskResponse, Feedback, QuestionLog } from "../lib/types";
import { AnswerProse } from "./AnswerProse";
import { CitationRow, FlowTag } from "./common";
import {
  Actions,
  Badge,
  Button,
  Chip,
  EmptyState,
  Field,
  ListRow,
  Row,
  ScrollList,
  Select,
  Stack,
  Textarea,
  statusTone,
  Input
} from "./ui";

// Human labels for the trace's routing modes and verification outcomes. The raw
// values are wire-contract enums; the console spells out what each means.
const ROUTING_LABELS: Record<AnswerTrace["routing"]["mode"], string> = {
  requested: "flow pinned by the caller",
  routed: "routed by the model",
  unscoped: "unscoped — routing was unavailable",
  unknown: "no flow matched; flow selection requested"
};

const SKIP_REASON_LABELS: Record<NonNullable<AnswerTrace["verification"]["skipReason"]>, string> = {
  low_confidence: "answer already ships at low confidence",
  no_sections: "nothing was retrieved to verify against",
  flow_selection_required: "no answer was drafted",
  out_of_scope: "question judged off-topic"
};

const QuestionForm = styled.form(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "end",
  gap: theme.space.lg
}));

const Block = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg,
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.xl
}));

const IdCode = styled.code(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.xs
}));

const TraceDetails = styled.details(({ theme }) => ({
  fontSize: theme.font.size.sm,
  color: theme.color.textMuted,
  "& summary": { cursor: "pointer", userSelect: "none" },
  "& ul": { margin: `${theme.space.sm} 0 0`, paddingLeft: "18px" },
  "& li": { margin: "2px 0" }
}));

const EmptySearch = styled.li(({ theme }) => ({ color: theme.color.status.running.fg }));

const GapList = styled.ul(({ theme }) => ({
  margin: 0,
  paddingLeft: "18px",
  color: theme.color.status.running.fg,
  fontSize: theme.font.size.md,
  "& li": { margin: "2px 0" }
}));

const OutOfScopeNote = styled.p(({ theme }) => ({ color: theme.color.status.running.fg }));

const PagerNote = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

function verificationLabel(verification: AnswerTrace["verification"]): string {
  switch (verification.status) {
    case "grounded":
      return "ran — every claim supported by the retrieved context";
    case "claims_stripped":
      return `ran — ${verification.unsupportedClaims?.length ?? 0} unsupported claim(s) stripped, confidence downgraded`;
    case "verdict_unparseable":
      return "ran — verifier reply was unusable, drafted answer kept (fail open)";
    case "skipped":
      return `skipped${verification.skipReason ? ` — ${SKIP_REASON_LABELS[verification.skipReason]}` : ""}`;
  }
}

// The per-answer audit trail: how routing went, every follow-up search with its
// hit count (an empty search is what grounds a followup gap — so "why was no gap
// raised?" is answerable here), and the grounding-verification outcome.
function AnswerTraceBlock({ trace }: { trace: AnswerTrace }) {
  const emptySearches = trace.searches.filter((search) => search.resultCount === 0).length;
  return (
    <TraceDetails>
      <summary>How this was answered</summary>
      <ul>
        <li>
          Routing: {ROUTING_LABELS[trace.routing.mode]}
          {trace.routing.mode === "routed" && trace.routing.confidence
            ? ` (${trace.routing.confidence} confidence)`
            : ""}
        </li>
        <li>
          Retrieval: {trace.seedSectionCount} seed section(s), {trace.poolSectionCount} in the final pool
          {trace.answerForced ? " — search budget exhausted, final answer forced" : ""}
        </li>
        {trace.searches.length > 0 ? (
          <li>
            Follow-up searches ({trace.searches.length}, {emptySearches} empty):
            <ul>
              {trace.searches.map((search, index) =>
                search.resultCount === 0 ? (
                  <EmptySearch key={`search-${index}`}>
                    “{search.query}” → nothing found (grounds a followup gap)
                  </EmptySearch>
                ) : (
                  <li key={`search-${index}`}>
                    “{search.query}” → {search.resultCount} section(s)
                  </li>
                )
              )}
            </ul>
          </li>
        ) : (
          <li>Follow-up searches: none requested — gaps can only be grounded by an empty search</li>
        )}
        {trace.answerContract === "unstructured" ? (
          <li>Answer contract: model reply did not parse — shipped as raw text at low confidence</li>
        ) : null}
        <li>Grounding verification: {verificationLabel(trace.verification)}</li>
        {trace.verification.unsupportedClaims?.length ? (
          <li>
            Stripped claims:
            <ul>
              {trace.verification.unsupportedClaims.map((claim, index) => (
                <li key={`claim-${index}`}>{claim}</li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
    </TraceDetails>
  );
}

// Shown when "auto" routing could not place a question: the answer was withheld
// and the user picks one of the offered flows to re-ask, pinned to that flow.
function FlowSelectionPrompt({
  question,
  selection,
  disabled,
  onReAsk
}: {
  question: string;
  selection: NonNullable<AnswerResult["flowSelectionRequired"]>;
  disabled: boolean;
  onReAsk: (question: string, flow: string) => Promise<void>;
}) {
  return (
    <Stack gap="md">
      <p>Pick a flow to answer this question:</p>
      <Actions>
        {selection.availableFlows.map((flow) => (
          <Chip disabled={disabled} key={flow.id} onClick={() => void onReAsk(question, flow.id)}>
            {flow.name}
          </Chip>
        ))}
      </Actions>
    </Stack>
  );
}

const ModalBackdrop = styled.div(({ theme }) => ({
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(23, 33, 29, 0.55)",
  padding: theme.space.xxl
}));

const Modal = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg,
  width: "min(520px, 100%)",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  background: theme.color.surface,
  boxShadow: theme.shadow.card,
  padding: theme.space.xl,
  "& h3": { margin: 0 }
}));

const ModalQuestion = styled.p(({ theme }) => ({
  margin: 0,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm,
  color: theme.color.text,
  wordBreak: "break-word"
}));

const Caveat = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.sm,
  color: theme.color.textMuted
}));

// Two-mode confirm for purging a question that contained sensitive info. "Delete
// question" removes just the logged record (and its cascade); "Full scrub" also
// cleans the downstream clusters and unpublished proposals it seeded. The caveat
// spells out what deletion cannot reach (the provider, an already-published PR).
function DeleteQuestionDialog({
  question,
  busy,
  onDelete,
  onClose
}: {
  question: QuestionLog;
  busy: boolean;
  onDelete: (questionId: string, scrub: boolean) => Promise<boolean>;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function run(scrub: boolean) {
    const ok = await onDelete(question.id, scrub);
    if (ok) {
      onClose();
    }
  }

  return (
    <ModalBackdrop onClick={onClose} role="presentation">
      <Modal aria-label="Delete question" aria-modal="true" onClick={(event) => event.stopPropagation()} role="dialog">
        <h3>Delete this question?</h3>
        <ModalQuestion>{question.question}</ModalQuestion>
        <Caveat>
          This purges Magpie&apos;s stored copy. It cannot retract text already sent to the AI provider, nor content
          already in a pushed branch, open PR, or merged document — a full scrub reports those so you can handle them.
        </Caveat>
        <Actions>
          <Button disabled={busy} onClick={() => void run(false)}>
            Delete question
          </Button>
          <Button
            disabled={busy}
            variant="danger"
            onClick={() => void run(true)}
            title="Also delete the downstream gap clusters and unpublished proposals this question seeded"
          >
            Full scrub
          </Button>
          <Button disabled={busy} variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </Actions>
      </Modal>
    </ModalBackdrop>
  );
}

export function AskPanel({
  answer,
  answeredSearch,
  askFlow,
  expandedQuestionIds,
  flowLabels,
  flows,
  loading,
  onAsk,
  onDelete,
  onFeedback,
  onPageChange,
  onReAsk,
  onToggleGap,
  question,
  questions,
  questionsMatching,
  questionsPage,
  questionsPageCount,
  setAnsweredSearch,
  setAskFlow,
  setQuestion,
  toggleCitations
}: {
  answer?: AskResponse;
  answeredSearch: string;
  askFlow: string;
  expandedQuestionIds: string[];
  flowLabels: Record<string, string>;
  flows: Array<{ id: string; name: string }>;
  loading: boolean;
  onAsk: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onDelete: (questionId: string, scrub: boolean) => Promise<boolean>;
  onFeedback: (questionId: string, feedback: Feedback) => Promise<void>;
  onPageChange: (page: number) => Promise<void>;
  onReAsk: (question: string, flow: string) => Promise<void>;
  onToggleGap: (questionId: string, flagged: boolean) => Promise<void>;
  question: string;
  questions: QuestionLog[];
  questionsMatching: number;
  questionsPage: number;
  questionsPageCount: number;
  setAnsweredSearch: (value: string) => void;
  setAskFlow: (value: string) => void;
  setQuestion: (value: string) => void;
  toggleCitations: (questionId: string) => void;
}) {
  // The search runs server-side over the whole history (GET /questions?q=), so
  // `questions` already holds one page of the matches — no client filtering.
  const searching = answeredSearch.trim().length > 0;
  // The question queued for a delete confirm, and whether a delete is in flight
  // (so the dialog's buttons disable rather than firing twice).
  const [pendingDelete, setPendingDelete] = useState<QuestionLog | undefined>();
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete(questionId: string, scrub: boolean): Promise<boolean> {
    setDeleting(true);
    try {
      return await onDelete(questionId, scrub);
    } finally {
      setDeleting(false);
    }
  }
  // The ask response is enqueue-only — it carries the queued job, not an answer.
  // The answer (and its flow) land on the logged question once the watcher
  // completes the answer_question job, so recover both from the question log.
  const answeredQuestion = answer ? questions.find((item) => item.id === answer.questionId) : undefined;
  const answerResult = answeredQuestion?.answer;
  const answerFlowId = answeredQuestion?.flowId;
  const jobActive = answer
    ? answer.job.state === "created" ||
      answer.job.state === "retry" ||
      answer.job.state === "active" ||
      answer.job.state === "blocked"
    : false;

  return (
    <>
      <QuestionForm onSubmit={onAsk}>
        <Field label="Question">
          <Textarea
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What are urgent cat warning signs?"
            rows={4}
            value={question}
          />
        </Field>
        {flows.length > 0 ? (
          <Field label="Flow">
            <Select onChange={(event) => setAskFlow(event.target.value)} value={askFlow}>
              <option value="auto">Auto (let Magpie decide)</option>
              {flows.map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Button variant="primary" disabled={loading || !question.trim()} type="submit">
          Ask
        </Button>
      </QuestionForm>
      {answer ? (
        <Block>
          <Row justify="between" gap="lg">
            <Row gap="md">
              <Badge
                tone={statusTone(answerResult?.confidence ?? (jobActive ? "pending" : "unknown"))}
                dot
                title={answerResult ? `Answer confidence: ${answerResult.confidence}` : "Answer is queued"}
              >
                {answerResult?.confidence ?? (jobActive ? "queued" : answer.job.state)}
              </Badge>
              <FlowTag flowId={answerFlowId} flowLabels={flowLabels} />
            </Row>
            <IdCode>{answer.questionId}</IdCode>
          </Row>
          {answerResult?.answer ? (
            <AnswerProse text={answerResult.answer} />
          ) : (
            <p>{`Queued as ${answer.job.type} (${answer.job.state})`}</p>
          )}
          {answerResult?.flowSelectionRequired && answeredQuestion ? (
            <FlowSelectionPrompt
              disabled={loading}
              onReAsk={onReAsk}
              question={answeredQuestion.question}
              selection={answerResult.flowSelectionRequired}
            />
          ) : null}
          {answerResult?.outOfScope ? (
            <OutOfScopeNote title="This question was judged off-topic for the selected flow, so no knowledge gap was raised.">
              Off-topic for this flow — no knowledge gap raised.
            </OutOfScopeNote>
          ) : null}
          {answerResult?.citations.length ? (
            <Stack gap="md">
              {answerResult.citations.map((citation) => (
                <CitationRow citation={citation} key={citation.sectionId} />
              ))}
            </Stack>
          ) : null}
          {answerResult?.trace ? <AnswerTraceBlock trace={answerResult.trace} /> : null}
        </Block>
      ) : null}

      <Block>
        <Row justify="between" gap="lg">
          <h3>Answered questions</h3>
          <form onSubmit={(event) => event.preventDefault()} style={{ minWidth: "min(280px, 50vw)" }}>
            <Input
              onChange={(event) => setAnsweredSearch(event.target.value)}
              placeholder="Search answered questions..."
              type="search"
              value={answeredSearch}
            />
          </form>
        </Row>
        <ScrollList>
          {questions.map((item) => {
            const citations = item.answer?.citations ?? [];
            const isExpanded = expandedQuestionIds.includes(item.id);

            return (
              <ListRow key={item.id}>
                <Row justify="between" gap="lg">
                  <h3 style={{ flex: 1, minWidth: 0 }}>{item.question}</h3>
                  <Row gap="md">
                    <FlowTag flowId={item.flowId} flowLabels={flowLabels} />
                    <Badge tone={statusTone(item.confidence)} dot title={`Answer confidence: ${item.confidence}`}>
                      {item.confidence}
                    </Badge>
                  </Row>
                </Row>
                {item.answer?.answer ? <AnswerProse text={item.answer.answer} /> : <p>Waiting for an answer.</p>}
                {item.answer?.flowSelectionRequired ? (
                  <FlowSelectionPrompt
                    disabled={loading}
                    onReAsk={onReAsk}
                    question={item.question}
                    selection={item.answer.flowSelectionRequired}
                  />
                ) : null}
                {item.answer?.outOfScope ? (
                  <OutOfScopeNote title="This question was judged off-topic for the selected flow, so no knowledge gap was raised.">
                    Off-topic for this flow — no knowledge gap raised.
                  </OutOfScopeNote>
                ) : null}
                {item.answer?.gaps && item.answer.gaps.length > 0 ? (
                  <GapList title="Distinct knowledge gaps detected for this question">
                    {item.answer.gaps.map((gap, index) => (
                      <li key={`${item.id}-gap-${index}`}>{gap.summary}</li>
                    ))}
                  </GapList>
                ) : null}
                <Actions>
                  <span>{new Date(item.askedAt).toLocaleString()}</span>
                  {citations.length > 0 ? (
                    <Chip onClick={() => toggleCitations(item.id)} title="Show or hide the answer source sections">
                      {isExpanded ? "Hide" : "Show"} {citations.length} citations
                    </Chip>
                  ) : (
                    <Badge tone="neutral" title="No source sections were cited">
                      0 citations
                    </Badge>
                  )}
                  <Chip selected={item.feedback === "helpful"} onClick={() => void onFeedback(item.id, "helpful")}>
                    Helpful
                  </Chip>
                  <Chip selected={item.feedback === "unhelpful"} onClick={() => void onFeedback(item.id, "unhelpful")}>
                    Unhelpful
                  </Chip>
                  <Chip
                    selected={item.manualGap}
                    onClick={() => void onToggleGap(item.id, !item.manualGap)}
                    title="Flag this answer as a knowledge gap the system missed"
                  >
                    Knowledge gap
                  </Chip>
                  <Chip
                    onClick={() => setPendingDelete(item)}
                    title="Delete this question — e.g. if it contained sensitive information (admin only)"
                  >
                    Delete
                  </Chip>
                </Actions>
                {isExpanded && citations.length > 0 ? (
                  <Stack gap="md">
                    {citations.map((citation) => (
                      <CitationRow citation={citation} key={citation.sectionId} />
                    ))}
                  </Stack>
                ) : null}
                {item.answer?.trace ? <AnswerTraceBlock trace={item.answer.trace} /> : null}
              </ListRow>
            );
          })}
          {questions.length === 0 ? (
            <EmptyState>{searching ? "No questions match your search." : "No questions logged yet."}</EmptyState>
          ) : null}
        </ScrollList>
        {questionsPageCount > 1 ? (
          <Row justify="between" gap="lg">
            <Chip
              disabled={questionsPage === 0}
              onClick={() => void onPageChange(questionsPage - 1)}
              title="Show more recent questions"
            >
              ← Newer
            </Chip>
            <PagerNote>
              Page {questionsPage + 1} of {questionsPageCount} · {questionsMatching}{" "}
              {searching
                ? `match${questionsMatching === 1 ? "" : "es"}`
                : `question${questionsMatching === 1 ? "" : "s"}`}
            </PagerNote>
            <Chip
              disabled={questionsPage >= questionsPageCount - 1}
              onClick={() => void onPageChange(questionsPage + 1)}
              title="Show older questions"
            >
              Older →
            </Chip>
          </Row>
        ) : searching ? (
          <PagerNote>
            {questionsMatching} match{questionsMatching === 1 ? "" : "es"} across the whole history
          </PagerNote>
        ) : null}
      </Block>
      {pendingDelete ? (
        <DeleteQuestionDialog
          busy={deleting}
          question={pendingDelete}
          onDelete={confirmDelete}
          onClose={() => setPendingDelete(undefined)}
        />
      ) : null}
    </>
  );
}
