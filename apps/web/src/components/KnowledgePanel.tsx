import { FormEvent, useEffect, useState } from "react";
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

        {active.isOther ? null : (
          <div className="flowStatStrip">
            <FlowStat label="Documents" value={String(active.documents.length)} />
            <FlowStat label="Sources" value={String(active.sources.length)} />
            <FlowStat label="Destination" value={active.destination?.name ?? active.flow?.destinationId ?? "Unknown"} />
            <FlowStat label="Kind" value={active.destination?.kind ?? "local"} />
          </div>
        )}

        {active.isOther || active.sources.length === 0 ? null : (
          <div className="flowSection">
            <h4 className="flowSectionTitle">Sources</h4>
            <div className="flowSourceGrid">
              {active.sources.map((source) => (
                <article className="flowSource" key={source.id}>
                  <span className="flowSourceKind">{source.kind ?? "local"}</span>
                  <strong>{source.name}</strong>
                  <span className="flowSourceLocation">{repositoryLocation(source)}</span>
                  {source.branch ? <span className="flowSourceBranch">{source.branch}</span> : null}
                </article>
              ))}
            </div>
          </div>
        )}

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
            <span className={`flowNode ${source.kind ?? "local"}`} key={source.id} title={repositoryLocation(source)}>
              {source.name}
            </span>
          ))
        ) : (
          <span className="flowNode missing">No sources</span>
        )}
      </div>
      <span className="flowArrow" aria-hidden="true">-&gt;</span>
      <span className={`flowNode destination ${destination?.kind ?? "local"}`} title={destination ? repositoryLocation(destination) : fallbackDestinationId}>
        {destination?.name ?? fallbackDestinationId ?? "Unknown"}
      </span>
    </div>
  );
}

function FlowStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flowStat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

export function UploadPanel({
  onDropFiles,
  onUpload,
  setUploadContent,
  setUploadPath,
  uploadContent,
  uploading,
  uploadPath
}: {
  onDropFiles: (files: FileList | null) => Promise<void>;
  onUpload: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  setUploadContent: (value: string) => void;
  setUploadPath: (value: string) => void;
  uploadContent: string;
  uploading: boolean;
  uploadPath: string;
}) {
  return (
    <section className="uploadWorkspace">
      <form
        className="uploadForm"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void onDropFiles(event.dataTransfer.files);
        }}
        onSubmit={onUpload}
      >
        <div className="uploadEditor">
          <label className="field">
            <span>Path</span>
            <input onChange={(event) => setUploadPath(event.target.value)} placeholder="uploaded/cats-note.md" value={uploadPath} />
          </label>
          <label className="field editorField">
            <span>Markdown</span>
            <textarea
              onChange={(event) => setUploadContent(event.target.value)}
              placeholder={"# Cat introductions\n\nKeep first meetings calm and supervised."}
              rows={14}
              value={uploadContent}
            />
          </label>
        </div>
        <div className="dropHint">Drop a Markdown file here or choose one below.</div>
        <div className="rowActions">
          <label className="fileButton">
            <input accept=".md,text/markdown,text/plain" onChange={(event) => void onDropFiles(event.target.files)} type="file" />
            Choose File
          </label>
          <button className="button" disabled={uploading || !uploadPath.trim() || !uploadContent.trim()} type="submit">
            {uploading ? "Indexing" : "Index Markdown"}
          </button>
        </div>
      </form>
    </section>
  );
}

function repositoryLocation(repository: ConfiguredKnowledgeRepository): string {
  const base = repository.url ?? repository.path ?? repository.kind ?? repository.id;
  return repository.subpath ? `${base} / ${repository.subpath}` : base;
}
