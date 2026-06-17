import { FormEvent } from "react";
import {
  ConfiguredKnowledgeFlow,
  ConfiguredKnowledgeRepository,
  GitRepositoryContext,
  KnowledgeDocument,
  RepositoryRef
} from "../lib/types.js";
import { shortSha } from "../lib/format.js";
import { ContextValue } from "./common.js";

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

export function KnowledgeBrowser({
  documents,
  selectedDocument,
  setSelectedDocumentId
}: {
  documents: KnowledgeDocument[];
  selectedDocument?: KnowledgeDocument;
  setSelectedDocumentId: (id: string) => void;
}) {
  const folders = groupDocumentsByFolder(documents);
  return (
    <div className="documentBrowser">
      <div className="documentList">
        {folders.map((folder) => (
          <section className="folderGroup" key={folder.name}>
            <div className="folderHeader">
              <span>{folder.name}</span>
              <small>{folder.documents.length}</small>
            </div>
            {folder.documents.map((document) => (
              <button
                className={selectedDocument?.id === document.id ? "documentItem selected" : "documentItem"}
                key={document.id}
                onClick={() => setSelectedDocumentId(document.id)}
                type="button"
              >
                <span>{document.metadata.title}</span>
                <small>{document.path.split("/").at(-1) ?? document.path}</small>
                <span className={`status ${document.metadata.status}`} title={`Document status: ${document.metadata.status}`}>
                  {document.metadata.status}
                </span>
              </button>
            ))}
          </section>
        ))}
        {documents.length === 0 ? <p className="empty">No Markdown documents indexed yet.</p> : null}
      </div>
      <article className="documentPreview">
        {selectedDocument ? (
          <>
            <div className="rowTop">
              <div>
                <h2>{selectedDocument.metadata.title}</h2>
                <p className="path">{selectedDocument.path}</p>
              </div>
              <span className={`status ${selectedDocument.metadata.status}`} title={`Document status: ${selectedDocument.metadata.status}`}>
                {selectedDocument.metadata.status}
              </span>
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
          <p className="empty">Select a document to view its Markdown.</p>
        )}
      </article>
    </div>
  );
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

export function RepositoryPanel({
  destinations,
  flows,
  indexing,
  onIndex,
  selectedFlowId,
  setSelectedFlowId,
  sources
}: {
  destinations: ConfiguredKnowledgeRepository[];
  flows: ConfiguredKnowledgeFlow[];
  indexing: boolean;
  onIndex: (flowId: string) => Promise<void>;
  selectedFlowId: string;
  setSelectedFlowId: (value: string) => void;
  sources: ConfiguredKnowledgeRepository[];
}) {
  if (flows.length === 0) {
    return <p className="empty">No knowledge flows are configured. Add KNOWLEDGE_FLOWS or KNOWLEDGE_DESTINATIONS to the API environment.</p>;
  }

  return (
    <div className="knowledgeFlows">
      {flows.map((flow) => {
        const destination = destinations.find((repository) => repository.id === flow.destinationId);
        const flowSources = flow.sourceIds
          .map((sourceId) => sources.find((source) => source.id === sourceId))
          .filter((source): source is ConfiguredKnowledgeRepository => Boolean(source));
        const active = selectedFlowId === flow.id;

        return (
          <article className={`knowledgeFlow ${active ? "selected" : ""}`} key={flow.id}>
            <button
              className="flowSelect"
              onClick={() => setSelectedFlowId(flow.id)}
              title={`Select ${flow.name}`}
              type="button"
            >
              <span>{flow.name}</span>
            </button>
            <div className="flowDiagram" aria-label={`${flow.name} knowledge flow`}>
              <div className="flowNodeGroup">
                {flowSources.length > 0 ? (
                  flowSources.map((source) => (
                    <span className={`flowNode ${source.kind ?? "local"}`} key={source.id} title={repositoryLocation(source)}>
                      {source.name}
                    </span>
                  ))
                ) : (
                  <span className="flowNode missing">No sources</span>
                )}
              </div>
              <span className="flowArrow" aria-hidden="true">-&gt;</span>
              <span className={`flowNode destination ${destination?.kind ?? "local"}`} title={destination ? repositoryLocation(destination) : flow.destinationId}>
                {destination?.name ?? flow.destinationId}
              </span>
            </div>
            <button
              className="button"
              disabled={indexing || !destination}
              onClick={() => {
                setSelectedFlowId(flow.id);
                void onIndex(flow.id);
              }}
              title="Index the destination knowledge base used by /ask and MCP"
              type="button"
            >
              {indexing && active ? "Indexing" : "Index KB"}
            </button>
          </article>
        );
      })}
    </div>
  );
}

function repositoryLocation(repository: ConfiguredKnowledgeRepository): string {
  const base = repository.url ?? repository.path ?? repository.kind ?? repository.id;
  return repository.subpath ? `${base} / ${repository.subpath}` : base;
}
