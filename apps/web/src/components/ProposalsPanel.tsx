import styled from "@emotion/styled";
import { useMemo, useState } from "react";
import { Proposal } from "../lib/types";
import { shortSha } from "../lib/format";
import { BulkProposalAction, bulkActionEligible } from "../lib/console";
import { ContextValue } from "./common";
import type { StatusTone } from "../theme/theme";
import { Badge, Chip, EmptyState, ScrollList, Stack, Surface, statusTone } from "./ui";

const ProposalGrid = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.42fr) minmax(0, 1fr)",
  gap: theme.space.xl,
  "@media (max-width: 1050px)": { gridTemplateColumns: "1fr" }
}));

// A list entry: the bulk-selection checkbox beside the preview button. The
// divider lives here (not on the button) so the checkbox column sits inside it.
const ProposalRow = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  alignItems: "start",
  gap: theme.space.md,
  borderTop: `1px solid ${theme.color.border}`,
  "&:first-of-type": { borderTop: 0 }
}));

// Checkboxes can't nest inside the row's preview <button>, hence the split row.
const RowCheckbox = styled.input(({ theme }) => ({
  marginTop: theme.space.lg,
  accentColor: theme.color.accent,
  cursor: "pointer"
}));

const ProposalItem = styled.button<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "grid",
  gap: theme.space.xs,
  width: "100%",
  border: 0,
  background: theme.color.surface,
  color: $selected ? theme.color.accent : theme.color.text,
  padding: `${theme.space.lg} 0`,
  textAlign: "left",
  cursor: "pointer",
  "& > span": { fontWeight: theme.font.weight.semibold }
}));

// The bulk control strip above the list: select-all plus one chip per bulk
// action, counting the selected proposals eligible for it.
const BulkBar = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: theme.space.md,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  "& > label": {
    display: "inline-flex",
    alignItems: "center",
    gap: theme.space.sm,
    cursor: "pointer",
    userSelect: "none",
    "& > input": { accentColor: theme.color.accent, cursor: "pointer" }
  }
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

