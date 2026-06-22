import type { AppContext } from "../context.js";
import { listScheduledTasks } from "../scheduling/task-registry.js";
import type { DesiredSchedule } from "./broker.js";

// Stable schedule keys. Crunch is keyed by flow; each generic side-process is
// keyed by its registry task key (already per-flow). These keys are the contract
// between the saved product settings and the pg-boss schedule rows, so they must
// not change once shipped.
function crunchScheduleKey(flowId: string | undefined): string {
  return `flow:${flowId ?? "default"}`;
}

function taskScheduleKey(taskKey: string): string {
  return `task:${taskKey}`;
}

// Builds the desired pg-boss schedule set from the saved product settings.
// Disabled rows are included so the broker unschedules them; unsaved settings
// default to disabled and so simply never appear.
async function buildDesiredSchedules(ctx: AppContext): Promise<DesiredSchedule[]> {
  const crunchSettings = await ctx.stores.crunchRuns.listSettings();
  const crunchSchedules: DesiredSchedule[] = crunchSettings.map((setting) => ({
    type: "trigger_scheduled_crunch",
    key: crunchScheduleKey(setting.flowId),
    cron: setting.cron,
    input: { flowId: setting.flowId },
    enabled: setting.enabled
  }));

  const taskSettings = await ctx.stores.scheduledTasks.listSettings();
  const tasksByKey = new Map(listScheduledTasks(ctx).map((task) => [task.key, task]));
  const taskSchedules: DesiredSchedule[] = [];
  for (const setting of taskSettings) {
    const task = tasksByKey.get(setting.key);
    if (!task) {
      // A saved schedule for a task that no longer exists (e.g. a flow was
      // removed). Nothing maps it to a job, so leave it for an operator to clean
      // up rather than guessing a job type.
      continue;
    }
    taskSchedules.push({
      type: task.jobType,
      key: taskScheduleKey(setting.key),
      cron: setting.cron,
      input: task.input,
      enabled: setting.enabled
    });
  }

  return [...crunchSchedules, ...taskSchedules];
}

// Reconciles the saved crunch and scheduled-task settings into pg-boss schedules.
// Idempotent and safe to run from any instance: it computes the full desired set
// and hands it to the broker, which schedules/unschedules to match. Call at
// startup (after the broker starts) and after any settings mutation.
export async function reconcileSchedules(ctx: AppContext): Promise<void> {
  await ctx.jobs.reconcileSchedules(await buildDesiredSchedules(ctx));
}
