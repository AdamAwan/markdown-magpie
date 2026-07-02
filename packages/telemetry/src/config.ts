// Telemetry configuration, resolved once from the environment at the app
// composition root (packages stay env-free otherwise).

export interface TelemetryConfig {
  /** Whether to start the OTel SDK. False keeps the whole stack a no-op. */
  enabled: boolean;
  /** Value for the `service.name` resource attribute (e.g. "api" / "watcher"). */
  serviceName: string;
}

// Telemetry is OFF by default and turns on only when an OTLP endpoint is
// configured — no endpoint means nothing to export. An explicit
// MAGPIE_TELEMETRY_ENABLED=false force-disables it even when an endpoint is set
// (an operator escape hatch); it cannot enable telemetry without an endpoint.
// All other OTEL_* tuning (headers, sampling, protocol) is read by the SDK itself.
export function resolveTelemetryConfig(env: NodeJS.ProcessEnv, defaultServiceName: string): TelemetryConfig {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const forceDisabled = env.MAGPIE_TELEMETRY_ENABLED?.trim().toLowerCase() === "false";
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || defaultServiceName;
  return { enabled: Boolean(endpoint) && !forceDisabled, serviceName };
}
