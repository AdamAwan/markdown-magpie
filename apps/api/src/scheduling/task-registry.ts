import type { ScheduledTaskSettings } from "@magpie/core";
import type { JobType } from "@magpie/jobs";
import type { AppContext } from "../context.js";

// A concrete, schedulable side-process. Each one is a single flow's instance of a
// template below: it has its own key, schedule, and queued job, so the UI and the
// schedule reconciler treat per-flow tasks as independent units. `jobType`/`input`
// are the queue contract both the schedule reconciler and the manual "Run now"
// route enqueue — there is no in-process handler; a capability-matched watcher
// executes the work.
export interface ScheduledTaskDefinition {
  key: string;
  // `baseKey` and `flowId` are the two axes the UI groups by: every flow shares a
  // base task's `typeLabel`/`description`, and every base task runs once per flow.
  // Surfacing them structurally lets the console group without parsing the
  // composite key or the " · "-joined display label (which itself can contain "·").
  baseKey: string;
  flowId?: string;
  // Flow-free name of the task type, e.g. "Clustered gaps → pull requests".
  typeLabel: string;
  // Full per-flow name: `${typeLabel} · ${flowName}`.
  label: string;
  description: string;
  defaultCron: string;
  jobType: JobType;
  input: unknown;
}

// A side-process defined once and expanded to one concrete task per configured
// flow. Running per flow means a busy flow can be scheduled tighter than a quiet
// one, a slow or stuck flow can't block the others (separate run-locks), and a
// gap/PR change in one flow only ever drives that flow's job. The registry is the
// single place to add new scheduled work: give it a base key, copy, a default
// cron, and a flow-scoped handler, and it appears per flow in the UI and scheduler.
interface FlowTaskTemplate {
  baseKey: string;
  // Flow-free name of the task type; the per-flow `label` is this plus " · <flow>".
  typeLabel: string;
  description: string;
  defaultCron: string;
  // The queued job this task reconciles to, and how to build that job's input
  // from the task's flow. The job input schemas are the source of truth: the
  // gaps and snapshot jobs take no input today (`{}`), source sync takes `{flowId}`.
  jobType: JobType;
  input(flowId: string | undefined): unknown;
}

const flowTaskTemplates: FlowTaskTemplate[] = [
  {
    baseKey: "gaps-to-pull-requests",
    typeLabel: "Clustered gaps → pull requests",
    description:
      "Reconciles this flow's knowledge gaps into clusters and proposals, detects merged/closed pull requests " +
      "raised from its proposals, and publishes its open proposals. Requires GITHUB_TOKEN for PR operations.",
    defaultCron: "*/10 * * * *",
    jobType: "process_gaps_to_pull_requests",
    input: () => ({})
  },
  {
    baseKey: "source-change-sync",
    typeLabel: "Source change → knowledge base sync",
    description:
      "Watches this flow's git sources for new commits. When a change outdates a knowledge-base document that " +
      "already describes the affected behaviour (e.g. a threshold or date that moved), the document is rewritten " +
      "to match and the result lands on a review branch. Only documents the knowledge base already covers are touched.",
    defaultCron: "*/10 * * * *",
    jobType: "source_change_sync",
    input: (flowId) => ({ flowId })
  },
  {
    baseKey: "snapshot-refresh",
    typeLabel: "Fetch snapshot · gaps · proposals · PRs",
    description:
      "Downloads this flow's gaps, in-flight proposals, and open pull-request state to an on-disk snapshot the " +
      "reconciler reads. PR polling happens here, on this job's own cadence, instead of during reconciliation — so " +
      "the reconciler stops calling the git host live. Runs more often than the reconciler by default.",
    defaultCron: "*/5 * * * *",
    jobType: "refresh_pull_requests",
    input: () => ({})
  },
  {
    baseKey: "fix-patrol",
    typeLabel: "Fix patrol · rolling knowledge-base check",
    description:
      "Rolls a cursor across this flow's knowledge-base documents, checking the least-recently-visited " +
      "ones each run so the whole knowledge base is revisited over time at a bounded cost per run. " +
      "Correctness lenses that propose fixes are added in a later step.",
    defaultCron: "0 * * * *",
    jobType: "fix_patrol",
    input: (flowId) => ({ flowId })
  }
];

