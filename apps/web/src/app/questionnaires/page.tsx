"use client";

import { useMemo } from "react";
import { QuestionnairesPanel } from "../../components/QuestionnairesPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { Surface, Workbench } from "../../components/ui";
import { knowledgeFlows } from "../../lib/config";

export default function QuestionnairesPage() {
  const {
    config,
    loading,
    listQuestionnaires,
    getQuestionnaire,
    createQuestionnaire,
    approveQuestionnaireItem,
    approveReusedItems,
    exportQuestionnaire
  } = useConsole();

  const flows = useMemo(() => knowledgeFlows(config).map((flow) => ({ id: flow.id, name: flow.name })), [config]);

  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Questionnaires</h2>
        </Surface.Header>
        <Surface.Body>
          <QuestionnairesPanel
            flows={flows}
            loading={loading}
            onList={listQuestionnaires}
            onGet={getQuestionnaire}
            onCreate={createQuestionnaire}
            onApproveItem={approveQuestionnaireItem}
            onApproveReused={approveReusedItems}
            onExport={exportQuestionnaire}
          />
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
