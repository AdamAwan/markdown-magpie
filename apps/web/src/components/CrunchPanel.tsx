import { Fragment, useEffect, useState } from "react";
import { isValidCron } from "@magpie/core";
import { ConfiguredKnowledgeFlow, CrunchRun, CrunchSettingsView, ScheduledTask } from "../lib/types";

// How the schedules table is grouped: by the flow-free task type (so a shared
// description is shown once per type, not repeated per flow) or by flow (so each
// flow's full set of scheduled work sits together).
type GroupBy = "type" | "flow";

// The flow-crunch schedule rows have no server-supplied description; this is the
// type-level blurb shown in their group's info tooltip, mirroring the section hint.
const FLOW_CRUNCH_DESCRIPTION =
  "Consolidates overlapping knowledge-base documents and splits bloated ones for this flow, then lands the result " +
  "on a review branch.";

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
  settings: CrunchSettingsView[];
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const flowName = (flowId?: string) => flows.find((flow) => flow.id === flowId)?.name ?? flowId ?? "Default knowledge base";

  // Flow crunch schedules and generic side-processes are two sources with
  // different save/run endpoints; normalise them into one row shape (with the
  // right handlers bound per row) so they share a single tidy table. Each entry
  // carries both axes — the flow-free task type and the flow — so the table can
  // group by either without re-parsing keys or display labels.
  const entries: ScheduleEntry[] = [
    ...settings.map((setting) => ({
      id: `flow:${setting.flowId ?? "__default__"}`,
      typeKey: "flow-crunch",
      typeLabel: "Knowledge base crunch",
      typeDescription: FLOW_CRUNCH_DESCRIPTION,
      flowName: flowName(setting.flowId),
      kind: "Flow" as const,
      setting,
      placeholder: "0 2 * * *",
      onSave: (enabled: boolean, cron: string) => onSaveSchedule(setting.flowId, enabled, cron),
      onRun: () => onRun(setting.flowId)
    })),
    ...scheduledTasks.map((task) => ({
      id: `task:${task.key}`,
      typeKey: task.baseKey,
      typeLabel: task.typeLabel,
      typeDescription: task.description,
      flowName: flowName(task.flowId),
      kind: "Side process" as const,
      setting: task.settings,
      placeholder: "*/10 * * * *",
      onSave: (enabled: boolean, cron: string) => onSaveTask(task.key, enabled, cron),
      onRun: () => onRunTask(task.key)
    }))
  ];

  const groups = groupEntries(entries, groupBy);

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

        <section className="crunchSection">
          <div className="crunchSectionHead">
            <h3 className="crunchSubhead">Schedules</h3>
            <div className="crunchGroupBy" role="group" aria-label="Group schedules by">
              <span className="crunchGroupByLabel">Group by</span>
              <button
                className={groupBy === "type" ? "chip selected" : "chip"}
                onClick={() => setGroupBy("type")}
                type="button"
              >
                Job type
              </button>
              <button
                className={groupBy === "flow" ? "chip selected" : "chip"}
                onClick={() => setGroupBy("flow")}
                type="button"
              >
                Flow
              </button>
            </div>
          </div>
          <div className="jobTable">
            <div className="tableHead crunchScheduleHead">
              <span>{groupBy === "type" ? "Flow" : "Job type"}</span>
              <span>Cron</span>
              <span>Next run</span>
              <span>Status</span>
              <span />
            </div>
            {groups.map((group) => (
              <Fragment key={group.key}>
                <div className="crunchGroupRow">
                  <span className="crunchGroupLabel">{group.label}</span>
                  {group.description ? <InfoDot label={group.label} text={group.description} /> : null}
                  <span className="crunchGroupCount">
                    {group.entries.length} schedule{group.entries.length === 1 ? "" : "s"}
                  </span>
                </div>
                {group.entries.map((entry) => (
                  <ScheduleRow entry={entry} groupBy={groupBy} key={entry.id} loading={loading} />
                ))}
              </Fragment>
            ))}
            {entries.length === 0 ? (
              <p className="empty">No crunch schedules or side-processes are configured.</p>
            ) : null}
          </div>
        </section>

        <section className="crunchSection">
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
        </section>
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

interface ScheduleEntry {
  id: string;
  // The two grouping axes: the flow-free task type (typeKey/typeLabel, with a
  // shared typeDescription) and the flow it runs for (flowName).
  typeKey: string;
  typeLabel: string;
  typeDescription?: string;
  flowName: string;
  kind: "Flow" | "Side process";
  setting: { enabled: boolean; cron: string; nextRunAt?: string };
  placeholder: string;
  onSave: (enabled: boolean, cron: string) => Promise<void>;
  onRun: () => Promise<void>;
}

