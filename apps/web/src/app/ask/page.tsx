"use client";

import { useMemo } from "react";
import { AskPanel } from "../../components/AskPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { knowledgeFlowLabels, knowledgeFlows } from "../../lib/config";

export default function AskPage() {
  const {
    answer,
    answeredSearch,
    askFlow,
    config,
    expandedQuestionIds,
    loading,
    ask,
    reAskWithFlow,
    sendFeedback,
    setAskFlow,
    toggleKnowledgeGap,
    question,
    questions,
    setAnsweredSearch,
    setQuestion,
    toggleCitations
  } = useConsole();

  const flowLabels = useMemo(() => knowledgeFlowLabels(config), [config]);
  const flows = useMemo(
    () => knowledgeFlows(config).map((flow) => ({ id: flow.id, name: flow.name })),
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
            askFlow={askFlow}
            expandedQuestionIds={expandedQuestionIds}
            flowLabels={flowLabels}
            flows={flows}
            loading={loading}
            onAsk={ask}
            onFeedback={sendFeedback}
            onReAsk={reAskWithFlow}
            onToggleGap={toggleKnowledgeGap}
            question={question}
            questions={questions}
            setAnsweredSearch={setAnsweredSearch}
            setAskFlow={setAskFlow}
            setQuestion={setQuestion}
            toggleCitations={toggleCitations}
          />
        </div>
      </div>
    </section>
  );
}
