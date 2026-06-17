"use client";

import { useConsole } from "../../components/ConsoleProvider";
import { FlowsPanel, RepositoryContextPanel } from "../../components/KnowledgePanel";
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
    <section className="knowledgePage">
      <div className="surface">
        <div className="surfaceHeader">
          <h2>Knowledge Flows</h2>
          <span className="pill" title="Configured knowledge flows">
            {knowledgeFlows(config).length} flows
          </span>
        </div>
        <div className="surfaceBody">
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
        </div>
      </div>
      <RepositoryContextPanel repositories={repositories} />
    </section>
  );
}
