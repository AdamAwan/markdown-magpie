import { useEffect, useState } from "react";
import styled from "@emotion/styled";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  ConfiguredKnowledgeFlow,
  ConfiguredKnowledgeRepository,
  GitRepositoryContext,
  KnowledgeDocument,
  RepositoryRef
} from "../lib/types";
import { shortSha } from "../lib/format";
import type { AppTheme } from "../theme/theme";
import { ContextValue } from "./common";
import { Actions, Badge, Button, EmptyState, IconButton, Surface, statusTone } from "./ui";

/** Sidebar id for documents that no configured flow produced (e.g. console uploads). */
export const OTHER_DOCUMENTS_ID = "__other_documents__";

// A knowledge-flow node kind decides the node's tint (source local/agent/internet vs.
// the destination, or a "missing" placeholder when no source is configured).
type FlowNodeVariant = "local" | "agent" | "internet" | "destination" | "missing";

const RepositoryContextList = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg
}));

const RepositoryContextCard = styled.article(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg,
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.lg,
  "&:first-of-type": { borderTop: 0, paddingTop: 0 }
}));

const RowTop = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.lg,
  "& > h3": { flex: 1, minWidth: 0 }
}));

const Path = styled.p(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm
}));

const GitContextGrid = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: theme.space.md
}));

export function RepositoryContextPanel({ repositories }: { repositories: RepositoryRef[] }) {
  return (
    <Surface>
      <Surface.Header>
        <h2>Repository context</h2>
        <Badge tone="neutral" title="Indexed knowledge repositories">
          {repositories.length} repos
        </Badge>
      </Surface.Header>
      <Surface.Body>
        <RepositoryContextList>
          {repositories.map((repository) => (
            <RepositoryContextCard key={repository.id}>
              <RowTop>
                <div>
                  <h3>{repository.name}</h3>
                  <Path>{repository.localPath}</Path>
                </div>
                <Badge tone={statusTone(repository.git?.scope)} title={gitScopeLabel(repository.git?.scope)}>
                  {gitScopeLabel(repository.git?.scope)}
                </Badge>
              </RowTop>
              <GitContextGrid>
                <ContextValue label="Repository ID" value={repository.id} />
                <ContextValue label="Provider" value={repository.provider} />
                <ContextValue label="Branch" value={repository.git?.currentBranch ?? repository.defaultBranch} />
                <ContextValue label="HEAD" value={shortSha(repository.git?.headSha)} />
                <ContextValue label="Git Root" value={repository.git?.workTreeRoot ?? "Not detected"} />
                <ContextValue
                  label="Indexed Folder"
                  value={repository.git?.relativePathFromRoot ?? repository.git?.indexedPath ?? repository.localPath}
                />
                <ContextValue
                  label="Remote"
                  value={repository.git?.remoteUrl ?? repository.remoteUrl ?? "Not configured"}
                />
                <ContextValue
                  label="Working Tree"
                  value={
                    repository.git?.hasUncommittedChanges
                      ? "Uncommitted changes"
                      : repository.git?.scope === "not-git"
                        ? "Not a git work tree"
                        : "Clean"
                  }
                />
              </GitContextGrid>
            </RepositoryContextCard>
          ))}
          {repositories.length === 0 ? (
            <EmptyState>No repository context available yet. Index a repository to detect its Git scope.</EmptyState>
          ) : null}
        </RepositoryContextList>
      </Surface.Body>
    </Surface>
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

const FlowWorkspace = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.28fr) minmax(0, 1fr)",
  gap: theme.space.xl,
  minHeight: "560px",
  "@media (max-width: 1050px)": { gridTemplateColumns: "1fr" }
}));

const FlowSidebar = styled.nav(({ theme }) => ({
  display: "grid",
  alignContent: "start",
  gap: theme.space.md,
  maxHeight: "640px",
  overflow: "auto",
  borderRight: `1px solid ${theme.color.border}`,
  paddingRight: theme.space.lg,
  "@media (max-width: 1050px)": { borderRight: 0, paddingRight: 0 }
}));

