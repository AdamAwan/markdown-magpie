import { Fragment, useEffect, useState } from "react";
import styled from "@emotion/styled";
import { isValidCron } from "@magpie/core";
import { ConfiguredKnowledgeFlow, ScheduledTask } from "../lib/types";
import { Actions, Badge, Button, Chip, Field, Input, Surface } from "./ui";

// How the schedules table is grouped: by the flow-free task type (so a shared
// description is shown once per type, not repeated per flow) or by flow (so each
// flow's full set of scheduled work sits together).
type GroupBy = "type" | "flow";

const SCHEDULE_COLUMNS =
  "minmax(200px, 1.6fr) minmax(120px, 0.9fr) minmax(150px, 1fr) 64px minmax(170px, auto)";

const Hint = styled.p(({ theme }) => ({
  margin: `0 0 ${theme.space.md}`,
  fontSize: theme.font.size.sm,
  color: theme.color.status.running.fg
}));

const Section = styled.section({
  "&:not(:last-child)": { marginBottom: "28px" }
});

// Schedules header: subhead on the left, group-by toggle on the right.
const SectionHead = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.lg,
  marginBottom: theme.space.md
}));

const Subhead = styled.h3(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.semibold,
  color: theme.color.textMuted
}));

const GroupBySwitch = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md
}));

const GroupByLabel = styled.span(({ theme }) => ({
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold,
  color: theme.color.textMuted
}));

const JobTable = styled.div({ display: "grid" });

const TableHead = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: SCHEDULE_COLUMNS,
  gap: theme.space.lg,
  alignItems: "center",
  borderTop: `1px solid ${theme.color.border}`,
  padding: `10px 0`,
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold
}));

const TableRow = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: SCHEDULE_COLUMNS,
  gap: theme.space.lg,
  alignItems: "center",
  borderTop: `1px solid ${theme.color.border}`,
  padding: `10px 0`,
  fontSize: theme.font.size.md
}));

// Group separator inside the schedules table. A full-width child of the
// single-column JobTable grid (like the inline editor), it names the shared axis
// once so per-row repetition of the type/flow and its description falls away.
const GroupRow = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md,
  borderTop: `1px solid ${theme.color.borderStrong}`,
  padding: `${theme.space.lg} 0 ${theme.space.sm}`
}));

const GroupLabel = styled.span(({ theme }) => ({
  fontWeight: theme.font.weight.semibold,
  fontSize: theme.font.size.sm,
  color: theme.color.text
}));

const GroupCount = styled.span(({ theme }) => ({
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.medium,
  color: theme.color.textSubtle
}));

const ScheduleName = styled.span(({ theme }) => ({
  display: "inline-flex",
  flexDirection: "column",
  gap: "2px",
  lineHeight: 1.3,
  minWidth: 0,
  color: theme.color.textMuted
}));

const ScheduleTitle = styled.span(({ theme }) => ({
  display: "inline-flex",
  alignItems: "center",
  color: theme.color.text,
  fontWeight: theme.font.weight.semibold
}));

const RowActions = styled.span(({ theme }) => ({
  display: "flex",
  gap: theme.space.md,
  justifyContent: "flex-end"
}));

// The "i" info affordance carrying a description in its tooltip.
const Info = styled.span(({ theme }) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "15px",
  height: "15px",
  marginLeft: theme.space.sm,
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: "50%",
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold,
  fontStyle: "italic",
  lineHeight: 1,
  cursor: "help",
  verticalAlign: "middle",
  "&:hover, &:focus-visible": {
    borderColor: theme.color.textSubtle,
    color: theme.color.text,
    outline: "none"
  }
}));

// Inline editor revealed under the row being edited. Full-width because it is a
// plain block sibling inside the single-column JobTable grid.
const ScheduleEditorRoot = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg,
  borderTop: `1px solid ${theme.color.border}`,
  borderLeft: `3px solid ${theme.color.borderStrong}`,
  background: theme.color.surfaceMuted,
  padding: `${theme.space.lg} ${theme.space.xl} ${theme.space.xl}`
}));

const ScheduleControls = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: theme.space.xl
}));

const Toggle = styled.label(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md,
  fontSize: theme.font.size.base,
  fontWeight: theme.font.weight.medium
}));

const CronField = styled(Field)({ maxWidth: "280px" });

const CronInput = styled(Input)(({ theme }) => ({
  fontFamily: theme.font.mono,
  '&[aria-invalid="true"]': { borderColor: theme.color.dangerBorder }
}));

const Presets = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space.md,
  marginTop: theme.space.xs
}));

const ErrorText = styled.p(({ theme }) => ({
  color: theme.color.dangerText,
  fontWeight: theme.font.weight.semibold
}));

const EmptyLine = styled.p(({ theme }) => ({
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.lg,
  color: theme.color.textMuted
}));

