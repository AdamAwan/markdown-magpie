import styled from "@emotion/styled";
import { Proposal } from "../lib/types";
import { shortSha } from "../lib/format";
import { ContextValue } from "./common";
import type { StatusTone } from "../theme/theme";
import { Badge, Chip, EmptyState, ScrollList, Stack, Surface, statusTone } from "./ui";

const ProposalGrid = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.42fr) minmax(0, 1fr)",
  gap: theme.space.xl,
  "@media (max-width: 1050px)": { gridTemplateColumns: "1fr" }
}));

const ProposalItem = styled.button<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "grid",
  gap: theme.space.xs,
  width: "100%",
  border: 0,
  borderTop: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: $selected ? theme.color.accent : theme.color.text,
  padding: `${theme.space.lg} 0`,
  textAlign: "left",
  cursor: "pointer",
  "&:first-of-type": { borderTop: 0 },
  "& > span": { fontWeight: theme.font.weight.semibold }
}));

const ProposalPreview = styled.div(({ theme }) => ({
  display: "grid",
  alignContent: "start",
  gap: theme.space.lg,
  minWidth: 0,
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.lg
}));

const RowTop = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.lg
}));

const Path = styled.small(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm
}));

const PathLine = Path.withComponent("p");

const DraftContext = styled.details(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg,
  fontSize: theme.font.size.md,
  color: theme.color.textMuted,
  "& summary": { cursor: "pointer", userSelect: "none" }
}));

const PublicationSummary = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: theme.space.md,
  "@media (max-width: 1050px)": { gridTemplateColumns: "1fr" }
}));

const ClusterGaps = styled.ul(({ theme }) => ({
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "grid",
  gap: theme.space.sm,
  "& li": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space.lg,
    padding: `${theme.space.sm} ${theme.space.lg}`,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.md,
    background: theme.color.surface,
    fontSize: theme.font.size.md
  },
  "& li > span": { flex: 1, minWidth: 0 }
}));

const Actions = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: theme.space.md,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

const Preview = styled.pre(({ theme }) => ({
  maxHeight: "460px",
  margin: 0,
  overflow: "auto",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  padding: theme.space.xl,
  color: theme.color.text,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.md,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap"
}));

// Post-merge gap-closure outcome badges. A merged proposal no longer blindly
// resolves its gaps — the API re-asks the triggering questions and records
// whether the merged doc actually answered them (see docs/question-logging.md).
// tone reuses the shared status tones so it reads as one system: verified
// (green), reopened (amber), needs attention (red).
const CLOSURE_BADGES: Record<NonNullable<Proposal["closureStatus"]>, { label: string; title: string; tone: StatusTone }> = {
  verified_closed: {
    label: "Verified closed",
    title: "Re-asking the triggering questions confirmed the merged document answers them; the gaps were resolved.",
    tone: "completed"
  },
  reopened: {
    label: "Reopened",
    title: "Re-asking the triggering questions still failed to find a confident, cited answer; the gaps stay open for another draft.",
    tone: "running"
  },
  needs_attention: {
    label: "Needs attention",
    title: "Verification failed repeatedly; the questions are parked from auto-redrafting and need a human look.",
    tone: "failed"
  }
};

// The needs-attention closure badge is a link to the parked-questions surface, so
// the escalation is actionable rather than a dead tooltip (#158).
const ClosureLink = styled.a({
  display: "inline-flex",
  textDecoration: "none",
  cursor: "pointer"
});

