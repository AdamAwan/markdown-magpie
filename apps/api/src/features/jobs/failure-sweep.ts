import type { AppContext } from "../../context.js";
import { logger } from "../../logger.js";
import { settleTerminalFailure } from "./service.js";

// THE TERMINAL-FAILURE SWEEP (docs/ai-jobs.md J63). POST /api/jobs/:id/fail runs
// a terminal failure's side effects inline, but pg-boss also fails jobs by
// itself — an active job past its expiry, a lost heartbeat, a crashed claimant —
// and nothing calls the API for those. Their runs, questionnaire items, imports,
// fold fallbacks and patrol verifies used to wait forever. This sweep finds every
// failed job whose failure is not yet settled and settles it through the same
// ledger the fail route uses, so each failure's side effects run exactly once
// whichever path sees it first, on any number of API replicas.

// How many unsettled failures one pass settles. A pass after a long outage may
// find more; the next pass continues where this one stopped (oldest first).
const SWEEP_BATCH = 50;

// The pass cadence, jittered per pass so replicas started together spread out.
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

// One pass: settle up to SWEEP_BATCH unsettled failures. A failure whose side
// effects throw stays unsettled (the ledger releases its claim) and is retried
// next pass; one bad job never blocks the rest of the batch. Returns how many
// this pass settled.
export async function sweepUnsettledFailures(ctx: AppContext): Promise<number> {
  const failures = await ctx.jobs.listUnsettledFailures(SWEEP_BATCH);
  let settled = 0;
  for (const job of failures) {
    try {
      if (await settleTerminalFailure(ctx, job)) {
        settled += 1;
        logger.info(
          { event: "job_failure_settled", jobId: job.id, jobType: job.type, code: job.error?.code, source: "sweep" },
          "settled the side effects of a job the queue failed"
        );
      }
    } catch (error) {
      logger.warn(
        { jobId: job.id, jobType: job.type, err: error instanceof Error ? error.message : String(error) },
        "terminal-failure side effects failed; the next sweep retries them"
      );
    }
  }
  return settled;
}

export interface FailureSweepHandle {
  stop(): Promise<void>;
}

// Runs sweepUnsettledFailures on a jittered timer until stopped. A pass never
// overlaps the previous one (the next is scheduled only once a pass settles),
// and stop() waits for an in-flight pass so shutdown does not cut a settlement
// off mid-way (the ledger would recover it after its lease, but needlessly late).
export function startFailureSweep(
  ctx: AppContext,
  { intervalMs = DEFAULT_SWEEP_INTERVAL_MS }: { intervalMs?: number } = {}
): FailureSweepHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    const delay = intervalMs / 2 + Math.random() * intervalMs;
    timer = setTimeout(() => {
      inFlight = sweepUnsettledFailures(ctx)
        .then(() => undefined)
        .catch((error: unknown) => {
          logger.warn({ err: error instanceof Error ? error.message : String(error) }, "terminal-failure sweep failed");
        })
        .finally(schedule);
    }, delay);
    timer.unref();
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    }
  };
}
