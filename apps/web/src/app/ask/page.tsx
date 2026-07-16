"use client";

import { useMemo } from "react";
import { AskPanel } from "../../components/AskPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { Surface, Workbench } from "../../components/ui";
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
    deleteQuestion,
    loadQuestionsPage,
    reAskWithFlow,
    sendFeedback,
    setAskFlow,
    toggleKnowledgeGap,
    question,
    questions,
    questionsMatching,
    questionsPage,
    questionsPageCount,
    setAnsweredSearch,
    setQuestion,
    toggleCitations
  } = useConsole();

  const flowLabels = useMemo(() => knowledgeFlowLabels(config), [config]);
  const flows = useMemo(() => knowledgeFlows(config).map((flow) => ({ id: flow.id, name: flow.name })), [config]);

  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Ask a Question</h2>
        </Surface.Header>
        <Surface.Body>
          <AskPanel
            answer={answer}
            answeredSearch={answeredSearch}
            askFlow={askFlow}
            expandedQuestionIds={expandedQuestionIds}
            flowLabels={flowLabels}
            flows={flows}
            loading={loading}
            onAsk={ask}
            onDelete={deleteQuestion}
            onFeedback={sendFeedback}
            onPageChange={loadQuestionsPage}
            onReAsk={reAskWithFlow}
            onToggleGap={toggleKnowledgeGap}
            question={question}
            questions={questions}
            questionsMatching={questionsMatching}
            questionsPage={questionsPage}
            questionsPageCount={questionsPageCount}
            setAnsweredSearch={setAnsweredSearch}
            setAskFlow={setAskFlow}
            setQuestion={setQuestion}
            toggleCitations={toggleCitations}
          />
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
