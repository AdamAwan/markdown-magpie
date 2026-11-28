import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics, type MetricAttributes } from "@opentelemetry/api";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { registerQueueMetrics, type QueueStatsSnapshot } from "./queue-metrics.js";

// A reader that only collects on demand, so each test decides exactly when a
// collection (and therefore the batch callback) happens.
class ManualReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

const snapshot: QueueStatsSnapshot = {
  jobTypes: [
    { jobType: "answer_question", ready: 3, oldestReadyAgeSeconds: 42, deadLetter: 1 },
    { jobType: "publish_proposal", ready: 0, oldestReadyAgeSeconds: 0, deadLetter: 0 }
  ],
  watchers: {
    connected: 2,
    byCapability: [
      { capability: "maintenance", connected: 2 },
      { capability: "github", connected: 0 }
    ]
  },
  schedules: [{ key: "task:correctness-patrol::docs", jobType: "correctness_patrol", lastSuccessAgeSeconds: 3600 }]
};

type Points = Map<string, Array<{ attributes: MetricAttributes; value: number }>>;

async function collect(reader: MetricReader): Promise<Points> {
  const { resourceMetrics } = await reader.collect();
  const byName: Points = new Map();
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      const points = metric.dataPoints.map((point) => ({
        attributes: point.attributes,
        value: typeof point.value === "number" ? point.value : point.value.count
      }));
      byName.set(metric.descriptor.name, [...(byName.get(metric.descriptor.name) ?? []), ...points]);
    }
  }
  return byName;
}

// Registered BEFORE any meter provider exists, so it binds to the API's no-op
// meter: telemetry-off must never run the stats SQL.
let noopReads = 0;
registerQueueMetrics(async () => {
  noopReads += 1;
  return snapshot;
});

// Each test gets its own provider: async-gauge storage remembers previously
// observed series, so a shared provider would leak earlier tests' points.
function freshReader(): ManualReader {
  metrics.disable();
  const reader = new ManualReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  return reader;
}

test("with telemetry off (no-op meter) the stats source is never read", async () => {
  await collect(freshReader());
  assert.equal(noopReads, 0);
});

test("one collection reads the source once and observes every gauge", async (t) => {
  const reader = freshReader();
  let reads = 0;
  const dispose = registerQueueMetrics(
    async () => {
      reads += 1;
      return snapshot;
    },
    { minRefreshIntervalMs: 0 }
  );
  t.after(dispose);

  const points = await collect(reader);
  assert.equal(reads, 1, "one batch callback feeds all six gauges");

  assert.deepEqual(points.get("magpie.queue.ready"), [
    { attributes: { "job.type": "answer_question" }, value: 3 },
    { attributes: { "job.type": "publish_proposal" }, value: 0 }
  ]);
  assert.deepEqual(points.get("magpie.queue.oldest_ready_age")?.[0], {
    attributes: { "job.type": "answer_question" },
    value: 42
  });
  assert.deepEqual(points.get("magpie.queue.dead_letter")?.[0], {
    attributes: { "job.type": "answer_question" },
    value: 1
  });
  assert.deepEqual(points.get("magpie.watchers.connected"), [{ attributes: {}, value: 2 }]);
  assert.deepEqual(points.get("magpie.watchers.capability"), [
    { attributes: { "watcher.capability": "maintenance" }, value: 2 },
    { attributes: { "watcher.capability": "github" }, value: 0 }
  ]);
  assert.deepEqual(points.get("magpie.schedule.last_success_age"), [
    { attributes: { "schedule.key": "task:correctness-patrol::docs", "job.type": "correctness_patrol" }, value: 3600 }
  ]);
});

test("collections inside the refresh window reuse the last snapshot", async (t) => {
  const reader = freshReader();
  let clock = 1_000_000;
  let reads = 0;
  const dispose = registerQueueMetrics(
    async () => {
      reads += 1;
      return snapshot;
    },
    { minRefreshIntervalMs: 15_000, now: () => clock }
  );
  t.after(dispose);

  await collect(reader);
  clock += 5_000;
  await collect(reader);
  assert.equal(reads, 1, "a second collection 5s later is served from cache");
  clock += 15_000;
  await collect(reader);
  assert.equal(reads, 2, "past the window the source is read again");
});

test("a failing source reports the error and observes nothing", async (t) => {
  const reader = freshReader();
  const errors: unknown[] = [];
  const dispose = registerQueueMetrics(
    async () => {
      throw new Error("database unavailable");
    },
    { minRefreshIntervalMs: 0, onError: (error) => errors.push(error) }
  );
  t.after(dispose);

  const points = await collect(reader);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /database unavailable/);
  assert.ok([...points.values()].every((series) => series.length === 0));
});

test("an undefined snapshot (e.g. pool closed) observes nothing; dispose stops reads", async () => {
  const reader = freshReader();
  let reads = 0;
  const dispose = registerQueueMetrics(
    async () => {
      reads += 1;
      return undefined;
    },
    { minRefreshIntervalMs: 0 }
  );
  const points = await collect(reader);
  assert.equal(reads, 1);
  assert.ok([...points.values()].every((series) => series.length === 0));

  dispose();
  await collect(reader);
  assert.equal(reads, 1, "a disposed registration is never read again");
});
