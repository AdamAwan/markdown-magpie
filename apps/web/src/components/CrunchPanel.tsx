import { useEffect, useState } from "react";
import { isValidCron } from "@magpie/core";
import { ConfiguredKnowledgeFlow, CrunchRun, CrunchSettings, ScheduledTask } from "../lib/types";

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
  return (
    <ScheduleEditor
      loading={loading}
      onRun={() => onRun(setting.flowId)}
      onSave={(enabled, cron) => onSave(setting.flowId, enabled, cron)}
      placeholder="0 2 * * *"
      setting={setting}
      title={flowName}
      lastRunLabel="Last scheduled run"
    />
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
  return (
    <ScheduleEditor
      description={task.description}
      loading={loading}
      onRun={() => onRun(task.key)}
      onSave={(enabled, cron) => onSave(task.key, enabled, cron)}
      placeholder="*/10 * * * *"
      setting={task.settings}
      title={task.label}
      lastRunLabel="Last run"
    />
  );
}

// The "enabled + cron" editor shared by crunch flow schedules and side-process
// schedules. It owns the live form state and a dirty flag so a background refresh
// (which replaces `setting`) never overwrites edits the user is mid-typing; the
// flag clears on save so the freshly persisted values mirror back in.
function ScheduleEditor({
  description,
  lastRunLabel,
  loading,
  onRun,
  onSave,
  placeholder,
  setting,
  title
}: {
  description?: string;
  lastRunLabel: string;
  loading: boolean;
  onRun: () => Promise<void>;
  onSave: (enabled: boolean, cron: string) => Promise<void>;
  placeholder: string;
  setting: { enabled: boolean; cron: string; nextRunAt?: string; lastRunAt?: string };
  title: string;
}) {
  const [enabled, setEnabled] = useState(setting.enabled);
  const [cron, setCron] = useState(setting.cron);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) {
      return;
    }
    setEnabled(setting.enabled);
    setCron(setting.cron);
  }, [dirty, setting.enabled, setting.cron]);

  const cronValid = isValidCron(cron);

  async function save() {
    await onSave(enabled, cron.trim());
    // Persisted: re-mirror server state on the next refresh.
    setDirty(false);
  }

  return (
    <article className="crunchScheduleCard">
      <div className="rowTop">
        <div>
          <h3>{title}</h3>
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
      {description ? <p className="hint">{description}</p> : null}
      <div className="crunchScheduleControls">
        <label className="crunchToggle">
          <input
            checked={enabled}
            onChange={(event) => {
              setDirty(true);
              setEnabled(event.target.checked);
            }}
            type="checkbox"
          />
          <span>Run on a schedule</span>
        </label>
        <label className="field crunchCronField">
          <span>Cron (min hour day month weekday)</span>
          <input
            aria-invalid={!cronValid}
            onChange={(event) => {
              setDirty(true);
              setCron(event.target.value);
            }}
            placeholder={placeholder}
            spellCheck={false}
            value={cron}
          />
        </label>
        <div className="rowActions">
          <button
            className="button secondary"
            disabled={loading || !cronValid}
            onClick={() => void save()}
            title={cronValid ? "Save this schedule" : "Enter a valid 5-field cron expression"}
            type="button"
          >
            Save schedule
          </button>
          <button className="button" disabled={loading} onClick={() => void onRun()} type="button">
            Run now
          </button>
        </div>
      </div>
      <div className="crunchPresets">
        {CRON_PRESETS.map((preset) => (
          <button
            className={cron.trim() === preset.cron ? "chip selected" : "chip"}
            key={preset.cron}
            onClick={() => {
              setDirty(true);
              setCron(preset.cron);
            }}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </div>
      {!cronValid ? <p className="crunchError">Not a valid 5-field cron expression.</p> : null}
      {setting.lastRunAt ? (
        <p className="hint">
          {lastRunLabel} {new Date(setting.lastRunAt).toLocaleString()}
        </p>
      ) : null}
    </article>
  );
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