const FlowSidebarItem = styled.button<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "grid",
  gap: theme.space.xs,
  width: "100%",
  border: `1px solid ${$selected ? theme.color.accentBorder : theme.color.border}`,
  borderRadius: theme.radius.md,
  background: $selected ? theme.color.accentBg : theme.color.surface,
  color: theme.color.text,
  padding: `${theme.space.md} ${theme.space.lg}`,
  textAlign: "left",
  cursor: "pointer"
}));

const FlowSidebarName = styled.span(({ theme }) => ({
  fontSize: theme.font.size.base,
  fontWeight: theme.font.weight.semibold
}));

const FlowSidebarMeta = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.xs
}));

const FlowDetail = styled.section(({ theme }) => ({
  display: "grid",
  alignContent: "start",
  gap: theme.space.xl,
  minWidth: 0
}));

const FlowDetailHead = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: theme.space.lg,
  "& h3": { margin: `0 0 ${theme.space.md}` }
}));

const FlowDetailActions = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md
}));

const FlowSection = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg,
  minWidth: 0
}));

const FlowSectionTitle = styled.h4(({ theme }) => ({
  margin: 0,
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold
}));

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
  const [personaFlow, setPersonaFlow] = useState<ConfiguredKnowledgeFlow | null>(null);

  const entries = buildFlowEntries(flows, destinations, sources, documents);

  if (entries.length === 0) {
    return (
      <EmptyState>
        No knowledge flows are configured. Add KNOWLEDGE_FLOWS or KNOWLEDGE_DESTINATIONS to the API environment.
      </EmptyState>
    );
  }

  const active = entries.find((entry) => entry.id === selectedFlowId) ?? entries[0];
  const activeDocument = active.documents.find((document) => document.id === selectedDocumentId) ?? active.documents[0];

  return (
    <Tooltip.Provider delayDuration={150}>
      <FlowWorkspace>
        <FlowSidebar aria-label="Knowledge flows">
          {entries.map((entry) => (
            <FlowSidebarItem
              $selected={entry.id === active.id}
              key={entry.id}
              onClick={() => setSelectedFlowId(entry.id)}
              type="button"
            >
              <FlowSidebarName>{entry.name}</FlowSidebarName>
              <FlowSidebarMeta>{flowSummary(entry)}</FlowSidebarMeta>
            </FlowSidebarItem>
          ))}
        </FlowSidebar>

        <FlowDetail>
          <FlowDetailHead>
            <div>
              <h3>{active.name}</h3>
              {active.isOther ? (
                <Path>Indexed documents not produced by a configured flow (for example, console uploads).</Path>
              ) : (
                <FlowPipeline
                  destination={active.destination}
                  fallbackDestinationId={active.flow?.destinationId}
                  sources={active.sources}
                />
              )}
            </div>
            <FlowDetailActions>
              {active.flow?.persona ? (
                <IconButton
                  label={`View persona for ${active.name}`}
                  onClick={() => setPersonaFlow(active.flow ?? null)}
                  title="View flow persona"
                >
                  <PersonIcon />
                </IconButton>
              ) : null}
              {active.isOther ? null : (
                <Button
                  variant="primary"
                  disabled={indexing || !active.destination}
                  onClick={() => {
                    setSelectedFlowId(active.id);
                    void onIndex(active.id);
                  }}
                  title="Index the destination knowledge base used by /ask and MCP"
                >
                  {indexing ? "Indexing" : "Index KB"}
                </Button>
              )}
            </FlowDetailActions>
          </FlowDetailHead>

          <FlowSection>
            <FlowSectionTitle>Indexed documents</FlowSectionTitle>
            <FlowDocuments
              documents={active.documents}
              onOpenFull={setFullScreenDocument}
              onSelect={setSelectedDocumentId}
              selectedDocument={activeDocument}
            />
          </FlowSection>
        </FlowDetail>

        {fullScreenDocument ? (
          <DocumentModal document={fullScreenDocument} onClose={() => setFullScreenDocument(null)} />
        ) : null}
        {personaFlow ? <PersonaModal flow={personaFlow} onClose={() => setPersonaFlow(null)} /> : null}
      </FlowWorkspace>
    </Tooltip.Provider>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.69-8 6v2h16v-2c0-3.31-3.58-6-8-6Z"
      />
    </svg>
  );
}

