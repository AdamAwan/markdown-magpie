import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

// The meter (instrumentation-scope) name for Magpie's own metrics.
const METER_NAME = "@magpie/telemetry";

interface Instruments {
  jobsFinished: Counter;
  jobDuration: Histogram;
}

// Instruments are created lazily on first use and cached. The composition root
// starts the SDK before any job runs, so the first call here binds to the real
// meter; when telemetry is disabled the global meter is a no-op and every record
// below does nothing.
let cached: Instruments | undefined;

function instruments(): Instruments {
  if (!cached) {
    const meter = metrics.getMeter(METER_NAME);
    cached = {
      jobsFinished: meter.createCounter("magpie.jobs.finished", {
        description: "Count of jobs that reached a terminal state, by type and outcome"
      }),
      jobDuration: meter.createHistogram("magpie.jobs.duration", {
        unit: "ms",
        description: "Job execution wall-clock duration, by type and outcome"
      })
    };
  }
  return cached;
}

// Records one terminal job transition (completed | failed | cancelled).
export function recordJobFinished(type: string, outcome: string): void {
  instruments().jobsFinished.add(1, { "job.type": type, "job.outcome": outcome });
}

// Records a job's execution duration in milliseconds.
export function recordJobDuration(type: string, outcome: string, durationMs: number): void {
  instruments().jobDuration.record(durationMs, { "job.type": type, "job.outcome": outcome });
}

// Test-only: drops the cached instruments so a test that registers a fresh global
// meter provider isn't shadowed by instruments bound to an earlier one.
export function resetInstrumentsForTest(): void {
  cached = undefined;
}
