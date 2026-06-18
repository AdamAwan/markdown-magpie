"use client";

import { AskPanel } from "../../components/AskPanel";
import { useConsole } from "../../components/ConsoleProvider";

export default function AskPage() {
  const {
    answer,
    answeredSearch,
    expandedQuestionIds,
    loading,
    ask,
    sendFeedback,
    toggleKnowledgeGap,
    question,
    questions,
    setAnsweredSearch,
    setQuestion,
    toggleCitations
  } = useConsole();

  return (
    <section className="workbench singlePane">
      <div className="surface">
        <div className="surfaceHeader">
          <h2>Ask a Question</h2>
        </div>
        <div className="surfaceBody">
          <AskPanel
            answer={answer}
            answeredSearch={answeredSearch}
            expandedQuestionIds={expandedQuestionIds}
            loading={loading}
            onAsk={ask}
            onFeedback={sendFeedback}
            onToggleGap={toggleKnowledgeGap}
            question={question}
            questions={questions}
            setAnsweredSearch={setAnsweredSearch}
            setQuestion={setQuestion}
            toggleCitations={toggleCitations}
          />
        </div>
      </div>
    </section>
  );
}
