import { useEffect, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  ConfiguredKnowledgeFlow,
  ConfiguredKnowledgeRepository,
  GitRepositoryContext,
  KnowledgeDocument,
  RepositoryRef
} from "../lib/types.js";
import { shortSha } from "../lib/format.js";
import { ContextValue } from "./common.js";

/** Sidebar id for documents that no configured flow produced (e.g. console uploads). */
export const OTHER_DOCUMENTS_ID = "__other_documents__";

export function RepositoryContextPanel({ repositories }: { repositories: RepositoryRef[] }) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Repository Context</h2>
        <span className="pill" title="Indexed knowledge repositories">
          {repositories.length} repos
        </span>
      </div>
      <div className="surfaceBody">
        <div className="repositoryContextList">
          {repositories.map((repository) => (
            <article className="repositoryContext" key={repository.id}>
              <div className="rowTop">
                <div>
                  <h3>{repository.name}</h3>
                  <p className="path">{repository.localPath}</p>
                </div>
                <span className={`status ${repository.git?.scope ?? "unknown"}`} title={gitScopeLabel(repository.git?.scope)}>
                  {gitScopeLabel(repository.git?.scope)}
                </span>
              </div>
              <div className="gitContextGrid">
                <ContextValue label="Repository ID" value={repository.id} />
                <ContextValue label="Provider" value={repository.provider} />
                <ContextValue label="Branch" value={repository.git?.currentBranch ?? repository.defaultBranch} />
                <ContextValue label="HEAD" value={shortSha(repository.git?.headSha)} />
                <ContextValue label="Git Root" value={repository.git?.workTreeRoot ?? "Not detected"} />
                <ContextValue label="Indexed Folder" value={repository.git?.relativePathFromRoot ?? repository.git?.indexedPath ?? repository.localPath} />
                <ContextValue label="Remote" value={repository.git?.remoteUrl ?? repository.remoteUrl ?? "Not configured"} />
                <ContextValue label="Working Tree" value={repository.git?.hasUncommittedChanges ? "Uncommitted changes" : repository.git?.scope === "not-git" ? "Not a git work tree" : "Clean"} />
              </div>
            </article>
          ))}
          {repositories.length === 0 ? <p className="empty">No repository context available yet. Index a repository to detect its Git scope.</p> : null}
        </div>
      </div>
    </section>
  );
}

interface FlowEntry {
  id: string;
  name: string;
  flow?: ConfiguredKnowledgeFlow;
  destination?: ConfiguredKnowledgeRepository;
  sources: ConfiguredKnowledgeRepository[];
  documents: KnowledgeDocument[];
  isOther: boolean;
}

/**
 * Flow-centric master/detail view. The left rail lists every configured flow
 * (plus an "Other documents" bucket for docs no flow produced); the right pane
 * shows the selected flow's pipeline, sources, status and indexed documents.
 */
export function FlowsPanel({
  destinations,
  documents,
  flows,
  indexing,
  onIndex,
  selectedDocumentId,
  selectedFlowId,
  setSelectedDocumentId,
  setSelectedFlowId,
  sources
}: {
  destinations: ConfiguredKnowledgeRepository[];
  documents: KnowledgeDocument[];
  flows: ConfiguredKnowledgeFlow[];
  indexing: boolean;
  onIndex: (flowId: string) => Promise<void>;
  selectedDocumentId?: string;
  selectedFlowId: string;
  setSelectedDocumentId: (id: string) => void;
  setSelectedFlowId: (value: string) => void;
  sources: ConfiguredKnowledgeRepository[];
}) {
  const [fullScreenDocument, setFullScreenDocument] = useState<KnowledgeDocument | null>(null);

  const entries = buildFlowEntries(flows, destinations, sources, documents);

  if (entries.length === 0) {
    return <p className="empty">No knowledge flows are configured. Add KNOWLEDGE_FLOWS or KNOWLEDGE_DESTINATIONS to the API environment.</p>;
  }

  const active = entries.find((entry) => entry.id === selectedFlowId) ?? entries[0];
  const activeDocument = active.documents.find((document) => document.id === selectedDocumentId) ?? active.documents[0];

  return (
    <Tooltip.Provider delayDuration={150}>
    <div className="flowWorkspace">
      <nav className="flowSidebar" aria-label="Knowledge flows">
        {entries.map((entry) => (
          <button
            className={entry.id === active.id ? "flowSidebarItem selected" : "flowSidebarItem"}
            key={entry.id}
            onClick={() => setSelectedFlowId(entry.id)}
            type="button"
          >
            <span className="flowSidebarName">{entry.name}</span>
            <span className="flowSidebarMeta">{flowSummary(entry)}</span>
          </button>
        ))}
      </nav>

      <section className="flowDetail">
        <div className="flowDetailHead">
          <div>
            <h3>{active.name}</h3>
            {active.isOther ? (
              <p className="path">Indexed documents not produced by a configured flow (for example, console uploads).</p>
            ) : (
              <FlowPipeline destination={active.destination} fallbackDestinationId={active.flow?.destinationId} sources={active.sources} />
            )}
          </div>
          {active.isOther ? null : (
            <button
              className="button"
              disabled={indexing || !active.destination}
              onClick={() => {
                setSelectedFlowId(active.id);
                void onIndex(active.id);
              }}
              title="Index the destination knowledge base used by /ask and MCP"
              type="button"
            >
              {indexing ? "Indexing" : "Index KB"}
            </button>
          )}
        </div>

        <div className="flowSection">
          <h4 className="flowSectionTitle">Indexed documents</h4>
          <FlowDocuments
            documents={active.documents}
            onOpenFull={setFullScreenDocument}
            onSelect={setSelectedDocumentId}
            selectedDocument={activeDocument}
          />
        </div>
      </section>

      {fullScreenDocument ? <DocumentModal document={fullScreenDocument} onClose={() => setFullScreenDocument(null)} /> : null}
    </div>
    </Tooltip.Provider>
  );
}

