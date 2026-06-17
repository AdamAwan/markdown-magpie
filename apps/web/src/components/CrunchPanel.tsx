import { useEffect, useState } from "react";
import { ConfiguredKnowledgeFlow, CrunchRun, CrunchSettings, ScheduledTask } from "../lib/types.js";

export function CrunchPanel({
  flows,
  loading,
  onPublish,
  onRun,
  onRunTask,
  onSaveSchedule,
  onSaveTask,
  runs,
  scheduledTasks,
  settings
}: {
  flows: ConfiguredKnowledgeFlow[];
  loading: boolean;
  onPublish: (runId: string) => Promise<void>;
  onRun: (flowId?: string) => Promise<void>;
  onRunTask: (key: string) => Promise<void>;
  onSaveSchedule: (flowId: string | undefined, enabled: boolean, cron: string) => Promise<void>;
  onSaveTask: (key: string, enabled: boolean, cron: string) => Promise<void>;
  runs: CrunchRun[];
  scheduledTasks: ScheduledTask[];
  settings: CrunchSettings[];
}) {
  const flowName = (flowId?: string) => flows.find((flow) => flow.id === flowId)?.name ?? flowId ?? "Default knowledge base";

  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Crunch</h2>
        <span className="pill" title="Scheduled knowledge-base tidying runs">
          {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="surfaceBody">
        <p className="hint">
          Crunch runs an AI maintenance pass over the knowledge base: it consolidates overlapping documents and splits
          bloated ones, then lands the result on a review branch. Schedule it, or run it on demand.
        </p>

        <div className="crunchSchedules">
          {settings.map((setting) => (
            <CrunchScheduleCard
              flowName={flowName(setting.flowId)}
              key={setting.flowId ?? "__default__"}
              loading={loading}
              onRun={onRun}
              onSave={onSaveSchedule}
              setting={setting}
            />
          ))}
          {settings.length === 0 ? <p className="empty">No knowledge flows are configured to crunch.</p> : null}
        </div>

        <div className="crunchSchedules">
          <h3 className="crunchSubhead">Side processes</h3>
          {scheduledTasks.map((task) => (
            <ScheduledTaskCard key={task.key} loading={loading} onRun={onRunTask} onSave={onSaveTask} task={task} />
          ))}
          {scheduledTasks.length === 0 ? <p className="empty">No scheduled side-processes are registered.</p> : null}
        </div>

        <div className="crunchRuns">
          <h3 className="crunchSubhead">Recent runs</h3>
          <div className="list scrollList">
            {runs.map((run) => (
              <CrunchRunCard
                flowName={flowName(run.flowId)}
                key={run.id}
                loading={loading}
                onPublish={onPublish}
                run={run}
              />
            ))}
            {runs.length === 0 ? <p className="empty">No crunch runs yet. Use “Run now” to create one.</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every 10 minutes", cron: "*/10 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily 02:00", cron: "0 2 * * *" },
  { label: "Weekly (Mon 02:00)", cron: "0 2 * * 1" }
];

function CrunchScheduleCard({
  flowName,
  loading,
  onRun,
  onSave,
  setting
}: {
  flowName: string;
  loading: boolean;
  onRun: (flowId?: string) => Promise<void>;
  onSave: (flowId: string | undefined, enabled: boolean, cron: string) => Promise<void>;
  setting: CrunchSettings;
}) {
  const [enabled, setEnabled] = useState(setting.enabled);
  const [cron, setCron] = useState(setting.cron);

  useEffect(() => {
    setEnabled(setting.enabled);
    setCron(setting.cron);
  }, [setting.enabled, setting.cron]);

  const cronValid = isValidCronExpression(cron);

  return (
    <article className="crunchScheduleCard">
      <div className="rowTop">
        <div>
          <h3>{flowName}</h3>
          <p className="path">
            {setting.enabled
              ? `Scheduled (${setting.cron})${
                  setting.nextRunAt ? ` · next ${new Date(setting.nextRunAt).toLocaleString()}` : ""
                }`
              : "Schedule disabled"}
          </p>
        </div>
        <span className={`status ${setting.enabled ? "completed" : "pending"}`} title="Schedule status">
          {setting.enabled ? "On" : "Off"}
        </span>
      </div>
      <div className="crunchScheduleControls">
        <label className="crunchToggle">
          <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />
          <span>Run on a schedule</span>
        </label>
        <label className="field crunchCronField">
          <span>Cron (min hour day month weekday)</span>
          <input
            aria-invalid={!cronValid}
            onChange={(event) => setCron(event.target.value)}
            placeholder="0 2 * * *"
            spellCheck={false}
            value={cron}
          />
        </label>
        <div className="rowActions">
          <button
            className="button secondary"
            disabled={loading || !cronValid}
            onClick={() => void onSave(setting.flowId, enabled, cron.trim())}
            title={cronValid ? "Save this schedule" : "Enter a valid 5-field cron expression"}
            type="button"
          >
            Save schedule
          </button>
          <button className="button" disabled={loading} onClick={() => void onRun(setting.flowId)} type="button">
            Run now
          </button>
        </div>
      </div>
      <div className="crunchPresets">
        {CRON_PRESETS.map((preset) => (
          <button
            className={cron.trim() === preset.cron ? "chip selected" : "chip"}
            key={preset.cron}
            onClick={() => setCron(preset.cron)}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </div>
      {!cronValid ? <p className="crunchError">Not a valid 5-field cron expression.</p> : null}
      {setting.lastRunAt ? (
        <p className="hint">Last scheduled run {new Date(setting.lastRunAt).toLocaleString()}</p>
      ) : null}
    </article>
  );
}

function ScheduledTaskCard({
  loading,
  onRun,
  onSave,
  task
}: {
  loading: boolean;
  onRun: (key: string) => Promise<void>;
  onSave: (key: string, enabled: boolean, cron: string) => Promise<void>;
  task: ScheduledTask;
}) {
  const setting = task.settings;
  const [enabled, setEnabled] = useState(setting.enabled);
  const [cron, setCron] = useState(setting.cron);

  useEffect(() => {
    setEnabled(setting.enabled);
    setCron(setting.cron);
  }, [setting.enabled, setting.cron]);

  const cronValid = isValidCronExpression(cron);

  return (
    <article className="crunchScheduleCard">
      <div className="rowTop">
        <div>
          <h3>{task.label}</h3>
          <p className="path">
            {setting.enabled
              ? `Scheduled (${setting.cron})${
                  setting.nextRunAt ? ` · next ${new Date(setting.nextRunAt).toLocaleString()}` : ""
                }`
              : "Schedule disabled"}
          </p>
        </div>
        <span className={`status ${setting.enabled ? "completed" : "pending"}`} title="Schedule status">
          {setting.enabled ? "On" : "Off"}
        </span>
      </div>
      <p className="hint">{task.description}</p>
      <div className="crunchScheduleControls">
        <label className="crunchToggle">
          <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />
          <span>Run on a schedule</span>
        </label>
        <label className="field crunchCronField">
          <span>Cron (min hour day month weekday)</span>
          <input
            aria-invalid={!cronValid}
            onChange={(event) => setCron(event.target.value)}
            placeholder="*/10 * * * *"
            spellCheck={false}
            value={cron}
          />
        </label>
        <div className="rowActions">
          <button
            className="button secondary"
            disabled={loading || !cronValid}
            onClick={() => void onSave(task.key, enabled, cron.trim())}
            title={cronValid ? "Save this schedule" : "Enter a valid 5-field cron expression"}
            type="button"
          >
            Save schedule
          </button>
          <button className="button" disabled={loading} onClick={() => void onRun(task.key)} type="button">
            Run now
          </button>
        </div>
      </div>
      <div className="crunchPresets">
        {CRON_PRESETS.map((preset) => (
          <button
            className={cron.trim() === preset.cron ? "chip selected" : "chip"}
            key={preset.cron}
            onClick={() => setCron(preset.cron)}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </div>
      {!cronValid ? <p className="crunchError">Not a valid 5-field cron expression.</p> : null}
      {setting.lastRunAt ? <p className="hint">Last run {new Date(setting.lastRunAt).toLocaleString()}</p> : null}
    </article>
  );
}

// Lightweight client-side mirror of the server's cron validation, so the Save
// button can disable on obviously invalid input. The server re-validates.
function isValidCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  const bounds: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7]
  ];
  return parts.every((part, index) => {
    const [min, max] = bounds[index];
    return part.split(",").every((entry) => {
      const stepMatch = /^(.+)\/(\d+)$/.exec(entry);
      const rangePart = stepMatch ? stepMatch[1] : entry;
      if (stepMatch && Number(stepMatch[2]) <= 0) {
        return false;
      }
      if (rangePart === "*") {
        return true;
      }
      const range = /^(\d+)-(\d+)$/.exec(rangePart);
      if (range) {
        const lo = Number(range[1]);
        const hi = Number(range[2]);
        return lo >= min && hi <= max && lo <= hi;
      }
      if (/^\d+$/.test(rangePart)) {
        const value = Number(rangePart);
        return value >= min && value <= max;
      }
      return false;
    });
  });
}

function CrunchRunCard({
  flowName,
  loading,
  onPublish,
  run
}: {
  flowName: string;
  loading: boolean;
  onPublish: (runId: string) => Promise<void>;
  run: CrunchRun;
}) {
  const [expanded, setExpanded] = useState(false);
  const operations = run.plan?.operations ?? [];

  return (
    <article className="row crunchRun">
      <div className="rowTop">
        <div>
          <h3>{run.plan?.summary ?? `Crunch run (${run.status})`}</h3>
          <p className="path">
            {flowName} · {run.trigger} · {run.documentCount} document{run.documentCount === 1 ? "" : "s"} ·{" "}
            {new Date(run.createdAt).toLocaleString()}
          </p>
        </div>
        <span className={`status ${run.status}`} title={`Run status: ${run.status}`}>
          {run.status}
        </span>
      </div>
      {run.error ? <p className="crunchError">{run.error}</p> : null}
      {run.plan?.rationale ? <p>{run.plan.rationale}</p> : null}
      <div className="rowActions">
        {operations.length > 0 ? (
          <button className="chip" onClick={() => setExpanded((value) => !value)} type="button">
            {expanded ? "Hide" : "Show"} {operations.length} operation{operations.length === 1 ? "" : "s"}
          </button>
        ) : run.status === "completed" ? (
          <span className="pill">No changes needed</span>
        ) : null}
        {run.status === "completed" && operations.length > 0 ? (
          <button
            className="button"
            disabled={loading}
            onClick={() => void onPublish(run.id)}
            title="Commit this tidy plan to a new review branch"
            type="button"
          >
            Publish branch
          </button>
        ) : null}
        {run.publication ? (
          <span className="pill" title={`Published commit ${run.publication.commitSha}`}>
            {run.publication.branchName}
          </span>
        ) : null}
      </div>
      {expanded && operations.length > 0 ? (
        <div className="crunchOperations">
          {operations.map((operation, index) => (
            <div className="crunchOperation" key={`${run.id}-op-${index}`}>
              <div className="rowTop">
                <strong>{operation.title}</strong>
                <span className={`status ${operation.kind === "split" ? "ready" : "completed"}`}>{operation.kind}</span>
              </div>
              <p>{operation.reason}</p>
              <div className="crunchFileLists">
                {operation.writes.length > 0 ? (
                  <div>
                    <span className="crunchFileLabel">Writes</span>
                    <ul className="crunchFileList">
                      {operation.writes.map((write) => (
                        <li className="crunchWrite" key={`w-${write.path}`}>
                          + {write.path}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {operation.deletes.length > 0 ? (
                  <div>
                    <span className="crunchFileLabel">Deletes</span>
                    <ul className="crunchFileList">
                      {operation.deletes.map((deletion) => (
                        <li className="crunchDelete" key={`d-${deletion}`}>
                          − {deletion}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}
