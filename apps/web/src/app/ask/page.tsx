"use client";

import { useMemo } from "react";
import { AskPanel } from "../../components/AskPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { knowledgeFlows } from "../../lib/config";

export default function AskPage() {
  const {
    answer,
    answeredSearch,
    config,
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

  // Map flow id -> display name so questions can be tagged with a readable flow.
  const flowLabels = useMemo(
    () => Object.fromEntries(knowledgeFlows(config).map((flow) => [flow.id, flow.name])),
    [config]
  );

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
            flowLabels={flowLabels}
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
