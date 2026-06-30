import { useEffect, useState } from "react";
import { ChangeIntentTrace, ConfiguredKnowledgeFlow, MaintenanceRun } from "../lib/types";

function taskTypeLabel(taskType: MaintenanceRun["taskType"]): string {
  if (taskType === "process_gaps_to_pull_requests") {
    return "Gap reconciliation";
  }
  if (taskType === "correctness_patrol") {
    return "Correctness patrol";
  }
  if (taskType === "editorial_patrol") {
    return "Editorial patrol";
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

function traceDecisionKind(trace: ChangeIntentTrace): "open-new" | "fold" | "defer" | "drop" {
  return typeof trace.decision === "string" ? trace.decision : trace.decision.kind;
}

function traceDecisionLabel(kind: ReturnType<typeof traceDecisionKind>): string {
  if (kind === "open-new") {
    return "opened proposal";
  }
  if (kind === "fold") {
    return "folded";
  }
  if (kind === "defer") {
    return "deferred";
  }
  return "dropped";
}

function intentTraces(details: Record<string, unknown>): ChangeIntentTrace[] {
  const traces = details.intentTraces;
  if (!Array.isArray(traces)) {
    return [];
  }
  return traces.filter((trace): trace is ChangeIntentTrace => {
    if (!trace || typeof trace !== "object") {
      return false;
    }
    const candidate = trace as Partial<ChangeIntentTrace>;
    return Boolean(candidate.intent && candidate.decision && Array.isArray(candidate.candidatePullRequests));
  });
}

function detailChips(run: MaintenanceRun): string[] {
  const traces = intentTraces(run.details);
  const traceChips = traces.length > 0 ? [plural(traces.length, "intent")] : [];
  for (const kind of ["open-new", "fold", "defer", "drop"] as const) {
    const count = traces.filter((trace) => traceDecisionKind(trace) === kind).length;
    if (count > 0) {
      traceChips.push(count === 1 ? traceDecisionLabel(kind) : `${count} ${traceDecisionLabel(kind)}`);
    }
  }

  if (run.taskType === "process_gaps_to_pull_requests") {
    const details = run.details;
    const chips = [
      `${numberDetail(details, "pullRequestsChecked")} PRs checked`,
      plural(numberDetail(details, "pullRequestTransitions"), "PR transition"),
      plural(numberDetail(details, "clustersCreated"), "cluster created", "clusters created"),
      plural(numberDetail(details, "proposalsDrafted"), "proposal drafted", "proposals drafted"),
      ...traceChips
    ];
    const decisions = numberDetail(details, "mergeDecisions") + numberDetail(details, "splitDecisions");
    chips.push(plural(decisions, "cluster decision"));
    if (details.skippedModelWork === true) {
      chips.push("Skipped model work");
    }
    return chips;
  }

  if (run.taskType === "correctness_patrol") {
    return [
      `${numberDetail(run.details, "selectedCount")}/${numberDetail(run.details, "universeCount")} docs checked`,
      plural(Array.isArray(run.details.findings) ? run.details.findings.length : 0, "finding"),
      ...traceChips
    ];
  }

  if (run.taskType === "editorial_patrol") {
    return [
      `${numberDetail(run.details, "selectedCount")}/${numberDetail(run.details, "universeCount")} docs checked`,
      plural(numberDetail(run.details, "enqueuedCount"), "improve scan"),
      ...traceChips
    ];
  }

  return traceChips;
}

function selectedPaths(details: Record<string, unknown>): string[] {
  return Array.isArray(details.selected)
    ? details.selected.filter((value): value is string => typeof value === "string")
    : [];
}

function TraceDetails({ traces }: { traces: ChangeIntentTrace[] }) {
  if (traces.length === 0) {
    return null;
  }

  return (
    <details className="intentTrace">
      <summary>View trace</summary>
      <div className="traceList">
        {traces.map((trace, index) => {
          const decision = traceDecisionKind(trace);
          return (
            <article className="traceCard" key={`${trace.createdAt}-${index}`}>
              <div className="rowTop">
                <h4>
                  {trace.intent.lens} · {traceDecisionLabel(decision)}
                </h4>
                <span className={`status ${decision === "defer" || decision === "drop" ? "rejected" : "ready"}`}>
                  {decision}
                </span>
              </div>
              <p>{trace.intent.rationale || trace.outcome?.reason || "No rationale recorded."}</p>
              <p className="path">
                Targets: {trace.intent.targets.length > 0 ? trace.intent.targets.join(", ") : "unknown target"}
              </p>
              {trace.outcome ? (
                <p className="path">
                  Outcome:{" "}
                  {[
                    trace.outcome.proposalTitle,
                    trace.outcome.proposalId,
                    trace.outcome.pullRequestUrl,
                    trace.outcome.foldJobId
                  ]
                    .filter(Boolean)
                    .join(" · ") ||
                    trace.outcome.reason ||
                    "recorded"}
                </p>
              ) : null}
              {trace.candidatePullRequests.length > 0 ? (
                <ul className="clusterGaps">
                  {trace.candidatePullRequests.map((candidate) => (
                    <li key={candidate.proposalId}>
                      {candidate.proposalId} {candidate.touchable ? "touchable" : "locked"}
                      {candidate.overlapTargets.length > 0
                        ? ` · overlap ${candidate.overlapTargets.join(", ")}`
                        : " · no overlap"}
                    </li>
                  ))}
                </ul>
              ) : null}
              <details className="rawTrace">
                <summary>Raw JSON</summary>
                <pre>{JSON.stringify(trace, null, 2)}</pre>
              </details>
            </article>
          );
        })}
      </div>
    </details>
  );
}

export function ActivityPanel({ flows, runs }: { flows: ConfiguredKnowledgeFlow[]; runs: MaintenanceRun[] }) {
  const [selectedRun, setSelectedRun] = useState<MaintenanceRun | undefined>();

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
          Durable audit of scheduled and manual maintenance work: what ran, which flow it touched, how it ended, and the
          task-specific counts that explain the result.
        </p>
        <div className="list scrollList">
          {runs.map((run) => {
            const paths = selectedPaths(run.details);
            const traces = intentTraces(run.details);
            return (
              <article className="row" key={run.id}>
                <div className="rowTop">
                  <h3>
                    {taskTypeLabel(run.taskType)} · {flowName(flows, run.flowId)}
                  </h3>
                  <span className="rowMeta">
                    <span
                      className={`status ${run.status === "failed" ? "failed" : "completed"}`}
                      title={run.error ?? "Run status"}
                    >
                      {run.status}
                    </span>
                    <span className="pill" title="Run trigger">
                      {run.trigger}
                    </span>
                    <button
                      aria-label={`View details for ${taskTypeLabel(run.taskType)} run`}
                      className="button secondary"
                      onClick={() => setSelectedRun(run)}
                      type="button"
                    >
                      Details
                    </button>
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
                <TraceDetails traces={traces} />
              </article>
            );
          })}
          {runs.length === 0 ? <p className="empty">No activity recorded yet.</p> : null}
        </div>
      </div>
      {selectedRun ? <MaintenanceRunDetailsModal onClose={() => setSelectedRun(undefined)} run={selectedRun} /> : null}
    </section>
  );
}

// The raw maintenance-run record, pretty-printed. The activity cards already
// summarise each run; this modal is the drill-down for the full `details` JSON
// (the task-specific payload the chips are derived from) when the summary isn't
// enough.
export function MaintenanceRunDetailsModal({ onClose, run }: { onClose: () => void; run: MaintenanceRun }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const formattedDetails = JSON.stringify(run.details ?? {}, null, 2);

  return (
    <div className="docModalBackdrop" onClick={onClose} role="presentation">
      <div
        aria-label={`${taskTypeLabel(run.taskType)} run details`}
        aria-modal="true"
        className="docModal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="docModalHead">
          <div>
            <h3>{taskTypeLabel(run.taskType)} · details</h3>
            <p className="path">
              {run.id}
              {run.completedAt ? ` · Completed ${new Date(run.completedAt).toLocaleString()}` : ""}
            </p>
          </div>
          <button className="button secondary" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <pre className="docModalBody jsonBlock">{formattedDetails}</pre>
      </div>
    </div>
  );
}
