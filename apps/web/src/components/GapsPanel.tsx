import { useEffect, useMemo, useState } from "react";
import { GapCandidate, SuggestedGapCluster } from "../lib/types";
import { formatQuestionCount } from "../lib/format";
import { FlowTag } from "./common";

const NEW_CLUSTER = "__new__";

interface EditableCluster {
  id: string;
  title: string;
  summaries: string[];
  rationale?: string;
  flowId?: string;
}

function toEditableClusters(clusters: SuggestedGapCluster[]): EditableCluster[] {
  return clusters.map((cluster) => ({
    id: cluster.id,
    title: cluster.title,
    summaries: [...cluster.summaries],
    rationale: cluster.rationale,
    flowId: cluster.flowId
  }));
}

function clusterTitleFor(summary: string): string {
  const words = summary
    .replace(/[?.!]+$/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
  return words || "Knowledge gap";
}

// Shows the semantic gap groupings as an editable starting point: the reviewer
// can move a gap into another cluster or split it into a new one, then draft a
// single proposal per cluster. Edits are local — the server suggestion is only a
// suggestion — and reset whenever a fresh suggestion arrives from the API.
export function GapClusterPanel({
  clusters,
  gaps,
  draftCluster,
  loading,
  flowLabels
}: {
  clusters: SuggestedGapCluster[];
  gaps: GapCandidate[];
  draftCluster: (summaries: string[], flowId?: string) => Promise<void>;
  loading: boolean;
  flowLabels: Record<string, string>;
}) {
  const signature = useMemo(
    () => clusters.map((cluster) => `${cluster.id}:${cluster.summaries.join("|")}`).join("~"),
    [clusters]
  );
  const [groups, setGroups] = useState<EditableCluster[]>(() => toEditableClusters(clusters));
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    setGroups(toEditableClusters(clusters));
    setEdited(false);
    // Re-sync only when the server's suggestion actually changes, so a background
    // refresh does not wipe out an in-progress regrouping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Keyed by (flowId, summary): the same summary can exist in two flows with
  // different questions, so keying on summary alone would conflate their counts.
  const questionIdsByFlowSummary = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const gap of gaps) {
      map.set(`${gap.flowId ?? ""} ${gap.summary}`, gap.questionIds);
    }
    return map;
  }, [gaps]);

  function questionCount(summaries: string[], flowId?: string): number {
    const ids = new Set<string>();
    for (const summary of summaries) {
      for (const id of questionIdsByFlowSummary.get(`${flowId ?? ""} ${summary}`) ?? []) {
        ids.add(id);
      }
    }
    return ids.size;
  }

  function moveSummary(summary: string, targetId: string) {
    setEdited(true);
    setGroups((previous) => {
      // Dropping a gap from / adding it to a group invalidates that group's
      // suggested rationale, so clear it rather than show a stale explanation.
      let next = previous.map((group) =>
        group.summaries.includes(summary)
          ? { ...group, summaries: group.summaries.filter((item) => item !== summary), rationale: undefined }
          : group
      );
      if (targetId === NEW_CLUSTER) {
        // A split inherits the flow of the cluster the gap came from, so the new
        // group still drafts to the right destination.
        const sourceFlowId = previous.find((group) => group.summaries.includes(summary))?.flowId;
        next = [...next, { id: `local-${summary}`, title: clusterTitleFor(summary), summaries: [summary], flowId: sourceFlowId }];
      } else {
        next = next.map((group) =>
          group.id === targetId
            ? { ...group, summaries: [...group.summaries, summary], rationale: undefined }
            : group
        );
      }
      return next.filter((group) => group.summaries.length > 0);
    });
  }

  function renameGroup(id: string, title: string) {
    setEdited(true);
    setGroups((previous) => previous.map((group) => (group.id === id ? { ...group, title } : group)));
  }

  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Suggested Clusters</h2>
        <span className="pill" title="Gap clusters — one proposal each">
          {groups.length}
        </span>
      </div>
      <div className="surfaceBody">
        {edited ? (
          <p className="hint" title="Your groupings override the original suggestion">
            Edited — drafting uses your groupings.
          </p>
        ) : null}
        <div className="list scrollList">
          {groups.map((group) => (
            <article className="clusterCard" key={group.id}>
              <div className="rowTop">
                <input
                  className="clusterTitle"
                  value={group.title}
                  onChange={(event) => renameGroup(group.id, event.target.value)}
                  aria-label="Cluster title"
                />
                <FlowTag flowId={group.flowId} flowLabels={flowLabels} />
                <span
                  className="pill countPill"
                  title={`${questionCount(group.summaries, group.flowId)} question(s) across ${group.summaries.length} gap(s)`}
                >
                  {group.summaries.length} gap{group.summaries.length === 1 ? "" : "s"}
                </span>
              </div>
              {group.rationale ? (
                <p className="clusterRationale" title="Why these gaps were grouped">
                  {group.rationale}
                </p>
              ) : null}
              <ul className="clusterGaps">
                {group.summaries.map((summary) => (
                  <li key={summary}>
                    <span>{summary}</span>
                    <select
                      value=""
                      disabled={loading}
                      aria-label="Move gap to another cluster"
                      onChange={(event) => {
                        if (event.target.value) {
                          moveSummary(summary, event.target.value);
                        }
                      }}
                    >
                      <option value="">Move to…</option>
                      {groups
                        .filter((other) => other.id !== group.id)
                        .map((other) => (
                          <option key={other.id} value={other.id}>
                            {other.title}
                          </option>
                        ))}
                      <option value={NEW_CLUSTER}>New cluster</option>
                    </select>
                  </li>
                ))}
              </ul>
              <div className="rowActions">
                <button
                  className="chip"
                  disabled={loading}
                  onClick={() => void draftCluster(group.summaries, group.flowId)}
                  title="Draft one proposal covering every gap in this cluster"
                  type="button"
                >
                  Draft Proposal
                </button>
              </div>
            </article>
          ))}
          {groups.length === 0 ? <p className="empty">No gap clusters yet.</p> : null}
        </div>
      </div>
    </section>
  );
}

export function GapPanel({
  draftProposal,
  gaps,
  loading,
  flowLabels
}: {
  draftProposal: (gap: GapCandidate) => Promise<void>;
  gaps: GapCandidate[];
  loading: boolean;
  flowLabels: Record<string, string>;
}) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Gap Candidates</h2>
        <span className="pill" title="Number of open gap candidates">
          {gaps.length}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="list scrollList">
          {gaps.map((gap) => (
            // The same summary can surface under two flows, so the flow is part
            // of the key to keep candidates distinct.
            <article className="row" key={`${gap.flowId ?? ""} ${gap.summary}`}>
              <div className="rowTop">
                <h3>{gap.summary}</h3>
                <FlowTag flowId={gap.flowId} flowLabels={flowLabels} />
                <span className="pill countPill" title={`${gap.count} question${gap.count === 1 ? "" : "s"} grouped into this gap`}>
                  {formatQuestionCount(gap.count)}
                </span>
              </div>
              <p title="Question IDs grouped into this gap">{gap.questionIds.join(", ")}</p>
              <div className="rowActions">
                <span title="Most recent matching question">{new Date(gap.latestAskedAt).toLocaleString()}</span>
                <button
                  className="chip"
                  disabled={loading}
                  onClick={() => void draftProposal(gap)}
                  title="Queue a job to draft Markdown for this knowledge gap"
                  type="button"
                >
                  Draft Proposal
                </button>
              </div>
            </article>
          ))}
          {gaps.length === 0 ? <p className="empty">No gap candidates yet.</p> : null}
        </div>
      </div>
    </section>
  );
}
