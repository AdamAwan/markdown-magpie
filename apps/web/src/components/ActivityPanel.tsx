import { ConfiguredKnowledgeFlow, MaintenanceRun } from "../lib/types";

function taskTypeLabel(taskType: MaintenanceRun["taskType"]): string {
  if (taskType === "process_gaps_to_pull_requests") {
    return "Gap reconciliation";
  }
  if (taskType === "fix_patrol") {
    return "Fix patrol";
  }
  if (taskType === "improve_patrol") {
    return "Improve patrol";
  }
  return taskType;
}

function flowName(flows: ConfiguredKnowledgeFlow[], flowId?: string): string {
  return flows.find((flow) => flow.id === flowId)?.name ?? flowId ?? "Default knowledge base";
}

function numberDetail(details: Record<string, unknown>, key: string): number {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function detailChips(run: MaintenanceRun): string[] {
  if (run.taskType === "process_gaps_to_pull_requests") {
    const details = run.details;
    const chips = [
      `${numberDetail(details, "pullRequestsChecked")} PRs checked`,
      plural(numberDetail(details, "pullRequestTransitions"), "PR transition"),
      plural(numberDetail(details, "clustersCreated"), "cluster created", "clusters created"),
      plural(numberDetail(details, "proposalsDrafted"), "proposal drafted", "proposals drafted")
    ];
    const decisions = numberDetail(details, "mergeDecisions") + numberDetail(details, "splitDecisions");
    chips.push(plural(decisions, "cluster decision"));
    if (details.skippedModelWork === true) {
      chips.push("Skipped model work");
    }
    return chips;
  }

  if (run.taskType === "fix_patrol") {
    return [
      `${numberDetail(run.details, "selectedCount")}/${numberDetail(run.details, "universeCount")} docs checked`,
      plural(Array.isArray(run.details.findings) ? run.details.findings.length : 0, "finding")
    ];
  }

  if (run.taskType === "improve_patrol") {
    return [
      `${numberDetail(run.details, "selectedCount")}/${numberDetail(run.details, "universeCount")} docs checked`,
      plural(numberDetail(run.details, "enqueuedCount"), "improve scan")
    ];
  }

  return [];
}

function selectedPaths(details: Record<string, unknown>): string[] {
  return Array.isArray(details.selected) ? details.selected.filter((value): value is string => typeof value === "string") : [];
}

export function ActivityPanel({ flows, runs }: { flows: ConfiguredKnowledgeFlow[]; runs: MaintenanceRun[] }) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Activity</h2>
        <span className="pill" title="Recent maintenance runs">
          {runs.length}
        </span>
      </div>
      <div className="surfaceBody">
        <p className="hint">
          Durable audit of scheduled and manual maintenance work: what ran, which flow it touched, how it ended,
          and the task-specific counts that explain the result.
        </p>
        <div className="list scrollList">
          {runs.map((run) => {
            const paths = selectedPaths(run.details);
            return (
              <article className="row" key={run.id}>
                <div className="rowTop">
                  <h3>
                    {taskTypeLabel(run.taskType)} · {flowName(flows, run.flowId)}
                  </h3>
                  <span className="rowMeta">
                    <span className={`status ${run.status === "failed" ? "failed" : "completed"}`} title={run.error ?? "Run status"}>
                      {run.status}
                    </span>
                    <span className="pill" title="Run trigger">
                      {run.trigger}
                    </span>
                  </span>
                </div>
                <p>{run.error ?? run.summary}</p>
                <p className="path">
                  {new Date(run.startedAt).toLocaleString()}
                  {run.completedAt ? ` · completed ${new Date(run.completedAt).toLocaleTimeString()}` : ""}
                </p>
                <div className="rowMeta">
                  {detailChips(run).map((chip) => (
                    <span className="pill" key={chip}>
                      {chip}
                    </span>
                  ))}
                </div>
                {paths.length > 0 ? (
                  <ul className="clusterGaps">
                    {paths.slice(0, 6).map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                    {paths.length > 6 ? <li>{paths.length - 6} more</li> : null}
                  </ul>
                ) : null}
              </article>
            );
          })}
          {runs.length === 0 ? <p className="empty">No activity recorded yet.</p> : null}
        </div>
      </div>
    </section>
  );
}
