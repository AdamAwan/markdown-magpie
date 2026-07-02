import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics";
import { recordJobDuration, recordJobFinished, resetInstrumentsForTest } from "./instruments.js";

// Register a real (in-memory) meter provider before the instruments are first
// created, then reset the module cache so it binds to this provider.
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
const meterProvider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(meterProvider);
resetInstrumentsForTest();

async function collect(): Promise<Map<string, number>> {
  await meterProvider.forceFlush();
  const byName = new Map<string, number>();
  for (const resourceMetric of exporter.getMetrics()) {
    for (const scope of resourceMetric.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of metric.dataPoints) {
          const value = typeof point.value === "number" ? point.value : point.value.count;
          byName.set(metric.descriptor.name, (byName.get(metric.descriptor.name) ?? 0) + value);
        }
      }
    }
  }
  return byName;
}

test("records job finished counts and durations", async () => {
  recordJobFinished("answer_question", "completed");
  recordJobFinished("answer_question", "failed");
  recordJobDuration("answer_question", "completed", 120);

  const metricsByName = await collect();
  assert.equal(metricsByName.get("magpie.jobs.finished"), 2);
  // The histogram data point exposes a count of recorded observations.
  assert.equal(metricsByName.get("magpie.jobs.duration"), 1);
});
