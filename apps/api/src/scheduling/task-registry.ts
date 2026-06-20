import type { ScheduledTaskSettings } from "@magpie/core";
import type { AppContext } from "../context.js";
import * as snapshotService from "../features/snapshots/service.js";
import * as sourceSyncService from "../features/source-sync/service.js";
import { reconcileGaps } from "./gap-reconciler.js";

// A concrete, schedulable side-process. Each one is a single flow's instance of a
// template below: it has its own key, schedule, and run-lock, so the UI and the
// scheduler treat per-flow jobs as independent units.
export interface ScheduledTaskDefinition {
  key: string;
  label: string;
  description: string;
  defaultCron: string;
  run(ctx: AppContext): Promise<void>;
}

// A side-process defined once and expanded to one concrete task per configured
// flow. Running per flow means a busy flow can be scheduled tighter than a quiet
// one, a slow or stuck flow can't block the others (separate run-locks), and a
// gap/PR change in one flow only ever drives that flow's job. The registry is the
// single place to add new scheduled work: give it a base key, copy, a default
// cron, and a flow-scoped handler, and it appears per flow in the UI and scheduler.
interface FlowTaskTemplate {
  baseKey: string;
  label(flowName: string): string;
  description: string;
  defaultCron: string;
  run(ctx: AppContext, flowId: string | undefined): Promise<void>;
}

const flowTaskTemplates: FlowTaskTemplate[] = [
  {
    baseKey: "gaps-to-pull-requests",
    label: (flow) => `Clustered gaps → pull requests · ${flow}`,
    description:
      "Reconciles this flow's knowledge gaps into clusters and proposals, detects merged/closed pull requests " +
      "raised from its proposals, and publishes its open proposals. Requires GITHUB_TOKEN for PR operations.",
    defaultCron: "*/10 * * * *",
    run: (ctx, flowId) => reconcileGaps(ctx, flowId)
  },
  {
    baseKey: "source-change-sync",
    label: (flow) => `Source change → knowledge base sync · ${flow}`,
    description:
      "Watches this flow's git sources for new commits. When a change outdates a knowledge-base document that " +
      "already describes the affected behaviour (e.g. a threshold or date that moved), the document is rewritten " +
      "to match and the result lands on a review branch. Only documents the knowledge base already covers are touched.",
    defaultCron: "*/10 * * * *",
    run: (ctx, flowId) => syncSourceChangesForFlow(ctx, flowId)
  },
  {
    baseKey: "snapshot-refresh",
    label: (flow) => `Fetch snapshot · gaps · proposals · PRs · ${flow}`,
    description:
      "Downloads this flow's gaps, in-flight proposals, and open pull-request state to an on-disk snapshot the " +
      "reconciler reads. PR polling happens here, on this job's own cadence, instead of during reconciliation — so " +
      "the reconciler stops calling the git host live. Runs more often than the reconciler by default.",
    defaultCron: "*/5 * * * *",
    run: (ctx, flowId) => snapshotService.refreshSnapshot(ctx, flowId).then(() => undefined)
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
      label: template.label(flow.name),
      description: template.description,
      defaultCron: template.defaultCron,
      run: (ctx: AppContext) => template.run(ctx, flow.id)
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

// One row per concrete (per-flow) task, merging in any saved schedule so the UI
// can render a control even before the schedule has been saved once.
export async function scheduledTasksForResponse(ctx: AppContext): Promise<
  Array<{ key: string; label: string; description: string; settings: ScheduledTaskSettings }>
> {
  const stored = await ctx.stores.scheduledTasks.listSettings();
  const byKey = new Map(stored.map((setting) => [setting.key, setting]));
  return listScheduledTasks(ctx).map((task) => ({
    key: task.key,
    label: task.label,
    description: task.description,
    settings: byKey.get(task.key) ?? defaultScheduledTaskSettings(task)
  }));
}

// Runs the source-change sync for a single flow. Per-flow error isolation is now
// the scheduler's job (each flow is its own task with its own try/catch), so this
// no longer loops or swallows failures itself.
async function syncSourceChangesForFlow(ctx: AppContext, flowId: string | undefined): Promise<void> {
  const runs = await sourceSyncService.triggerSourceSyncRun(ctx, { flowId, trigger: "scheduled" });
  for (const run of runs) {
    console.log(
      `Source-change sync run ${run.id} (${run.status}) for source ${run.sourceId} in flow ${flowId ?? "default"}.`
    );
  }
}