function FlowPipeline({
  destination,
  fallbackDestinationId,
  sources
}: {
  destination?: ConfiguredKnowledgeRepository;
  fallbackDestinationId?: string;
  sources: ConfiguredKnowledgeRepository[];
}) {
  return (
    <div className="flowPipe" aria-label="Knowledge flow pipeline">
      <div className="flowNodeGroup">
        {sources.length > 0 ? (
          sources.map((source) => (
            <RepositoryNode className={`flowNode ${source.kind ?? "local"}`} key={source.id} repository={source} />
          ))
        ) : (
          <span className="flowNode missing">No sources</span>
        )}
      </div>
      <span className="flowArrow" aria-hidden="true">-&gt;</span>
      <RepositoryNode
        className={`flowNode destination ${destination?.kind ?? "local"}`}
        fallbackLabel={fallbackDestinationId}
        repository={destination}
      />
    </div>
  );
}

/**
 * A pipeline node (source or destination) that reveals the repository's
 * details in a tooltip on hover/focus. Falls back to a plain label when the
 * repository could not be resolved.
 */
function RepositoryNode({
  className,
  fallbackLabel,
  repository
}: {
  className: string;
  fallbackLabel?: string;
  repository?: ConfiguredKnowledgeRepository;
}) {
  if (!repository) {
    return <span className={className}>{fallbackLabel ?? "Unknown"}</span>;
  }

  const rows: Array<{ label: string; value: string }> = [
    { label: "Kind", value: repository.kind ?? "local" },
    { label: "Location", value: repository.url ?? repository.path ?? "Not configured" }
  ];
  if (repository.subpath) {
    rows.push({ label: "Subpath", value: repository.subpath });
  }
  if (repository.branch) {
    rows.push({ label: "Branch", value: repository.branch });
  }
  rows.push({ label: "ID", value: repository.id });

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className={className}>{repository.name}</span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="repositoryTooltip" sideOffset={6} collisionPadding={12}>
          <strong className="repositoryTooltipName">{repository.name}</strong>
          <dl className="repositoryTooltipRows">
            {rows.map((row) => (
              <div className="repositoryTooltipRow" key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          <Tooltip.Arrow className="repositoryTooltipArrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function FlowDocuments({
  documents,
  onOpenFull,
  onSelect,
  selectedDocument
}: {
  documents: KnowledgeDocument[];
  onOpenFull: (document: KnowledgeDocument) => void;
  onSelect: (id: string) => void;
  selectedDocument?: KnowledgeDocument;
}) {
  if (documents.length === 0) {
    return <p className="empty">No Markdown documents indexed yet.</p>;
  }

  const folders = groupDocumentsByFolder(documents);

  return (
    <div className="flowDocs">
      <div className="flowDocList">
        {folders.map((folder) => (
          <div className="flowDocGroup" key={folder.name}>
            <div className="folderHeader">
              <span>{folder.name}</span>
              <small>{folder.documents.length}</small>
            </div>
            {folder.documents.map((document) => (
              <div className={selectedDocument?.id === document.id ? "flowDocRow selected" : "flowDocRow"} key={document.id}>
                <button className="flowDocSelect" onClick={() => onSelect(document.id)} type="button">
                  <span>{document.metadata.title}</span>
                  <small>{document.path.split("/").at(-1) ?? document.path}</small>
                </button>
                <div className="flowDocRowSide">
                  <span className={`status ${document.metadata.status}`} title={`Document status: ${document.metadata.status}`}>
                    {document.metadata.status}
                  </span>
                  <button className="flowDocOpen" onClick={() => onOpenFull(document)} title="Open full Markdown" type="button">
                    Open
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <article className="flowDocReader">
        {selectedDocument ? (
          <>
            <div className="rowTop">
              <div>
                <h3>{selectedDocument.metadata.title}</h3>
                <p className="path">{selectedDocument.path}</p>
              </div>
              <button className="button secondary" onClick={() => onOpenFull(selectedDocument)} type="button">
                Open full
              </button>
            </div>
            <div className="rowActions">
              <span className="pill" title="Repository ID">
                {selectedDocument.repositoryId}
              </span>
              {selectedDocument.metadata.owner ? (
                <span className="pill" title="Document owner">
                  {selectedDocument.metadata.owner}
                </span>
              ) : null}
              {selectedDocument.metadata.tags.map((tag) => (
                <span className="pill" key={tag} title="Document tag">
                  {tag}
                </span>
              ))}
            </div>
            <pre className="markdownViewer">{selectedDocument.content}</pre>
          </>
        ) : (
          <p className="empty">Select a document to preview its Markdown.</p>
        )}
      </article>
    </div>
  );
}

function DocumentModal({ document: knowledgeDocument, onClose }: { document: KnowledgeDocument; onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="docModalBackdrop" onClick={onClose} role="presentation">
      <div className="docModal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={knowledgeDocument.metadata.title}>
        <div className="docModalHead">
          <div>
            <h3>{knowledgeDocument.metadata.title}</h3>
            <p className="path">{knowledgeDocument.path}</p>
          </div>
          <button className="button secondary" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <pre className="docModalBody">{knowledgeDocument.content}</pre>
      </div>
    </div>
  );
}

function buildFlowEntries(
  flows: ConfiguredKnowledgeFlow[],
  destinations: ConfiguredKnowledgeRepository[],
  sources: ConfiguredKnowledgeRepository[],
  documents: KnowledgeDocument[]
): FlowEntry[] {
  const entries: FlowEntry[] = flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    flow,
    destination: destinations.find((repository) => repository.id === flow.destinationId),
    sources: flow.sourceIds
      .map((sourceId) => sources.find((source) => source.id === sourceId))
      .filter((source): source is ConfiguredKnowledgeRepository => Boolean(source)),
    documents: documents.filter((document) => document.repositoryId === flow.destinationId),
    isOther: false
  }));

  const claimedDestinations = new Set(flows.map((flow) => flow.destinationId));
  const otherDocuments = documents.filter((document) => !claimedDestinations.has(document.repositoryId));
  if (otherDocuments.length > 0) {
    entries.push({
      id: OTHER_DOCUMENTS_ID,
      name: "Other documents",
      sources: [],
      documents: otherDocuments,
      isOther: true
    });
  }

  return entries;
}

function flowSummary(entry: FlowEntry): string {
  if (entry.isOther) {
    return `${entry.documents.length} unassigned ${entry.documents.length === 1 ? "doc" : "docs"}`;
  }
  const sourceLabel = `${entry.sources.length} ${entry.sources.length === 1 ? "source" : "sources"}`;
  const destinationLabel = entry.destination?.name ?? entry.flow?.destinationId ?? "?";
  return `${sourceLabel} → ${destinationLabel} · ${entry.documents.length} docs`;
}

function groupDocumentsByFolder(documents: KnowledgeDocument[]): Array<{ name: string; documents: KnowledgeDocument[] }> {
  const groups = new Map<string, KnowledgeDocument[]>();
  for (const document of documents) {
    const segments = document.path.split("/");
    const folder = segments.length > 1 ? segments.slice(0, -1).join("/") : "/";
    groups.set(folder, [...(groups.get(folder) ?? []), document]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, groupedDocuments]) => ({
      name,
      documents: groupedDocuments.sort((left, right) => left.path.localeCompare(right.path))
    }));
}

function gitScopeLabel(scope: GitRepositoryContext["scope"] | undefined): string {
  if (scope === "repository-root") {
    return "Git repo";
  }
  if (scope === "subdirectory") {
    return "Git subfolder";
  }
  if (scope === "not-git") {
    return "Not Git";
  }

  return "Unknown";
}