const ModalBackdrop = styled.div(({ theme }) => ({
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(23, 33, 29, 0.55)",
  padding: theme.space.xxl
}));

const Modal = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr)",
  width: "min(900px, 100%)",
  maxHeight: "85vh",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  background: theme.color.surface,
  boxShadow: theme.shadow.card,
  overflow: "hidden"
}));

const ModalHead = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: theme.space.lg,
  borderBottom: `1px solid ${theme.color.border}`,
  padding: theme.space.xl,
  "& h3": { margin: `0 0 ${theme.space.sm}` }
}));

const ModalBody = styled.pre(({ theme }) => ({
  maxHeight: "none",
  margin: 0,
  overflow: "auto",
  padding: theme.space.xl,
  color: theme.color.text,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.md,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap"
}));

// The persona modal reuses the dark "prompt instructions" block: the flow persona is
// the raw snippet appended to the answer prompt, so it reads as code, not prose.
const PromptInstructions = styled(ModalBody)(({ theme }) => ({
  margin: theme.space.xl,
  padding: theme.space.lg,
  background: theme.color.primary,
  color: theme.color.primaryText,
  borderRadius: theme.radius.md,
  fontSize: theme.font.size.sm,
  lineHeight: 1.45,
  wordBreak: "break-word"
}));