export function SchedulesPanel({
  flows,
  loading,
  onRunTask,
  onSaveTask,
  scheduledTasks
}: {
  flows: ConfiguredKnowledgeFlow[];
  loading: boolean;
  onRunTask: (key: string) => Promise<void>;
  onSaveTask: (key: string, enabled: boolean, cron: string) => Promise<void>;
  scheduledTasks: ScheduledTask[];
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const flowName = (flowId?: string) => flows.find((flow) => flow.id === flowId)?.name ?? flowId ?? "Default knowledge base";

  // Each scheduled task carries both grouping axes — the flow-free task type and
  // the flow it runs for — so the table can group by either without re-parsing
  // keys or display labels.
  const entries: ScheduleEntry[] = scheduledTasks.map((task) => ({
    id: `task:${task.key}`,
    typeKey: task.baseKey,
    typeLabel: task.typeLabel,
    typeDescription: task.description,
    flowName: flowName(task.flowId),
    setting: task.settings,
    placeholder: "*/10 * * * *",
    onSave: (enabled: boolean, cron: string) => onSaveTask(task.key, enabled, cron),
    onRun: () => onRunTask(task.key)
  }));

  const groups = groupEntries(entries, groupBy);

  return (
    <Surface>
      <Surface.Header>
        <h2>Schedules</h2>
        <Badge title="Scheduled background tasks">
          {entries.length} task{entries.length === 1 ? "" : "s"}
        </Badge>
      </Surface.Header>
      <Surface.Body>
        <Hint>
          Background tasks run on the watcher on a cron schedule: gap reconciliation, source-change sync, and the fix
          and improve patrols that keep the knowledge base correct and tidy. Enable, disable, or run each on demand.
        </Hint>

        <Section>
          <SectionHead>
            <Subhead>Schedules</Subhead>
            <GroupBySwitch role="group" aria-label="Group schedules by">
              <GroupByLabel>Group by</GroupByLabel>
              <Chip selected={groupBy === "type"} onClick={() => setGroupBy("type")}>
                Job type
              </Chip>
              <Chip selected={groupBy === "flow"} onClick={() => setGroupBy("flow")}>
                Flow
              </Chip>
            </GroupBySwitch>
          </SectionHead>
          <JobTable>
            <TableHead>
              <span>{groupBy === "type" ? "Flow" : "Job type"}</span>
              <span>Cron</span>
              <span>Next run</span>
              <span>Status</span>
              <span />
            </TableHead>
            {groups.map((group) => (
              <Fragment key={group.key}>
                <GroupRow>
                  <GroupLabel>{group.label}</GroupLabel>
                  {group.description ? <InfoDot label={group.label} text={group.description} /> : null}
                  <GroupCount>
                    {group.entries.length} schedule{group.entries.length === 1 ? "" : "s"}
                  </GroupCount>
                </GroupRow>
                {group.entries.map((entry) => (
                  <ScheduleRow entry={entry} groupBy={groupBy} key={entry.id} loading={loading} />
                ))}
              </Fragment>
            ))}
            {entries.length === 0 ? <EmptyLine>No scheduled tasks are configured.</EmptyLine> : null}
          </JobTable>
        </Section>
      </Surface.Body>
    </Surface>
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
    <Info aria-label={`About ${label}: ${text}`} role="img" tabIndex={0} title={text}>
      i
    </Info>
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
      <TableRow>
        <ScheduleName>
          <ScheduleTitle>
            {namesType ? entry.typeLabel : entry.flowName}
            {namesType && entry.typeDescription ? <InfoDot label={entry.typeLabel} text={entry.typeDescription} /> : null}
          </ScheduleTitle>
        </ScheduleName>
        <span>{setting.enabled ? <code>{setting.cron}</code> : "—"}</span>
        <span>{setting.enabled && setting.nextRunAt ? new Date(setting.nextRunAt).toLocaleString() : "—"}</span>
        <Badge tone={setting.enabled ? "completed" : "pending"} title="Schedule status">
          {setting.enabled ? "On" : "Off"}
        </Badge>
        <RowActions>
          <Button size="sm" disabled={loading} onClick={() => void entry.onRun()} title="Run this now">
            Run now
          </Button>
          <Button size="sm" aria-expanded={editing} onClick={() => setEditing((value) => !value)}>
            {editing ? "Close" : "Edit"}
          </Button>
        </RowActions>
      </TableRow>
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
    <ScheduleEditorRoot>
      <ScheduleControls>
        <Toggle>
          <input
            checked={enabled}
            onChange={(event) => {
              setDirty(true);
              setEnabled(event.target.checked);
            }}
            type="checkbox"
          />
          <span>Run on a schedule</span>
        </Toggle>
        <CronField label="Cron (min hour day month weekday)">
          <CronInput
            aria-invalid={!cronValid}
            onChange={(event) => {
              setDirty(true);
              setCron(event.target.value);
            }}
            placeholder={placeholder}
            spellCheck={false}
            value={cron}
          />
        </CronField>
        <Actions>
          <Button
            size="sm"
            disabled={loading || !cronValid}
            onClick={() => void save()}
            title={cronValid ? "Save this schedule" : "Enter a valid 5-field cron expression"}
          >
            Save schedule
          </Button>
        </Actions>
      </ScheduleControls>
      <Presets>
        {CRON_PRESETS.map((preset) => (
          <Chip
            selected={cron.trim() === preset.cron}
            key={preset.cron}
            onClick={() => {
              setDirty(true);
              setCron(preset.cron);
            }}
          >
            {preset.label}
          </Chip>
        ))}
      </Presets>
      {!cronValid ? <ErrorText>Not a valid 5-field cron expression.</ErrorText> : null}
    </ScheduleEditorRoot>
  );
}
