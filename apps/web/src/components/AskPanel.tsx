import { FormEvent } from "react";
import { AnswerResult, AnswerTrace, AskResponse, Feedback, QuestionLog } from "../lib/types";
import { AnswerProse } from "./AnswerProse";
import { CitationRow, FlowTag } from "./common";

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
    <details className="answerTrace">
      <summary>How this was answered</summary>
      <ul className="answerTraceList">
        <li>
          Routing: {ROUTING_LABELS[trace.routing.mode]}
          {trace.routing.mode === "routed" && trace.routing.confidence ? ` (${trace.routing.confidence} confidence)` : ""}
        </li>
        <li>
          Retrieval: {trace.seedSectionCount} seed section(s), {trace.poolSectionCount} in the final pool
          {trace.answerForced ? " — search budget exhausted, final answer forced" : ""}
        </li>
        {trace.searches.length > 0 ? (
          <li>
            Follow-up searches ({trace.searches.length}, {emptySearches} empty):
            <ul>
              {trace.searches.map((search, index) => (
                <li className={search.resultCount === 0 ? "answerTraceEmptySearch" : undefined} key={`search-${index}`}>
                  “{search.query}” → {search.resultCount === 0 ? "nothing found (grounds a followup gap)" : `${search.resultCount} section(s)`}
                </li>
              ))}
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
    </details>
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
    <div className="flowSelectPrompt">
      <p>Pick a flow to answer this question:</p>
      <div className="rowActions">
        {selection.availableFlows.map((flow) => (
          <button
            className="chip"
            disabled={disabled}
            key={flow.id}
            onClick={() => void onReAsk(question, flow.id)}
            type="button"
          >
            {flow.name}
          </button>
        ))}
      </div>
    </div>
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
  const filteredQuestions = query
    ? questions.filter((item) => item.question.toLowerCase().includes(query))
    : questions;
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
      <form className="questionForm" onSubmit={onAsk}>
        <label className="field">
          <span>Question</span>
          <textarea
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What are urgent cat warning signs?"
            rows={4}
            value={question}
          />
        </label>
        {flows.length > 0 ? (
          <label className="field">
            <span>Flow</span>
            <select onChange={(event) => setAskFlow(event.target.value)} value={askFlow}>
              <option value="auto">Auto (let Magpie decide)</option>
              {flows.map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button className="button" disabled={loading || !question.trim()} type="submit">
          Ask
        </button>
      </form>
      {answer ? (
        <div className="answerBlock">
          <div className="resultHeader">
            <div className="rowMeta">
              <span
                className={`status ${answerResult?.confidence ?? (jobActive ? "pending" : "unknown")}`}
                title={answerResult ? `Answer confidence: ${answerResult.confidence}` : "Answer is queued"}
              >
                {answerResult?.confidence ?? (jobActive ? "queued" : answer.job.state)}
              </span>
              <FlowTag flowId={answerFlowId} flowLabels={flowLabels} />
            </div>
            <code>{answer.questionId}</code>
          </div>
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
            <p className="outOfScopeNote" title="This question was judged off-topic for the selected flow, so no knowledge gap was raised.">
              Off-topic for this flow — no knowledge gap raised.
            </p>
          ) : null}
          {answerResult?.citations.length ? (
            <div className="citationStack">
              {answerResult.citations.map((citation) => (
                <CitationRow citation={citation} key={citation.sectionId} />
              ))}
            </div>
          ) : null}
          {answerResult?.trace ? <AnswerTraceBlock trace={answerResult.trace} /> : null}
        </div>
      ) : null}

      <div className="answeredBlock">
        <div className="resultHeader">
          <h3>Answered questions</h3>
          <form className="inlineForm" onSubmit={(event) => event.preventDefault()}>
            <input
              onChange={(event) => setAnsweredSearch(event.target.value)}
              placeholder="Search answered questions..."
              type="search"
              value={answeredSearch}
            />
          </form>
        </div>
        <div className="list scrollList">
          {filteredQuestions.map((item) => {
            const citations = item.answer?.citations ?? [];
            const isExpanded = expandedQuestionIds.includes(item.id);

            return (
              <article className="row" key={item.id}>
                <div className="rowTop">
                  <h3>{item.question}</h3>
                  <div className="rowMeta">
                    <FlowTag flowId={item.flowId} flowLabels={flowLabels} />
                    <span className={`status ${item.confidence}`} title={`Answer confidence: ${item.confidence}`}>
                      {item.confidence}
                    </span>
                  </div>
                </div>
                {item.answer?.answer ? (
                  <AnswerProse text={item.answer.answer} />
                ) : (
                  <p>Waiting for an answer.</p>
                )}
                {item.answer?.flowSelectionRequired ? (
                  <FlowSelectionPrompt
                    disabled={loading}
                    onReAsk={onReAsk}
                    question={item.question}
                    selection={item.answer.flowSelectionRequired}
                  />
                ) : null}
                {item.answer?.outOfScope ? (
                  <p className="outOfScopeNote" title="This question was judged off-topic for the selected flow, so no knowledge gap was raised.">
                    Off-topic for this flow — no knowledge gap raised.
                  </p>
                ) : null}
                {item.answer?.gaps && item.answer.gaps.length > 0 ? (
                  <ul className="gapList" title="Distinct knowledge gaps detected for this question">
                    {item.answer.gaps.map((gap, index) => (
                      <li key={`${item.id}-gap-${index}`}>{gap.summary}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="rowActions">
                  <span>{new Date(item.askedAt).toLocaleString()}</span>
                  {citations.length > 0 ? (
                    <button className="chip" onClick={() => toggleCitations(item.id)} title="Show or hide the answer source sections" type="button">
                      {isExpanded ? "Hide" : "Show"} {citations.length} citations
                    </button>
                  ) : (
                    <span className="pill" title="No source sections were cited">
                      0 citations
                    </span>
                  )}
                  <button
                    className={item.feedback === "helpful" ? "chip selected" : "chip"}
                    onClick={() => void onFeedback(item.id, "helpful")}
                    type="button"
                  >
                    Helpful
                  </button>
                  <button
                    className={item.feedback === "unhelpful" ? "chip selected" : "chip"}
                    onClick={() => void onFeedback(item.id, "unhelpful")}
                    type="button"
                  >
                    Unhelpful
                  </button>
                  <button
                    className={item.manualGap ? "chip selected" : "chip"}
                    onClick={() => void onToggleGap(item.id, !item.manualGap)}
                    title="Flag this answer as a knowledge gap the system missed"
                    type="button"
                  >
                    Knowledge gap
                  </button>
                </div>
                {isExpanded && citations.length > 0 ? (
                  <div className="citationStack">
                    {citations.map((citation) => (
                      <CitationRow citation={citation} key={citation.sectionId} />
                    ))}
                  </div>
                ) : null}
                {item.answer?.trace ? <AnswerTraceBlock trace={item.answer.trace} /> : null}
              </article>
            );
          })}
          {filteredQuestions.length === 0 ? (
            <p className="empty">{query ? "No matching questions." : "No questions logged yet."}</p>
          ) : null}
        </div>
      </div>
    </>
  );
}
