import { FormEvent } from "react";
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

export function AskPanel({
  answer,
  answeredSearch,
  askFlow,
  expandedQuestionIds,
  flowLabels,
  flows,
  loading,
  onAsk,
  onFeedback,
  onReAsk,
  onToggleGap,
  question,
  questions,
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
  onFeedback: (questionId: string, feedback: Feedback) => Promise<void>;
  onReAsk: (question: string, flow: string) => Promise<void>;
  onToggleGap: (questionId: string, flagged: boolean) => Promise<void>;
  question: string;
  questions: QuestionLog[];
  setAnsweredSearch: (value: string) => void;
  setAskFlow: (value: string) => void;
  setQuestion: (value: string) => void;
  toggleCitations: (questionId: string) => void;
}) {
  const query = answeredSearch.trim().toLowerCase();
  const filteredQuestions = query ? questions.filter((item) => item.question.toLowerCase().includes(query)) : questions;
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
          {filteredQuestions.map((item) => {
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
          {filteredQuestions.length === 0 ? (
            <EmptyState>{query ? "No matching questions." : "No questions logged yet."}</EmptyState>
          ) : null}
        </ScrollList>
      </Block>
    </>
  );
}
