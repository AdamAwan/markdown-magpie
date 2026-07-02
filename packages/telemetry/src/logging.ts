import { trace } from "@opentelemetry/api";

// A pino mixin: merges the active span's ids onto every log line so logs can be
// joined to traces (and grepped by `trace_id`) in the backend. Returns nothing
// when no span is active — including when telemetry is disabled — so the default
// build's log shape is unchanged.
export function loggerTraceMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) {
    return {};
  }
  const spanContext = span.spanContext();
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}
