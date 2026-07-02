import { context, propagation, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

// The instrumentation-scope name for spans this package starts directly. Kept
// stable so backends group Magpie's own spans under one scope.
const TRACER_NAME = "@magpie/telemetry";

// A W3C trace-context carrier (traceparent/tracestate) — the shape OTel's text-map
// propagator injects into and extracts from. Used to carry trace context across
// the pg-boss queue boundary, which OTel does not propagate automatically.
export type TraceCarrier = Record<string, string>;

// Serializes the active trace context into a carrier for storage on a job
// envelope. When telemetry is disabled the global propagator is a no-op, so this
// returns an empty carrier — harmless.
export function injectTraceContext(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

// Records an error on the active span and marks the span failed. A no-op when no
// span is active (i.e. telemetry disabled, or called outside a span), so call
// sites never need an `if (enabled)` guard.
export function recordException(error: unknown, attributes?: Attributes): void {
  const span = trace.getActiveSpan();
  if (!span) {
    return;
  }
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  if (attributes) {
    span.setAttributes(attributes);
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

// Runs `fn` inside a new active span named `name`, parented on the trace context
// in `carrier` (the enqueueing request's context, carried across the queue). The
// span is ended in all cases and marked failed if `fn` throws. When telemetry is
// disabled the tracer is a no-op and `fn` simply runs. This is how a claimed job's
// execution — and the API callbacks it makes — join the originating request's trace.
export async function runJobSpan<T>(
  name: string,
  attributes: Attributes,
  carrier: TraceCarrier | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const parent = carrier ? propagation.extract(context.active(), carrier) : context.active();
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
