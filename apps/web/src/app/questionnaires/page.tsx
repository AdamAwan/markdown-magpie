"use client";

import { useMemo } from "react";
import { QuestionnairesPanel } from "../../components/QuestionnairesPanel";
import { useConsole } from "../../components/ConsoleProvider";
import { Surface, Workbench } from "../../components/ui";
import { resolveApiUrl } from "../../lib/api";
import { knowledgeFlows } from "../../lib/config";

export default function QuestionnairesPage() {
  const {
    config,
    loading,
    listQuestionnaires,
    getQuestionnaire,
    createQuestionnaire,
    approveQuestionnaireItem,
    approveReusedItems
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
            exportHref={(id, format) =>
              resolveApiUrl(`/questionnaires/${encodeURIComponent(id)}/export?format=${format}`)
            }
          />
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
