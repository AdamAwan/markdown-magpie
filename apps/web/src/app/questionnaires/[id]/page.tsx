"use client";

import { useParams } from "next/navigation";
import { QuestionnaireDetail } from "../../../components/QuestionnaireDetail";
import { useConsole } from "../../../components/ConsoleProvider";
import { Surface, Workbench } from "../../../components/ui";
import { resolveApiUrl } from "../../../lib/api";

export default function QuestionnaireDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const { getQuestionnaire, approveQuestionnaireItem, approveReusedItems } = useConsole();

  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Questionnaire</h2>
        </Surface.Header>
        <Surface.Body>
          <QuestionnaireDetail
            id={id}
            backHref="/questionnaires"
            onGet={getQuestionnaire}
            onApproveItem={approveQuestionnaireItem}
            onApproveReused={approveReusedItems}
            exportHref={(questionnaireId, format) =>
              resolveApiUrl(`/questionnaires/${encodeURIComponent(questionnaireId)}/export?format=${format}`)
            }
          />
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
