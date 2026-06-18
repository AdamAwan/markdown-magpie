import { nextCronTime } from "@magpie/core";
import type { AppContext } from "../context.js";
import { scheduledTaskDefinitions } from "./task-registry.js";
import { IntervalScheduler } from "./interval-scheduler.js";

// Drives every registered side-process on its own cron, mirroring the Crunch
// scheduler: one timer, a re-entrancy guard, and "reschedule before run" so a
// failure or restart can't cause a tight retry loop.
export class TaskScheduler extends IntervalScheduler {
  protected readonly tickEnvVar = "SCHEDULED_TASK_TICK_MS";
  protected readonly label = "Scheduled task scheduler";

  constructor(private readonly ctx: AppContext) {
    super();
  }

  protected async runTick(now: number): Promise<void> {
    for (const task of scheduledTaskDefinitions) {
      const setting = await this.ctx.stores.scheduledTasks.getSettings(task.key);
      if (!setting?.enabled || !setting.nextRunAt) {
        continue;
      }
      if (new Date(setting.nextRunAt).getTime() > now) {
        continue;
      }

      const nextRunAt = nextCronTime(setting.cron, new Date(now));
      if (!nextRunAt) {
        console.warn(`Scheduled task ${task.key} has an invalid cron "${setting.cron}"; skipping.`);
        continue;
      }
      await this.ctx.stores.scheduledTasks.touchSchedule(task.key, new Date(now).toISOString(), nextRunAt.toISOString());
      console.log(`Scheduled task ${task.key} due; running.`);
      try {
        await task.run(this.ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : "scheduled task run failed";
        console.error(`Scheduled task ${task.key} failed: ${message}`);
      }
    }
  }
}
