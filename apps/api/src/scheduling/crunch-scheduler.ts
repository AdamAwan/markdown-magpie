import { nextCronTime } from "@magpie/core";
import type { AppContext } from "../context.js";
import * as crunchService from "../features/crunch/service.js";

export class CrunchScheduler {
  private tickInFlight = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    const tickMs = Number.parseInt(process.env.CRUNCH_SCHEDULER_TICK_MS ?? "60000", 10);
    const interval = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 60_000;
    const timer = setInterval(() => void this.tick(), interval);
    // Don't keep the process alive solely for the scheduler.
    timer.unref?.();
    console.log(`Crunch scheduler started (tick ${interval}ms)`);
  }

  // One tick: fire any enabled schedule whose nextRunAt is due, then reschedule it.
  // Re-entrancy guarded so a slow direct run can't overlap the next tick.
  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      const now = Date.now();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "crunch scheduler tick failed";
      console.error(`Crunch scheduler tick error: ${message}`);
    } finally {
      this.tickInFlight = false;
    }
  }
}
