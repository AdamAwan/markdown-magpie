import { metrics, type BatchObservableResult, type ObservableGauge } from "@opentelemetry/api";
import { METER_NAME } from "./instruments.js";

// One point-in-time read of the queue's health, produced by the API's stats
// reader (one grouped SQL statement). Values are queue-wide, not per process:
// every API replica reports the same numbers, so dashboards and alerts combine
// replicas with max(), never sum() (see docs/observability.md O20).
export interface QueueStatsSnapshot {
  // One row per job type, zero-filled from the catalog so an idle type reports 0
  // rather than disappearing. Counts aggregate the type's provider/destination
  // fan-out queues.
  jobTypes: ReadonlyArray<{
    jobType: string;
    // Jobs a watcher could claim right now (created/retry, start_after reached).
    ready: number;
    // Seconds the longest-waiting ready job has been claimable; 0 when none.
    oldestReadyAgeSeconds: number;
    // Jobs parked in the type's `__dead_letter` twin queues (retries exhausted).
    deadLetter: number;
  }>;
  // Watchers seen within the active window, in total and per advertised
  // capability (zero-filled from the catalog's capabilities).
  watchers: {
    connected: number;
    byCapability: ReadonlyArray<{ capability: string; connected: number }>;
  };
  // One row per enabled schedule.
  schedules: ReadonlyArray<{
    key: string;
    jobType: string;
    // Seconds since the schedule's last completed job — or, if it has never
    // completed one, since the schedule was created.
    lastSuccessAgeSeconds: number;
  }>;
}

// Reads a fresh snapshot, or undefined when there is nothing to report (e.g.
// the database pool is shutting down). A throw is logged and skipped.
export type QueueStatsSource = () => Promise<QueueStatsSnapshot | undefined>;

export interface QueueMetricsOptions {
  // A collection inside this window of the last successful read reuses that
  // snapshot instead of querying again, so an aggressive
  // OTEL_METRIC_EXPORT_INTERVAL (or several metric readers) can never turn into
  // a query storm. Default 15 s.
  minRefreshIntervalMs?: number;
  // Called when the source throws; the collection then observes nothing.
  onError?: (error: unknown) => void;
  // Injectable clock for tests.
  now?: () => number;
}

const DEFAULT_MIN_REFRESH_MS = 15_000;

// Registers the queue-health observable gauges on the @magpie/telemetry meter,
// fed by ONE batch callback — so each metric collection runs `source` at most
// once for all of them. With telemetry disabled the global meter is a no-op that
// never invokes callbacks, so `source` (and its SQL) never runs at all.
//
// Returns a disposer that unregisters the callback.
export function registerQueueMetrics(source: QueueStatsSource, options: QueueMetricsOptions = {}): () => void {
  const meter = metrics.getMeter(METER_NAME);
  const minRefreshMs = options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_MS;
  const now = options.now ?? Date.now;

  const ready = meter.createObservableGauge("magpie.queue.ready", {
    unit: "{job}",
    description: "Jobs claimable right now (created/retry, start time reached), by job type"
  });
  const oldestReadyAge = meter.createObservableGauge("magpie.queue.oldest_ready_age", {
    unit: "s",
    description: "Seconds the longest-waiting claimable job has waited, by job type (0 when none)"
  });
  const deadLetter = meter.createObservableGauge("magpie.queue.dead_letter", {
    unit: "{job}",
    description: "Jobs parked in dead-letter queues after exhausting retries, by job type"
  });
  const watchersConnected = meter.createObservableGauge("magpie.watchers.connected", {
    unit: "{watcher}",
    description: "Watchers seen within the active window"
  });
  const watchersByCapability = meter.createObservableGauge("magpie.watchers.capability", {
    unit: "{watcher}",
    description: "Watchers seen within the active window advertising a capability, by capability"
  });
  const scheduleLastSuccessAge = meter.createObservableGauge("magpie.schedule.last_success_age", {
    unit: "s",
    description:
      "Seconds since an enabled schedule's last completed run (since its creation if it never completed), by schedule"
  });
  const observables: ObservableGauge[] = [
    ready,
    oldestReadyAge,
    deadLetter,
    watchersConnected,
    watchersByCapability,
    scheduleLastSuccessAge
  ];

  let cached: { at: number; snapshot: QueueStatsSnapshot } | undefined;
  let inFlight: Promise<QueueStatsSnapshot | undefined> | undefined;

  async function snapshot(): Promise<QueueStatsSnapshot | undefined> {
    if (cached && now() - cached.at < minRefreshMs) {
      return cached.snapshot;
    }
    // Overlapping collections share one read rather than each querying.
    inFlight ??= source()
      .then((fresh) => {
        if (fresh) cached = { at: now(), snapshot: fresh };
        return fresh;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  const callback = async (result: BatchObservableResult): Promise<void> => {
    let stats: QueueStatsSnapshot | undefined;
    try {
      stats = await snapshot();
    } catch (error) {
      options.onError?.(error);
      return;
    }
    if (!stats) return;
    for (const row of stats.jobTypes) {
      const attributes = { "job.type": row.jobType };
      result.observe(ready, row.ready, attributes);
      result.observe(oldestReadyAge, row.oldestReadyAgeSeconds, attributes);
      result.observe(deadLetter, row.deadLetter, attributes);
    }
    result.observe(watchersConnected, stats.watchers.connected);
    for (const row of stats.watchers.byCapability) {
      result.observe(watchersByCapability, row.connected, { "watcher.capability": row.capability });
    }
    for (const row of stats.schedules) {
      result.observe(scheduleLastSuccessAge, row.lastSuccessAgeSeconds, {
        "schedule.key": row.key,
        "job.type": row.jobType
      });
    }
  };

  meter.addBatchObservableCallback(callback, observables);
  return () => meter.removeBatchObservableCallback(callback, observables);
}