/** Shows a flow's persona — the snippet appended to the base answer prompt — in a modal. */
function PersonaModal({ flow, onClose }: { flow: ConfiguredKnowledgeFlow; onClose: () => void }) {
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
    <ModalBackdrop onClick={onClose} role="presentation">
      <Modal
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${flow.name} persona`}
      >
        <ModalHead>
          <div>
            <h3>{flow.name} · persona</h3>
            <Path>Appended to the base answer prompt when this flow answers a question.</Path>
          </div>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </ModalHead>
        <PromptInstructions>{flow.persona}</PromptInstructions>
      </Modal>
    </ModalBackdrop>
  );
}

const FlowPipe = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: theme.space.lg,
  minWidth: 0
}));

const FlowNodeGroup = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space.sm,
  minWidth: 0
}));

function flowNodePalette(theme: AppTheme, variant: FlowNodeVariant) {
  switch (variant) {
    case "agent":
      return {
        borderColor: theme.color.status.running.border,
        background: theme.color.status.running.bg,
        color: theme.color.text
      };
    case "internet":
      return { borderColor: theme.color.accentBorder, background: theme.color.accentBg, color: theme.color.text };
    case "destination":
      return { borderColor: theme.color.accent, background: theme.color.accentBg, color: theme.color.accent };
    case "missing":
      return { borderColor: theme.color.border, background: theme.color.surfaceMuted, color: theme.color.dangerText };
    case "local":
    default:
      return { borderColor: theme.color.border, background: theme.color.surfaceMuted, color: theme.color.text };
  }
}

const FlowNode = styled.span<{ $variant: FlowNodeVariant; $static?: boolean }>(({ theme, $variant, $static }) => ({
  display: "inline-flex",
  alignItems: "center",
  minHeight: "32px",
  maxWidth: "100%",
  borderRadius: theme.radius.sm,
  border: `1px solid ${flowNodePalette(theme, $variant).borderColor}`,
  background: flowNodePalette(theme, $variant).background,
  color: flowNodePalette(theme, $variant).color,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  overflowWrap: "anywhere",
  padding: `${theme.space.sm} ${theme.space.md}`,
  cursor: $static ? "default" : "inherit"
}));

const FlowArrow = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontWeight: theme.font.weight.bold
}));

function repositoryNodeVariant(repository: ConfiguredKnowledgeRepository | undefined): FlowNodeVariant {
  const kind = repository?.kind;
  if (kind === "agent" || kind === "internet") {
    return kind;
  }
  return "local";
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
    <FlowPipe aria-label="Knowledge flow pipeline">
      <FlowNodeGroup>
        {sources.length > 0 ? (
          sources.map((source) => (
            <RepositoryNode variant={repositoryNodeVariant(source)} key={source.id} repository={source} />
          ))
        ) : (
          <FlowNode $variant="missing" $static>
            No sources
          </FlowNode>
        )}
      </FlowNodeGroup>
      <FlowArrow aria-hidden="true">-&gt;</FlowArrow>
      <RepositoryNode variant="destination" fallbackLabel={fallbackDestinationId} repository={destination} />
    </FlowPipe>
  );
}

const RepositoryTooltipContent = styled(Tooltip.Content)(({ theme }) => ({
  zIndex: 60,
  display: "grid",
  gap: theme.space.md,
  maxWidth: "320px",
  border: `1px solid ${theme.color.primary}`,
  borderRadius: theme.radius.md,
  background: theme.color.text,
  color: theme.color.primaryText,
  padding: `${theme.space.md} ${theme.space.lg}`,
  fontSize: theme.font.size.sm,
  boxShadow: "0 8px 24px rgba(23, 33, 29, 0.28)"
}));

const RepositoryTooltipName = styled.strong(({ theme }) => ({
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.semibold
}));

const RepositoryTooltipRows = styled.dl(({ theme }) => ({
  display: "grid",
  gap: theme.space.xs,
  margin: 0
}));

const RepositoryTooltipRow = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "64px minmax(0, 1fr)",
  gap: theme.space.lg,
  "& dt": {
    color: theme.color.textSubtle,
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.semibold
  },
  "& dd": {
    margin: 0,
    fontFamily: theme.font.mono,
    overflowWrap: "anywhere"
  }
}));

const RepositoryTooltipArrow = styled(Tooltip.Arrow)(({ theme }) => ({
  fill: theme.color.text
}));

/**
 * A pipeline node (source or destination) that reveals the repository's
 * details in a tooltip on hover/focus. Falls back to a plain label when the
 * repository could not be resolved.
 */
function RepositoryNode({
  variant,
  fallbackLabel,
  repository
}: {
  variant: FlowNodeVariant;
  fallbackLabel?: string;
  repository?: ConfiguredKnowledgeRepository;
}) {
  if (!repository) {
    return (
      <FlowNode $variant={variant} $static>
        {fallbackLabel ?? "Unknown"}
      </FlowNode>
    );
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
        <FlowNode $variant={variant} $static>
          {repository.name}
        </FlowNode>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <RepositoryTooltipContent sideOffset={6} collisionPadding={12}>
          <RepositoryTooltipName>{repository.name}</RepositoryTooltipName>
          <RepositoryTooltipRows>
            {rows.map((row) => (
              <RepositoryTooltipRow key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </RepositoryTooltipRow>
            ))}
          </RepositoryTooltipRows>
          <RepositoryTooltipArrow />
        </RepositoryTooltipContent>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const FlowDocs = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(200px, 0.42fr) minmax(0, 1fr)",
  gap: theme.space.xl,
  minWidth: 0,
  "@media (max-width: 1050px)": { gridTemplateColumns: "1fr" }
}));

const FlowDocList = styled.div(({ theme }) => ({
  display: "grid",
  alignContent: "start",
  maxHeight: "560px",
  overflow: "auto",
  borderRight: `1px solid ${theme.color.border}`,
  paddingRight: theme.space.lg,
  "@media (max-width: 1050px)": { borderRight: 0, paddingRight: 0 }
}));

const FlowDocGroup = styled.div(({ theme }) => ({
  display: "grid",
  gap: "2px",
  borderTop: `1px solid ${theme.color.border}`,
  padding: `${theme.space.md} 0`,
  "&:first-of-type": { borderTop: 0, paddingTop: 0 }
}));

const FolderHeader = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.md,
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  "& small": { color: theme.color.textMuted }
}));

const FlowDocRow = styled.div<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.md,
  borderRadius: theme.radius.sm,
  background: $selected ? theme.color.accentBg : "transparent",
  padding: `${theme.space.sm} 0 ${theme.space.sm} ${theme.space.lg}`
}));

const FlowDocSelect = styled.button<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "grid",
  gap: theme.space.xs,
  flex: 1,
  minWidth: 0,
  border: 0,
  background: "transparent",
  color: $selected ? theme.color.accent : theme.color.text,
  padding: `${theme.space.xs} 0`,
  textAlign: "left",
  cursor: "pointer",
  "& span": { fontWeight: theme.font.weight.semibold, overflowWrap: "anywhere" },
  "& small": { color: theme.color.textMuted, fontFamily: theme.font.mono, fontSize: theme.font.size.sm }
}));

const FlowDocRowSide = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.sm,
  flexShrink: 0
}));

const FlowDocReader = styled.article(({ theme }) => ({
  display: "grid",
  alignContent: "start",
  gap: theme.space.lg,
  minWidth: 0
}));

const MarkdownViewer = styled.pre(({ theme }) => ({
  maxHeight: "620px",
  margin: 0,
  overflow: "auto",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  padding: theme.space.lg,
  color: theme.color.text,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.md,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap"
}));

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
    return <EmptyState>No Markdown documents indexed yet.</EmptyState>;
  }

  const folders = groupDocumentsByFolder(documents);

  return (
    <FlowDocs>
      <FlowDocList>
        {folders.map((folder) => (
          <FlowDocGroup key={folder.name}>
            <FolderHeader>
              <span>{folder.name}</span>
              <small>{folder.documents.length}</small>
            </FolderHeader>
            {folder.documents.map((document) => {
              const selected = selectedDocument?.id === document.id;
              return (
                <FlowDocRow $selected={selected} key={document.id}>
                  <FlowDocSelect $selected={selected} onClick={() => onSelect(document.id)} type="button">
                    <span>{document.metadata.title}</span>
                    <small>{document.path.split("/").at(-1) ?? document.path}</small>
                  </FlowDocSelect>
                  <FlowDocRowSide>
                    <Badge
                      tone={statusTone(document.metadata.status)}
                      title={`Document status: ${document.metadata.status}`}
                    >
                      {document.metadata.status}
                    </Badge>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onOpenFull(document)}
                      title="Open full Markdown"
                    >
                      Open
                    </Button>
                  </FlowDocRowSide>
                </FlowDocRow>
              );
            })}
          </FlowDocGroup>
        ))}
      </FlowDocList>
      <FlowDocReader>
        {selectedDocument ? (
          <>
            <RowTop>
              <div>
                <h3>{selectedDocument.metadata.title}</h3>
                <Path>{selectedDocument.path}</Path>
              </div>
              <Button variant="secondary" onClick={() => onOpenFull(selectedDocument)}>
                Open full
              </Button>
            </RowTop>
            <Actions>
              <Badge tone="neutral" title="Repository ID">
                {selectedDocument.repositoryId}
              </Badge>
              {selectedDocument.metadata.owner ? (
                <Badge tone="neutral" title="Document owner">
                  {selectedDocument.metadata.owner}
                </Badge>
              ) : null}
              {selectedDocument.metadata.tags.map((tag) => (
                <Badge tone="neutral" key={tag} title="Document tag">
                  {tag}
                </Badge>
              ))}
            </Actions>
            <MarkdownViewer>{selectedDocument.content}</MarkdownViewer>
          </>
        ) : (
          <EmptyState>Select a document to preview its Markdown.</EmptyState>
        )}
      </FlowDocReader>
    </FlowDocs>
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
    <ModalBackdrop onClick={onClose} role="presentation">
      <Modal
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={knowledgeDocument.metadata.title}
      >
        <ModalHead>
          <div>
            <h3>{knowledgeDocument.metadata.title}</h3>
            <Path>{knowledgeDocument.path}</Path>
          </div>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </ModalHead>
        <ModalBody>{knowledgeDocument.content}</ModalBody>
      </Modal>
    </ModalBackdrop>
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

function groupDocumentsByFolder(
  documents: KnowledgeDocument[]
): Array<{ name: string; documents: KnowledgeDocument[] }> {
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