interface ScheduleGroup {
  key: string;
  label: string;
  // Only the by-type grouping carries a description (the shared task blurb shown
  // once in the group's info tooltip); by-flow groups leave it undefined and the
  // per-row type label carries its own tooltip instead.
  description?: string;
  entries: ScheduleEntry[];
}

// Bucket entries by the chosen axis, preserving first-seen order so the table is
// stable across refreshes. Grouping by type collapses the per-flow repetition the
// old flat list showed (same long description on every row).
function groupEntries(entries: ScheduleEntry[], by: GroupBy): ScheduleGroup[] {
  const groups = new Map<string, ScheduleGroup>();
  for (const entry of entries) {
    const key = by === "type" ? entry.typeKey : entry.flowName;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: by === "type" ? entry.typeLabel : entry.flowName,
        description: by === "type" ? entry.typeDescription : undefined,
        entries: []
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

// A small "i" affordance whose hover/focus tooltip carries the long task
// description, so the text appears once per group (or once per row) instead of
// being repeated inline under every schedule.
function InfoDot({ label, text }: { label: string; text: string }) {
  return (
    <span aria-label={`About ${label}: ${text}`} className="crunchInfo" role="img" tabIndex={0} title={text}>
      i
    </span>
  );
}

// One row of the schedules table. Collapsed it shows the schedule at a glance;
// the Edit button expands an inline editor, so the cron help and presets appear
// only for the row being edited rather than repeated on every row. The row names
// whichever axis the table is *not* grouped by (flow when grouped by type, and
// vice versa); when it names the type it also carries the description tooltip.
function ScheduleRow({ entry, groupBy, loading }: { entry: ScheduleEntry; groupBy: GroupBy; loading: boolean }) {
  const [editing, setEditing] = useState(false);
  const { setting } = entry;
  const namesType = groupBy === "flow";

  return (
    <>
      <div className="tableRow crunchScheduleRow">
        <span className="crunchScheduleName">
          <span className="crunchScheduleTitle">
            {namesType ? entry.typeLabel : entry.flowName}
            {namesType && entry.typeDescription ? <InfoDot label={entry.typeLabel} text={entry.typeDescription} /> : null}
          </span>
          <span className="crunchScheduleMeta">{entry.kind}</span>
        </span>
        <span>{setting.enabled ? <code>{setting.cron}</code> : "—"}</span>
        <span>{setting.enabled && setting.nextRunAt ? new Date(setting.nextRunAt).toLocaleString() : "—"}</span>
        <span className={`status ${setting.enabled ? "completed" : "pending"}`} title="Schedule status">
          {setting.enabled ? "On" : "Off"}
        </span>
        <span className="crunchRowActions">
          <button
            className="button secondary"
            disabled={loading}
            onClick={() => void entry.onRun()}
            title="Run this now"
            type="button"
          >
            Run now
          </button>
          <button aria-expanded={editing} className="button" onClick={() => setEditing((value) => !value)} type="button">
            {editing ? "Close" : "Edit"}
          </button>
        </span>
      </div>
      {editing ? (
        <ScheduleEditor loading={loading} onSave={entry.onSave} placeholder={entry.placeholder} setting={setting} />
      ) : null}
    </>
  );
}

// Inline "enabled + cron" editor, rendered only under the row being edited. It
// owns the live form state and a dirty flag so a background refresh (which
// replaces `setting`) never overwrites edits the user is mid-typing; the flag
// clears on save so the freshly persisted values mirror back in.
function ScheduleEditor({
  loading,
  onSave,
  placeholder,
  setting
}: {
  loading: boolean;
  onSave: (enabled: boolean, cron: string) => Promise<void>;
  placeholder: string;
  setting: { enabled: boolean; cron: string; nextRunAt?: string };
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
    <div className="crunchScheduleEditor">
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
    </div>
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
            title="Push this tidy plan to a branch and open a pull request"
            type="button"
          >
            Create pull request
          </button>
        ) : null}
        {run.publication ? (
          <span className="pill" title={`Published commit ${run.publication.commitSha}`}>
            {run.publication.branchName}
          </span>
        ) : null}
        {run.publication?.pullRequestUrl ? (
          <a href={run.publication.pullRequestUrl} target="_blank" rel="noreferrer">
            View pull request
          </a>
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
