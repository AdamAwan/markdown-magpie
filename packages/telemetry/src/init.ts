import type { Logger } from "@magpie/logger";
import type { TelemetryConfig } from "./config.js";

export interface TelemetryHandle {
  /** Whether the OTel SDK was actually started. */
  readonly enabled: boolean;
  /** Flushes and stops the SDK. Safe (no-op) when telemetry was never started. */
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: TelemetryHandle = {
  enabled: false,
  shutdown: async () => {}
};

// Starts the OpenTelemetry SDK when `config.enabled`, wiring OTLP trace + metric
// exporters and HTTP/undici/pg auto-instrumentation, and returns a handle whose
// shutdown() flushes on exit. When disabled it returns immediately WITHOUT
// importing any of the SDK's dependency weight — the heavy modules are behind the
// dynamic import below, so the default path loads only the lightweight OTel API.
//
// Telemetry must never stop the app from running: any failure here is logged and
// downgraded to disabled rather than thrown. Call once, first, at the composition
// root — before any HTTP/pg client is created, so the auto-instrumentation can
// patch them.
export async function initTelemetry(config: TelemetryConfig, logger: Logger): Promise<TelemetryHandle> {
  if (!config.enabled) {
    return NOOP_HANDLE;
  }
  try {
    const [
      { NodeSDK },
      { resourceFromAttributes },
      { ATTR_SERVICE_NAME },
      { OTLPTraceExporter },
      { OTLPMetricExporter },
      { PeriodicExportingMetricReader },
      { HttpInstrumentation },
      { UndiciInstrumentation },
      { PgInstrumentation }
    ] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-pg")
    ]);

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
      // Exporters read their endpoint/headers from the standard OTEL_* env.
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
      instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation(), new PgInstrumentation()]
    });
    sdk.start();
    logger.info({ serviceName: config.serviceName }, "OpenTelemetry started");

    return {
      enabled: true,
      shutdown: async () => {
        try {
          await sdk.shutdown();
        } catch (error) {
          logger.warn({ err: errorMessage(error) }, "OpenTelemetry shutdown failed");
        }
      }
    };
  } catch (error) {
    logger.warn({ err: errorMessage(error) }, "OpenTelemetry init failed; continuing without telemetry");
    return NOOP_HANDLE;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
