// Shared scaffolding for the cron-style schedulers: a single unref'd interval
// timer, a re-entrancy guard so a slow tick can't overlap the next one, and a
// tick-level error boundary. Subclasses supply only the per-tick body.
export abstract class IntervalScheduler {
  private tickInFlight = false;

  protected abstract readonly tickEnvVar: string;
  protected abstract readonly label: string;
  protected abstract runTick(now: number): Promise<void>;

  start(): void {
    const tickMs = Number.parseInt(process.env[this.tickEnvVar] ?? "60000", 10);
    const interval = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 60_000;
    const timer = setInterval(() => void this.tick(), interval);
    // Don't keep the process alive solely for the scheduler.
    timer.unref?.();
    console.log(`${this.label} started (tick ${interval}ms)`);
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      await this.runTick(Date.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : `${this.label} tick failed`;
      console.error(`${this.label} tick error: ${message}`);
    } finally {
      this.tickInFlight = false;
    }
  }
}