// Composite key encoding the base task and its flow. The un-routed/default flow
// (when no flows are configured) uses the DEFAULT_FLOW_TOKEN. Flow ids are slugs,
// so "::" can't collide with one.
const FLOW_KEY_SEPARATOR = "::";
const DEFAULT_FLOW_TOKEN = "default";

function taskKey(baseKey: string, flowId: string | undefined): string {
  return `${baseKey}${FLOW_KEY_SEPARATOR}${flowId ?? DEFAULT_FLOW_TOKEN}`;
}

// The flows to expand tasks over: every configured flow, or a single un-routed
// "default" flow when none are configured (mirroring the source-sync fallback).
function expansionFlows(ctx: AppContext): Array<{ id: string | undefined; name: string }> {
  const flows = ctx.knowledgeConfig.flows;
  return flows.length > 0
    ? flows.map((flow) => ({ id: flow.id, name: flow.name }))
    : [{ id: undefined, name: "default" }];
}

// Every concrete scheduled task: the cartesian product of templates and flows.
// Computed from config on each call so adding/removing a flow is picked up
// without a restart.
export function listScheduledTasks(ctx: AppContext): ScheduledTaskDefinition[] {
  return flowTaskTemplates.flatMap((template) =>
    expansionFlows(ctx).map((flow) => ({
      key: taskKey(template.baseKey, flow.id),
      baseKey: template.baseKey,
      flowId: flow.id,
      typeLabel: template.typeLabel,
      label: `${template.typeLabel} · ${flow.name}`,
      description: template.description,
      defaultCron: template.defaultCron,
      jobType: template.jobType,
      input: template.input(flow.id)
    }))
  );
}

export function findScheduledTask(ctx: AppContext, key: string): ScheduledTaskDefinition | undefined {
  return listScheduledTasks(ctx).find((task) => task.key === key);
}

// The default (unsaved) schedule for a task, so the UI can render a control before
// the schedule has ever been saved.
function defaultScheduledTaskSettings(task: ScheduledTaskDefinition): ScheduledTaskSettings {
  return { key: task.key, enabled: false, cron: task.defaultCron };
}

// The schedule control's settings as the UI consumes them: the saved/default
// enabled+cron, plus the next-run time sourced from pg-boss (not stored here).
type ScheduledTaskResponseSettings = ScheduledTaskSettings & { nextRunAt?: string };

// One row per concrete (per-flow) task, merging in any saved schedule so the UI
// can render a control even before the schedule has been saved once. Next-run
// timing is read from the queue (pg-boss) and joined by the stable schedule key.
export async function scheduledTasksForResponse(ctx: AppContext): Promise<
  Array<{
    key: string;
    baseKey: string;
    flowId?: string;
    typeLabel: string;
    label: string;
    description: string;
    settings: ScheduledTaskResponseSettings;
  }>
> {
  const stored = await ctx.stores.scheduledTasks.listSettings();
  const byKey = new Map(stored.map((setting) => [setting.key, setting]));
  const schedules = await ctx.jobs.listSchedules();
  const nextRunByKey = new Map(schedules.map((schedule) => [schedule.key, schedule.nextRunAt]));
  return listScheduledTasks(ctx).map((task) => {
    const settings = byKey.get(task.key) ?? defaultScheduledTaskSettings(task);
    return {
      key: task.key,
      baseKey: task.baseKey,
      flowId: task.flowId,
      typeLabel: task.typeLabel,
      label: task.label,
      description: task.description,
      settings: { ...settings, nextRunAt: nextRunByKey.get(scheduleKeyForTask(task.key)) }
    };
  });
}

// The pg-boss schedule key the reconciler uses for a task. Must stay in step with
// `taskScheduleKey` in jobs/schedule-reconciler.ts.
function scheduleKeyForTask(taskKey: string): string {
  return `task:${taskKey}`;
}