export function ProposalPanel({
  loading,
  publishProposal,
  proposals,
  selectedProposal,
  setSelectedProposalId,
  updateProposalStatus,
  mergeProposal
}: {
  loading: boolean;
  publishProposal: (proposalId: string) => Promise<void>;
  proposals: Proposal[];
  selectedProposal?: Proposal;
  setSelectedProposalId: (id: string) => void;
  updateProposalStatus: (proposalId: string, status: Proposal["status"]) => Promise<void>;
  mergeProposal: (proposalId: string) => Promise<void>;
}) {
  return (
    <Surface>
      <Surface.Header>
        <h2>Proposals</h2>
        <Badge tone="neutral" title="Number of generated proposals">
          {proposals.length}
        </Badge>
      </Surface.Header>
      <Surface.Body>
        <ProposalGrid>
          <ScrollList>
            {proposals.map((proposal) => (
              <ProposalItem
                $selected={selectedProposal?.id === proposal.id}
                key={proposal.id}
                onClick={() => setSelectedProposalId(proposal.id)}
                type="button"
              >
                <span>{proposal.title}</span>
                <Path>{proposal.targetPath}</Path>
              </ProposalItem>
            ))}
            {proposals.length === 0 ? <EmptyState>No proposals generated yet.</EmptyState> : null}
          </ScrollList>
          <ProposalPreview>
            {selectedProposal ? (
              <>
                <RowTop>
                  <div>
                    <h3>{selectedProposal.title}</h3>
                    <PathLine>{selectedProposal.targetPath}</PathLine>
                  </div>
                  <Stack gap="xs" align="end">
                    <Badge tone={statusTone(selectedProposal.status)} dot title={`Proposal status: ${selectedProposal.status}`}>
                      {selectedProposal.status}
                    </Badge>
                    {selectedProposal.closureStatus ? (
                      selectedProposal.closureStatus === "needs_attention" ? (
                        // Parked past the retry cap — link to the parked-questions
                        // surface where a human can retry or dismiss (#158).
                        <ClosureLink href="/gaps#parked-questions">
                          <Badge
                            tone={CLOSURE_BADGES[selectedProposal.closureStatus].tone}
                            dot
                            title={`${CLOSURE_BADGES[selectedProposal.closureStatus].title} Open the parked-questions surface.`}
                          >
                            {CLOSURE_BADGES[selectedProposal.closureStatus].label} →
                          </Badge>
                        </ClosureLink>
                      ) : (
                        <Badge
                          tone={CLOSURE_BADGES[selectedProposal.closureStatus].tone}
                          dot
                          title={CLOSURE_BADGES[selectedProposal.closureStatus].title}
                        >
                          {CLOSURE_BADGES[selectedProposal.closureStatus].label}
                        </Badge>
                      )
                    ) : null}
                  </Stack>
                </RowTop>
                {selectedProposal.rationale ? <p>{selectedProposal.rationale}</p> : null}
                {selectedProposal.draftContext ? (
                  <DraftContext>
                    <summary>Draft context — what the model was given</summary>
                    <PublicationSummary>
                      <ContextValue label="Gaps addressed" value={String(selectedProposal.draftContext.gapSummaries.length)} />
                      <ContextValue label="Source files" value={String(selectedProposal.draftContext.sourceFiles.length)} />
                      <ContextValue label="Evidence citations" value={String(selectedProposal.draftContext.evidenceCount)} />
                      <ContextValue label="Open PRs shown" value={String(selectedProposal.draftContext.openPullRequests.length)} />
                    </PublicationSummary>
                    {selectedProposal.draftContext.gapSummaries.length > 0 ? (
                      <ClusterGaps>
                        {selectedProposal.draftContext.gapSummaries.map((summary) => (
                          <li key={summary}>{summary}</li>
                        ))}
                      </ClusterGaps>
                    ) : null}
                    {selectedProposal.draftContext.openPullRequests.length > 0 ? (
                      <>
                        <PathLine>In-flight pull requests the draft was aware of:</PathLine>
                        <ClusterGaps>
                          {selectedProposal.draftContext.openPullRequests.map((pr, index) => (
                            <li key={pr.url ?? `${pr.title}-${index}`}>
                              {pr.url ? (
                                <a href={pr.url} target="_blank" rel="noreferrer">
                                  {pr.title}
                                </a>
                              ) : (
                                pr.title
                              )}
                              {pr.targetPath ? <Path> — {pr.targetPath}</Path> : null}
                            </li>
                          ))}
                        </ClusterGaps>
                      </>
                    ) : null}
                  </DraftContext>
                ) : null}
                <Actions>
                  <Chip
                    selected
                    disabled={loading || selectedProposal.status !== "draft"}
                    onClick={() => void updateProposalStatus(selectedProposal.id, "ready")}
                    title="Mark this draft as ready for the future PR workflow"
                  >
                    Mark Ready
                  </Chip>
                  <Chip
                    selected
                    disabled={loading || selectedProposal.status !== "ready"}
                    onClick={() => void publishProposal(selectedProposal.id)}
                    title="Create and push a Git branch for this ready proposal"
                  >
                    Publish Branch
                  </Chip>
                  {selectedProposal.localGitDestination ? (
                    <Chip
                      selected
                      disabled={loading || selectedProposal.status !== "branch-pushed"}
                      onClick={() => void mergeProposal(selectedProposal.id)}
                      title="Merge this proposal's branch into the local repository's default branch, then resolve its gaps and re-index"
                    >
                      Merge
                    </Chip>
                  ) : (
                    <Chip
                      selected
                      disabled={loading || selectedProposal.status !== "branch-pushed"}
                      onClick={() => void updateProposalStatus(selectedProposal.id, "merged")}
                      title="Mark a branch-only proposal as merged (for a destination with no pull request to poll): resolves its gaps and re-indexes the knowledge base. A proposal with an open PR is marked merged automatically when the PR merges."
                    >
                      Mark Merged
                    </Chip>
                  )}
                  <Chip
                    disabled={loading || selectedProposal.status !== "draft"}
                    onClick={() => void updateProposalStatus(selectedProposal.id, "rejected")}
                    title="Reject this generated proposal"
                  >
                    Reject
                  </Chip>
                  {selectedProposal.publication ? (
                    <Badge tone="neutral" mono title={`Published commit ${selectedProposal.publication.commitSha}`}>
                      {selectedProposal.publication.branchName}
                    </Badge>
                  ) : (
                    <Badge tone="neutral" title="Ready proposals can be published as Git branches">
                      Branch publish available
                    </Badge>
                  )}
                </Actions>
                {selectedProposal.publication ? (
                  <PublicationSummary>
                    <ContextValue label="Branch" value={selectedProposal.publication.branchName} />
                    <ContextValue label="Commit" value={shortSha(selectedProposal.publication.commitSha)} />
                    <ContextValue label="Remote" value={selectedProposal.publication.remoteUrl ?? "Not recorded"} />
                    <ContextValue label="Pull request" value={selectedProposal.publication.pullRequestUrl ?? "Not raised"} />
                    <ContextValue label="Published" value={new Date(selectedProposal.publication.publishedAt).toLocaleString()} />
                  </PublicationSummary>
                ) : null}
                <Preview>{selectedProposal.markdown}</Preview>
              </>
            ) : (
              <EmptyState>Select a generated proposal to review its Markdown.</EmptyState>
            )}
          </ProposalPreview>
        </ProposalGrid>
      </Surface.Body>
    </Surface>
  );
}
