"use client";

import { useMemo } from "react";
import { AskPanel } from "../../components/AskPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { knowledgeFlowLabels } from "../../lib/config";

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

  const flowLabels = useMemo(() => knowledgeFlowLabels(config), [config]);

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
