import { nextCronTime } from "@magpie/core";
import type { AppContext } from "../context.js";
import { listScheduledTasks } from "./task-registry.js";
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
    for (const task of listScheduledTasks(this.ctx)) {
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
      // Atomically claim this run against the still-due next_run_at. If another
      // API instance already advanced the schedule, the claim returns nothing and
      // we skip — so the task runs once per slot, never once per running instance.
      const claimed = await this.ctx.stores.scheduledTasks.touchSchedule(
        task.key,
        new Date(now).toISOString(),
        nextRunAt.toISOString(),
        setting.nextRunAt
      );
      if (!claimed) {
        continue;
      }
      // Take the run-lock so this slot can't overlap a still-running previous run
      // or a manual "Run now". If a run is already in flight we drop this slot.
      const lock = await this.ctx.stores.scheduledTasks.tryAcquireRun(task.key, task.defaultCron);
      if (!lock) {
        console.log(`Scheduled task ${task.key} is due, but a run is already in flight; skipping this slot.`);
        continue;
      }
      console.log(`Scheduled task ${task.key} due; running.`);
      try {
        await task.run(this.ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : "scheduled task run failed";
        console.error(`Scheduled task ${task.key} failed: ${message}`);
      } finally {
        await this.ctx.stores.scheduledTasks.releaseRun(task.key);
      }
    }
  }
}
