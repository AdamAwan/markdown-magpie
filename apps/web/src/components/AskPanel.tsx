import { FormEvent } from "react";
import { AnswerResult, AskResponse, Feedback, QuestionLog } from "../lib/types";
import { CitationRow, FlowTag } from "./common";

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
          <p>{answerResult?.answer ?? `Queued as ${answer.job.type} (${answer.job.state})`}</p>
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
                <p>{item.answer?.answer ?? "Waiting for an answer."}</p>
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
