import { Proposal } from "../lib/types.js";
import { shortSha } from "../lib/format.js";
import { ContextValue } from "./common.js";

export function ProposalPanel({
  loading,
  publishProposal,
  proposals,
  selectedProposal,
  setSelectedProposalId,
  updateProposalStatus
}: {
  loading: boolean;
  publishProposal: (proposalId: string) => Promise<void>;
  proposals: Proposal[];
  selectedProposal?: Proposal;
  setSelectedProposalId: (id: string) => void;
  updateProposalStatus: (proposalId: string, status: Proposal["status"]) => Promise<void>;
}) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Proposals</h2>
        <span className="pill" title="Number of generated proposals">
          {proposals.length}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="proposalGrid">
          <div className="list scrollList">
            {proposals.map((proposal) => (
              <button
                className={selectedProposal?.id === proposal.id ? "proposalItem selected" : "proposalItem"}
                key={proposal.id}
                onClick={() => setSelectedProposalId(proposal.id)}
                type="button"
              >
                <span>{proposal.title}</span>
                <small className="path">{proposal.targetPath}</small>
              </button>
            ))}
            {proposals.length === 0 ? <p className="empty">No proposals generated yet.</p> : null}
          </div>
          <div className="proposalPreview">
            {selectedProposal ? (
              <>
                <div className="rowTop">
                  <div>
                    <h3>{selectedProposal.title}</h3>
                    <p className="path">{selectedProposal.targetPath}</p>
                  </div>
                  <span className={`status ${selectedProposal.status}`} title={`Proposal status: ${selectedProposal.status}`}>
                    {selectedProposal.status}
                  </span>
                </div>
                {selectedProposal.rationale ? <p>{selectedProposal.rationale}</p> : null}
                <div className="rowActions">
                  <button
                    className="chip selected"
                    disabled={loading || selectedProposal.status !== "draft"}
                    onClick={() => void updateProposalStatus(selectedProposal.id, "ready")}
                    title="Mark this draft as ready for the future PR workflow"
                    type="button"
                  >
                    Mark Ready
                  </button>
                  <button
                    className="chip selected"
                    disabled={loading || selectedProposal.status !== "ready"}
                    onClick={() => void publishProposal(selectedProposal.id)}
                    title="Create and push a Git branch for this ready proposal"
                    type="button"
                  >
                    Publish Branch
                  </button>
                  <button
                    className="chip selected"
                    disabled={loading || (selectedProposal.status !== "branch-pushed" && selectedProposal.status !== "pr-opened")}
                    onClick={() => void updateProposalStatus(selectedProposal.id, "merged")}
                    title="Mark the published PR as merged: resolves its gaps and re-indexes the knowledge base"
                    type="button"
                  >
                    Mark Merged
                  </button>
                  <button
                    className="chip"
                    disabled={loading || selectedProposal.status !== "draft"}
                    onClick={() => void updateProposalStatus(selectedProposal.id, "rejected")}
                    title="Reject this generated proposal"
                    type="button"
                  >
                    Reject
                  </button>
                  {selectedProposal.publication ? (
                    <span className="pill" title={`Published commit ${selectedProposal.publication.commitSha}`}>
                      {selectedProposal.publication.branchName}
                    </span>
                  ) : (
                    <span className="pill" title="Ready proposals can be published as Git branches">
                      Branch publish available
                    </span>
                  )}
                </div>
                {selectedProposal.publication ? (
                  <div className="publicationSummary">
                    <ContextValue label="Branch" value={selectedProposal.publication.branchName} />
                    <ContextValue label="Commit" value={shortSha(selectedProposal.publication.commitSha)} />
                    <ContextValue label="Remote" value={selectedProposal.publication.remoteUrl ?? "Not recorded"} />
                    <ContextValue label="Pull request" value={selectedProposal.publication.pullRequestUrl ?? "Not raised"} />
                    <ContextValue label="Published" value={new Date(selectedProposal.publication.publishedAt).toLocaleString()} />
                  </div>
                ) : null}
                <pre>{selectedProposal.markdown}</pre>
              </>
            ) : (
              <p className="empty">Select a generated proposal to review its Markdown.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
