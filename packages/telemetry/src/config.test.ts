import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTelemetryConfig } from "./config.js";

test("telemetry is disabled when no OTLP endpoint is set", () => {
  const config = resolveTelemetryConfig({}, "api");
  assert.equal(config.enabled, false);
  assert.equal(config.serviceName, "api");
});

test("telemetry is enabled when an OTLP endpoint is set", () => {
  const config = resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }, "watcher");
  assert.equal(config.enabled, true);
  assert.equal(config.serviceName, "watcher");
});

test("MAGPIE_TELEMETRY_ENABLED=false force-disables even with an endpoint", () => {
  const config = resolveTelemetryConfig(
    { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", MAGPIE_TELEMETRY_ENABLED: "false" },
    "api"
  );
  assert.equal(config.enabled, false);
});

test("MAGPIE_TELEMETRY_ENABLED=true cannot enable telemetry without an endpoint", () => {
  const config = resolveTelemetryConfig({ MAGPIE_TELEMETRY_ENABLED: "true" }, "api");
  assert.equal(config.enabled, false);
});

test("OTEL_SERVICE_NAME overrides the default service name", () => {
  const config = resolveTelemetryConfig({ OTEL_SERVICE_NAME: "custom" }, "api");
  assert.equal(config.serviceName, "custom");
});
