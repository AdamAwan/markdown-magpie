"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { FlowsPanel, RepositoryContextPanel } from "../../components/KnowledgePanel";
import { Badge, Surface, Workbench } from "../../components/ui";
import { knowledgeFlows } from "../../lib/config";

export default function KnowledgePage() {
  const {
    config,
    documents,
    indexingRepo,
    indexRepository,
    selectedDocumentId,
    flowId,
    setSelectedDocumentId,
    setFlowId,
    repositories
  } = useConsole();

  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Knowledge Flows</h2>
          <Badge tone="neutral" title="Configured knowledge flows">
            {knowledgeFlows(config).length} flows
          </Badge>
        </Surface.Header>
        <Surface.Body>
          <FlowsPanel
            destinations={config?.knowledge.destinations ?? config?.knowledge.repositories ?? []}
            documents={documents}
            flows={knowledgeFlows(config)}
            indexing={indexingRepo}
            onIndex={indexRepository}
            selectedDocumentId={selectedDocumentId}
            selectedFlowId={flowId}
            setSelectedDocumentId={setSelectedDocumentId}
            setSelectedFlowId={setFlowId}
            sources={config?.knowledge.sources ?? []}
          />
        </Surface.Body>
      </Surface>
      <RepositoryContextPanel repositories={repositories} />
    </Workbench>
  );
}
