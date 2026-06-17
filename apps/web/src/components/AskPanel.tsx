import { FormEvent } from "react";
import { AskResponse, Feedback, QuestionLog } from "../lib/types.js";
import { CitationRow } from "./common.js";

export function AskPanel({
  answer,
  answeredSearch,
  expandedQuestionIds,
  loading,
  onAsk,
  onFeedback,
  onToggleGap,
  question,
  questions,
  setAnsweredSearch,
  setQuestion,
  toggleCitations
}: {
  answer?: AskResponse;
  answeredSearch: string;
  expandedQuestionIds: string[];
  loading: boolean;
  onAsk: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onFeedback: (questionId: string, feedback: Feedback) => Promise<void>;
  onToggleGap: (questionId: string, flagged: boolean) => Promise<void>;
  question: string;
  questions: QuestionLog[];
  setAnsweredSearch: (value: string) => void;
  setQuestion: (value: string) => void;
  toggleCitations: (questionId: string) => void;
}) {
  const query = answeredSearch.trim().toLowerCase();
  const filteredQuestions = query
    ? questions.filter((item) => item.question.toLowerCase().includes(query))
    : questions;

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
        <button className="button" disabled={loading || !question.trim()} type="submit">
          Ask
        </button>
      </form>
      {answer ? (
        <div className="answerBlock">
          <div className="resultHeader">
            <span
              className={`status ${answer.result?.confidence ?? "unknown"}`}
              title={answer.result ? `Answer confidence: ${answer.result.confidence}` : "Answer is queued"}
            >
              {answer.result?.confidence ?? "queued"}
            </span>
            <code>{answer.questionId}</code>
          </div>
          <p>{answer.result?.answer ?? `Queued as ${answer.job?.type ?? "AI job"}`}</p>
          {answer.result?.citations.length ? (
            <div className="citationStack">
              {answer.result.citations.map((citation) => (
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
                  <span className={`status ${item.confidence}`} title={`Answer confidence: ${item.confidence}`}>
                    {item.confidence}
                  </span>
                </div>
                <p>{item.answer?.answer ?? "Waiting for an answer."}</p>
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