// One entry per provenance claim (#214): the claim text, then a muted mono line
// of the source locations that ground it. Sibling of ClusterGaps — the claims
// stack a second line inside each item, so they need their own grid layout.
const ProvenanceClaims = styled.ul(({ theme }) => ({
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "grid",
  gap: theme.space.sm,
  "& li": {
    display: "grid",
    gap: theme.space.xs,
    padding: `${theme.space.sm} ${theme.space.lg}`,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.md,
    background: theme.color.surface,
    fontSize: theme.font.size.md
  },
  "& li > small": {
    color: theme.color.textMuted,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm
  }
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
const CLOSURE_BADGES: Record<
  NonNullable<Proposal["closureStatus"]>,
  { label: string; title: string; tone: StatusTone }
> = {
  verified_closed: {
    label: "Verified closed",
    title: "Re-asking the triggering questions confirmed the merged document answers them; the gaps were resolved.",
    tone: "completed"
  },
  reopened: {
    label: "Reopened",
    title:
      "Re-asking the triggering questions still failed to find a confident, cited answer; the gaps stay open for another draft.",
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

// The bulk bar's actions in pipeline order. Labels pair the local-git and
// hosted verbs since one selection can span both kinds of flow.
const BULK_ACTIONS: Array<{ action: BulkProposalAction; label: string; title: string }> = [
  {
    action: "ready",
    label: "Mark Ready",
    title: "Mark the selected draft proposals as ready to publish"
  },
  {
    action: "publish",
    label: "Publish",
    title: "Queue a publish job for each selected ready proposal"
  },
  {
    action: "merge",
    label: "Accept / Merge",
    title:
      "Merge each selected branch-pushed proposal. Proposals with an open pull request are skipped — they are merged by the PR itself."
  },
  {
    action: "reject",
    label: "Reject / Bin",
    title: "Reject the selected proposals: drafts on hosted flows, pushed review branches (Bin) on local-git flows"
  }
];

export function ProposalPanel({
  loading,
  pendingPublishIds,
  publishProposal,
  proposals,
  selectedProposal,
  setSelectedProposalId,
  updateProposalStatus,
  mergeProposal,
  rejectProposal,
  bulkProposalAction
}: {
  loading: boolean;
  // Proposals whose publish job is still queued or running (derived from the
  // polled jobs list — see pendingPublishProposalIds). Publish stays offered by
  // status alone otherwise, since a queued publish leaves the proposal `ready`.
  pendingPublishIds: ReadonlySet<string>;
  publishProposal: (proposalId: string) => Promise<void>;
  proposals: Proposal[];
  selectedProposal?: Proposal;
  setSelectedProposalId: (id: string) => void;
  updateProposalStatus: (proposalId: string, status: Proposal["status"]) => Promise<void>;
  mergeProposal: (proposalId: string) => Promise<void>;
  rejectProposal: (proposalId: string) => Promise<void>;
  bulkProposalAction: (action: BulkProposalAction, ids: string[]) => Promise<void>;
}) {
  // The bulk selection. Raw state may hold ids that have since left the list
  // (merged/rejected proposals drop off the active page), so every consumer
  // reads the pruned `checked` view; an actioned-but-still-listed proposal
  // (draft → ready) stays checked, which is what lets ready → publish chain.
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const checked = useMemo(() => {
    const listed = new Set(proposals.map((proposal) => proposal.id));
    return checkedIds.filter((id) => listed.has(id));
  }, [checkedIds, proposals]);
  const checkedProposals = useMemo(
    () => proposals.filter((proposal) => checked.includes(proposal.id)),
    [proposals, checked]
  );
  const allChecked = proposals.length > 0 && checked.length === proposals.length;
  const publishQueued = selectedProposal ? pendingPublishIds.has(selectedProposal.id) : false;

  function toggleChecked(id: string) {
    setCheckedIds((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));
  }

  function toggleAll() {
    setCheckedIds(allChecked ? [] : proposals.map((proposal) => proposal.id));
  }

  return (
    <Surface>
      <Surface.Header>
        <h2>Proposals</h2>
        <Badge tone="neutral" title="Number of generated proposals">
          {proposals.length}
        </Badge>
      </Surface.Header>
      <Surface.Body>
        {proposals.length > 0 ? (
          <BulkBar>
            <label title="Select every listed proposal for a bulk action">
              <input aria-label="Select all proposals" checked={allChecked} onChange={toggleAll} type="checkbox" />
              {checked.length > 0 ? `${checked.length} of ${proposals.length} selected` : "Select all"}
            </label>
            {BULK_ACTIONS.map(({ action, label, title }) => {
              const eligibleIds = checkedProposals
                .filter((proposal) =>
                  bulkActionEligible(action, proposal, { publishPending: pendingPublishIds.has(proposal.id) })
                )
                .map((proposal) => proposal.id);
              return (
                <Chip
                  key={action}
                  selected={action !== "reject"}
                  disabled={loading || eligibleIds.length === 0}
                  onClick={() => void bulkProposalAction(action, eligibleIds)}
                  title={title}
                >
                  {label} ({eligibleIds.length})
                </Chip>
              );
            })}
          </BulkBar>
        ) : null}
        <ProposalGrid>
          <ScrollList>
            {proposals.map((proposal) => (
              <ProposalRow key={proposal.id}>
                <RowCheckbox
                  aria-label={`Select ${proposal.title}`}
                  checked={checked.includes(proposal.id)}
                  onChange={() => toggleChecked(proposal.id)}
                  type="checkbox"
                />
                <ProposalItem
                  $selected={selectedProposal?.id === proposal.id}
                  onClick={() => setSelectedProposalId(proposal.id)}
                  type="button"
                >
                  <span>{proposal.title}</span>
                  <Path>{proposal.targetPath}</Path>
                </ProposalItem>
              </ProposalRow>
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
                    <Badge
                      tone={statusTone(selectedProposal.status)}
                      dot
                      title={`Proposal status: ${selectedProposal.status}`}
                    >
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
                      <ContextValue
                        label="Gaps addressed"
                        value={String(selectedProposal.draftContext.gapSummaries.length)}
                      />
                      <ContextValue
                        label="Source files"
                        value={String(selectedProposal.draftContext.sourceFiles.length)}
                      />
                      <ContextValue
                        label="Evidence citations"
                        value={String(selectedProposal.draftContext.evidenceCount)}
                      />
                      <ContextValue
                        label="Open PRs shown"
                        value={String(selectedProposal.draftContext.openPullRequests.length)}
                      />
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
                {selectedProposal.provenance && selectedProposal.provenance.length > 0 ? (
                  // #214: the per-claim provenance map from the draft output. For
                  // local-git flows (no PR) this console view IS the review
                  // surface for claims-vs-sources; for GitHub flows it mirrors
                  // the PR body's "Claim provenance" section.
                  <DraftContext>
                    <summary>Claim provenance ({selectedProposal.provenance.length})</summary>
                    <ProvenanceClaims>
                      {selectedProposal.provenance.map((claim, index) => (
                        <li key={`${claim.anchor ?? ""}-${index}`}>
                          <span>
                            {claim.anchor ? <Path>{claim.anchor} — </Path> : null}
                            {claim.claim}
                          </span>
                          <small>
                            {claim.sources
                              .map((source) =>
                                [
                                  source.sourceId,
                                  source.path ? `: ${source.path}` : "",
                                  source.lines ? ` (${source.lines})` : "",
                                  source.url ? ` ${source.url}` : ""
                                ].join("")
                              )
                              .join(" · ")}
                          </small>
                        </li>
                      ))}
                    </ProvenanceClaims>
                  </DraftContext>
                ) : null}
                <Actions>
                  <Chip
                    selected
                    disabled={loading || selectedProposal.status !== "draft"}
                    onClick={() => void updateProposalStatus(selectedProposal.id, "ready")}
                    title="Mark this draft as ready to publish a review branch"
                  >
                    Mark Ready
                  </Chip>
                  {selectedProposal.localGitDestination ? (
                    // Local-git review model: publish a review branch (no PR), then a
                    // human Accepts (merge) or Bins (reject) it. No PR ceremony.
                    <>
                      <Chip
                        selected
                        disabled={loading || selectedProposal.status !== "ready" || publishQueued}
                        onClick={() => void publishProposal(selectedProposal.id)}
                        title={
                          publishQueued
                            ? "A publish job for this proposal is already queued"
                            : "Push a review branch into the local repository (no pull request)"
                        }
                      >
                        Publish for review
                      </Chip>
                      <Chip
                        selected
                        disabled={loading || selectedProposal.status !== "branch-pushed"}
                        onClick={() => void mergeProposal(selectedProposal.id)}
                        title="Accept: merge the review branch into the local repository's default branch, resolve its gaps, and re-index"
                      >
                        Accept
                      </Chip>
                      <Chip
                        disabled={loading || !bulkActionEligible("reject", selectedProposal)}
                        onClick={() => void rejectProposal(selectedProposal.id)}
                        title="Bin: reject this proposal (at any stage before it merges) — freeze its gap cluster so it is not re-proposed, and delete the review branch if one was published"
                      >
                        Bin
                      </Chip>
                    </>
                  ) : (
                    // GitHub model: publish a branch, open a PR, mark merged / reject.
                    <>
                      <Chip
                        selected
                        disabled={loading || selectedProposal.status !== "ready" || publishQueued}
                        onClick={() => void publishProposal(selectedProposal.id)}
                        title={
                          publishQueued
                            ? "A publish job for this proposal is already queued"
                            : "Create and push a Git branch for this ready proposal"
                        }
                      >
                        Publish Branch
                      </Chip>
                      <Chip
                        selected
                        disabled={loading || selectedProposal.status !== "branch-pushed"}
                        onClick={() => void updateProposalStatus(selectedProposal.id, "merged")}
                        title="Mark a branch-only proposal as merged (for a destination with no pull request to poll): resolves its gaps and re-indexes the knowledge base. A proposal with an open PR is marked merged automatically when the PR merges."
                      >
                        Mark Merged
                      </Chip>
                      <Chip
                        disabled={loading || selectedProposal.status !== "draft"}
                        onClick={() => void updateProposalStatus(selectedProposal.id, "rejected")}
                        title="Reject this generated proposal"
                      >
                        Reject
                      </Chip>
                    </>
                  )}
                  {selectedProposal.publication ? (
                    <Badge tone="neutral" mono title={`Published commit ${selectedProposal.publication.commitSha}`}>
                      {selectedProposal.publication.branchName}
                    </Badge>
                  ) : publishQueued ? (
                    <Badge
                      tone="pending"
                      title="A publish job for this proposal is queued; this page updates when it finishes"
                    >
                      Publish queued
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
                    {selectedProposal.localGitDestination ? null : (
                      <ContextValue
                        label="Pull request"
                        value={selectedProposal.publication.pullRequestUrl ?? "Not raised"}
                      />
                    )}
                    <ContextValue
                      label="Published"
                      value={new Date(selectedProposal.publication.publishedAt).toLocaleString()}
                    />
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
