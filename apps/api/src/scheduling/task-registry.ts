import type { ScheduledTaskSettings } from "@magpie/core";
import type { AppContext } from "../context.js";
import * as sourceSyncService from "../features/source-sync/service.js";
import { reconcileGaps } from "./gap-reconciler.js";

// A background side-process the operator can schedule from the Crunch page. The
// registry is the single place to add new scheduled work: give it a key, copy,
// a default cron, and a handler, and it appears in the UI and the scheduler.
export interface ScheduledTaskDefinition {
  key: string;
  label: string;
  description: string;
  defaultCron: string;
  run(ctx: AppContext): Promise<void>;
}

export const scheduledTaskDefinitions: ScheduledTaskDefinition[] = [
  {
    key: "gaps-to-pull-requests",
    label: "Clustered gaps → pull requests",
    description:
      "Reconciles knowledge gaps into clusters and proposals, detects merged/closed pull requests, and " +
      "publishes open proposals. Requires GITHUB_TOKEN for PR operations.",
    defaultCron: "*/10 * * * *",
    run: runGapReconciler
  },
  {
    key: "source-change-sync",
    label: "Source change → knowledge base sync",
    description:
      "Watches each flow's git sources for new commits. When a change outdates a knowledge-base document " +
      "that already describes the affected behaviour (e.g. a threshold or date that moved), the document is " +
      "rewritten to match and the result lands on a review branch. Only documents the knowledge base already " +
      "covers are touched.",
    defaultCron: "*/10 * * * *",
    run: syncSourceChanges
  }
];

export function findScheduledTask(key: string): ScheduledTaskDefinition | undefined {
  return scheduledTaskDefinitions.find((task) => task.key === key);
}

// The default (unsaved) schedule for a registered task, so the UI can render a
// control before the schedule has ever been saved.
function defaultScheduledTaskSettings(task: ScheduledTaskDefinition): ScheduledTaskSettings {
  return { key: task.key, enabled: false, cron: task.defaultCron };
}

// Always returns one row per registered task, merging in any saved schedule so
// the UI can render a control even before the schedule has been saved once.
export async function scheduledTasksForResponse(ctx: AppContext): Promise<
  Array<{ key: string; label: string; description: string; settings: ScheduledTaskSettings }>
> {
  const stored = await ctx.stores.scheduledTasks.listSettings();
  const byKey = new Map(stored.map((setting) => [setting.key, setting]));
  return scheduledTaskDefinitions.map((task) => ({
    key: task.key,
    label: task.label,
    description: task.description,
    settings: byKey.get(task.key) ?? defaultScheduledTaskSettings(task)
  }));
}

// The single gap-reconciliation job. It runs inline in the scheduler handler:
// the deployment is single-instance today, so one process owns the cron. If
// multi-instance deployment is introduced, this should enqueue a claimed AI job
// (via the existing claim-lease) instead of running inline — see the reconciler
// design seam noted in the plan.
async function runGapReconciler(ctx: AppContext): Promise<void> {
  await reconcileGaps(ctx);
}

// Runs the source-change sync for every configured flow (or the default flow
// when none are configured). Each flow is best-effort and logged so one failure
// can't abort the others.
async function syncSourceChanges(ctx: AppContext): Promise<void> {
  const flows = ctx.repositoryDeps().knowledgeConfig.flows;
  const targets = flows.length > 0 ? flows.map((flow) => flow.id) : [undefined];

  for (const flowId of targets) {
    try {
      const runs = await sourceSyncService.triggerSourceSyncRun(ctx, { flowId, trigger: "scheduled" });
      for (const run of runs) {
        console.log(
          `Source-change sync run ${run.id} (${run.status}) for source ${run.sourceId} in flow ${flowId ?? "default"}.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "source-change sync failed";
      console.warn(`Source-change sync failed for flow ${flowId ?? "default"}: ${message}`);
    }
  }
}
