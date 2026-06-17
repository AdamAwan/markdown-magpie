import { FormEvent } from "react";
import { AskResponse } from "../lib/types.js";
import { CitationRow } from "./common.js";

export function AskPanel({
  answer,
  loading,
  onAsk,
  question,
  setQuestion
}: {
  answer?: AskResponse;
  loading: boolean;
  onAsk: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  question: string;
  setQuestion: (value: string) => void;
}) {
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
    </>
  );
}
