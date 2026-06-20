import { ReconciliationDecision } from "../lib/types";

// Read-only history of the reconciler's clustering decisions: the proposing
// model's rationale for each merge/split and whether the critic confirmed and the
// reconciler applied it. Surfaces reasoning that previously lived only in logs.
export function ReconciliationsPanel({ decisions }: { decisions: ReconciliationDecision[] }) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Reconciliations</h2>
        <span className="pill" title="Recent clustering decisions">
          {decisions.length}
        </span>
      </div>
      <div className="surfaceBody">
        <p className="hint">
          How the reconciler reshapes each flow&apos;s gap clusters: the model&apos;s rationale for a merge or
          split and whether the critic confirmed it. Only confirmed decisions are applied.
        </p>
        <div className="list scrollList">
          {decisions.map((decision) => (
            <article className="row" key={decision.id}>
              <div className="rowTop">
                <h3>
                  {decision.kind === "merge" ? "Merge" : "Split"} · {decision.flowId ?? "default"}
                </h3>
                <span className="rowMeta">
                  <span
                    className={`status ${decision.confirmed ? "ready" : "rejected"}`}
                    title="Critic verdict"
                  >
                    {decision.confirmed ? "confirmed" : "rejected"}
                  </span>
                  {decision.applied ? (
                    <span className="status merged" title="Applied to the flow's clusters">
                      applied
                    </span>
                  ) : null}
                </span>
              </div>
              <p>{decision.rationale}</p>
              <p className="path">
                {decision.clusterIds.length} cluster{decision.clusterIds.length === 1 ? "" : "s"} ·{" "}
                {new Date(decision.createdAt).toLocaleString()}
              </p>
            </article>
          ))}
          {decisions.length === 0 ? (
            <p className="empty">No reconciliation decisions recorded yet.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
