import assert from "node:assert/strict";
import { test } from "node:test";
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { injectTraceContext, recordException, runJobSpan } from "./tracing.js";
import { loggerTraceMixin } from "./logging.js";

// Register a real (in-memory) tracer provider, a context manager, and a W3C
// propagator once so the helpers exercise genuine OTel behavior rather than the
// API's no-op defaults. In production NodeSDK registers the context manager and
// propagator itself; the tracer/propagator without a context manager cannot
// propagate the active span, so it must be set up here too.
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
trace.setGlobalTracerProvider(tracerProvider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const tracer = trace.getTracer("test");

test("loggerTraceMixin is empty outside a span and carries ids inside one", async () => {
  assert.deepEqual(loggerTraceMixin(), {});

  await tracer.startActiveSpan("outer", async (span) => {
    const mixin = loggerTraceMixin();
    assert.equal(mixin.trace_id, span.spanContext().traceId);
    assert.equal(mixin.span_id, span.spanContext().spanId);
    span.end();
  });
});

test("inject then runJobSpan continues the same trace across a carrier", async () => {
  spanExporter.reset();
  let parentTraceId = "";

  // Simulate the enqueue side: capture the carrier within an active span.
  const carrier = await tracer.startActiveSpan("enqueue", async (span) => {
    parentTraceId = span.spanContext().traceId;
    const c = injectTraceContext();
    span.end();
    return c;
  });
  assert.ok(carrier.traceparent, "carrier should hold a W3C traceparent");

  // Simulate the execute side: a fresh context, parented only via the carrier.
  const jobTraceId = await context.with(context.active(), () =>
    runJobSpan("job.execute", { "job.type": "answer_question" }, carrier, async (span) => {
      return span.spanContext().traceId;
    })
  );

  assert.equal(jobTraceId, parentTraceId, "the job span joins the enqueueing trace");
});

test("runJobSpan marks the span failed and records the exception when fn throws", async () => {
  spanExporter.reset();

  await assert.rejects(
    runJobSpan("job.execute", {}, undefined, async () => {
      throw new Error("kaboom");
    }),
    /kaboom/
  );

  const [span] = spanExporter.getFinishedSpans();
  assert.ok(span, "the job span should have ended");
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.ok(span.events.some((event) => event.name === "exception"), "an exception event should be recorded");
});

test("recordException is a safe no-op when no span is active", () => {
  // Outside any span this must not throw.
  assert.doesNotThrow(() => recordException(new Error("ignored")));
});
