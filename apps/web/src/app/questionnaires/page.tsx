"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { QuestionnaireCreateList } from "../../components/QuestionnaireCreateList";
import { useConsole } from "../../components/ConsoleProvider";
import { Surface, Workbench } from "../../components/ui";
import { knowledgeFlows } from "../../lib/config";

export default function QuestionnairesPage() {
  const router = useRouter();
  const { config, loading, listQuestionnaires, createQuestionnaire } = useConsole();

  const flows = useMemo(() => knowledgeFlows(config).map((flow) => ({ id: flow.id, name: flow.name })), [config]);

  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Questionnaires</h2>
        </Surface.Header>
        <Surface.Body>
          <QuestionnaireCreateList
            flows={flows}
            loading={loading}
            onList={listQuestionnaires}
            onCreate={createQuestionnaire}
            onOpen={(id) => router.push(`/questionnaires/${encodeURIComponent(id)}`)}
          />
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
