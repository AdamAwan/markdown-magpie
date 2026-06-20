import { nextCronTime } from "@magpie/core";
import type { AppContext } from "../context.js";
import * as crunchService from "../features/crunch/service.js";
import { IntervalScheduler } from "./interval-scheduler.js";

export class CrunchScheduler extends IntervalScheduler {
  protected readonly tickEnvVar = "CRUNCH_SCHEDULER_TICK_MS";
  protected readonly label = "Crunch scheduler";

  constructor(private readonly ctx: AppContext) {
    super();
  }

  // One tick: fire any enabled schedule whose nextRunAt is due, then reschedule it.
  protected async runTick(now: number): Promise<void> {
    for (const setting of await this.ctx.stores.crunchRuns.listSettings()) {
      if (!setting.enabled || !setting.nextRunAt) {
        continue;
      }
      if (new Date(setting.nextRunAt).getTime() > now) {
        continue;
      }

      const nextRunAt = nextCronTime(setting.cron, new Date(now));
      if (!nextRunAt) {
        console.warn(`Crunch schedule for flow ${setting.flowId ?? "default"} has an invalid cron "${setting.cron}"; skipping.`);
        continue;
      }
      // Reschedule before running so a failure or restart can't cause a tight retry loop.
      await this.ctx.stores.crunchRuns.touchSchedule(setting.flowId, new Date(now).toISOString(), nextRunAt.toISOString());
      console.log(`Crunch schedule due for flow ${setting.flowId ?? "default"}; starting scheduled run.`);
      try {
        await crunchService.triggerCrunchRun(this.ctx, { flowId: setting.flowId, trigger: "scheduled" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "scheduled crunch run failed";
        console.error(`Scheduled crunch run failed for flow ${setting.flowId ?? "default"}: ${message}`);
      }
    }
  }
}
