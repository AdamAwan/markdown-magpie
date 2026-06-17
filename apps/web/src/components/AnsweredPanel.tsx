import { Feedback, QuestionLog } from "../lib/types.js";
import { CitationRow } from "./common.js";

export function AnsweredPanel({
  expandedQuestionIds,
  onFeedback,
  onToggleGap,
  questions,
  toggleCitations
}: {
  expandedQuestionIds: string[];
  onFeedback: (questionId: string, feedback: Feedback) => Promise<void>;
  onToggleGap: (questionId: string, flagged: boolean) => Promise<void>;
  questions: QuestionLog[];
  toggleCitations: (questionId: string) => void;
}) {
  return (
    <div className="list scrollList">
      {questions.map((item) => {
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
      {questions.length === 0 ? <p className="empty">No questions logged yet.</p> : null}
    </div>
  );
}
