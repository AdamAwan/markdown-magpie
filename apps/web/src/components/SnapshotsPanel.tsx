import { FlowSnapshot } from "../lib/types";

// Read-only view of each flow's downloaded snapshot: the gaps, in-flight
// proposals, and polled pull-request state the fetch job assembled and the
// reconciler reads instead of polling the host live.
export function SnapshotsPanel({ snapshots }: { snapshots: FlowSnapshot[] }) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Snapshots</h2>
        <span className="pill" title="Flows with a downloaded snapshot">
          {snapshots.length}
        </span>
      </div>
      <div className="surfaceBody">
        <p className="hint">
          Per-flow data the fetch job downloads — gaps, in-flight proposals, and polled pull-request state.
          The reconciler reads this instead of calling the host during reconciliation.
        </p>
        <div className="list scrollList">
          {snapshots.map((snapshot) => (
            <article className="row" key={snapshot.flowId ?? "default"}>
              <div className="rowTop">
                <h3>{snapshot.flowName}</h3>
                <span className="rowMeta">
                  <span className="pill" title="Gaps captured">{snapshot.gaps.length} gaps</span>
                  <span className="pill" title="In-flight proposals">{snapshot.proposals.length} proposals</span>
                  <span className="pill" title="Open pull requests polled">{snapshot.pullRequests.length} PRs</span>
                </span>
              </div>
              <p className="path">
                Taken {new Date(snapshot.takenAt).toLocaleString()} · catalog revision {snapshot.catalogRevision}
              </p>
              {snapshot.proposals.length > 0 ? (
                <ul className="clusterGaps">
                  {snapshot.proposals.map((proposal) => {
                    const pr = snapshot.pullRequests.find((entry) => entry.proposalId === proposal.id);
                    return (
                      <li key={proposal.id}>
                        <span className={`status ${proposal.status}`} title={`Proposal status: ${proposal.status}`}>
                          {proposal.status}
                        </span>{" "}
                        {proposal.title ?? proposal.id}
                        {pr ? (
                          <small className="path">
                            {" "}
                            — PR {pr.state}
                            {pr.merged ? " (merged)" : ""}
                          </small>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </article>
          ))}
          {snapshots.length === 0 ? (
            <p className="empty">No snapshots yet. They appear once a flow&apos;s fetch job has run.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
