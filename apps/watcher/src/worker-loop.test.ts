import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import type { JobCapability, JobError, JobType, JobView } from "@magpie/jobs";
import { createLogger } from "@magpie/logger";
import type { JobRunner } from "./runners/types.js";
import type { ClaimedJob, HeartbeatReply, WorkerLoopApiClient } from "./http-client.js";
import { WorkerLoop } from "./worker-loop.js";

function fakeJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "job-1",
    type: "answer_question",
    queueName: "answer_question__openai_compatible",
    deadLetter: false,
    state: "active",
    input: {},
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300,
    heartbeatSeconds: 120,
    ...overrides
  };
}

interface FakeApiOptions {
  jobs: (JobView | undefined)[];
  // Heartbeat replies, consumed in order; defaults to held and not cancelled.
  // `true` is shorthand for a cancelled reply.
  heartbeats?: (boolean | HeartbeatReply)[];
}

class FakeApiClient implements WorkerLoopApiClient {
  claims: { workerName: string; capabilities: JobCapability[] }[] = [];
  completed: { id: string; output: unknown; usage?: unknown; identity?: unknown }[] = [];
  failed: { id: string; error: JobError }[] = [];
  // The attempt (claimed retryCount) every lifecycle call carried, in order.
  attempts: { call: "heartbeat" | "complete" | "fail"; attempt: number }[] = [];
  heartbeatCalls = 0;
  private readonly jobs: (JobView | undefined)[];
  private readonly heartbeats: (boolean | HeartbeatReply)[];

  constructor(options: FakeApiOptions) {
    this.jobs = [...options.jobs];
    this.heartbeats = [...(options.heartbeats ?? [])];
  }

  async claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined> {
    this.claims.push({ workerName, capabilities });
    return this.jobs.length ? this.jobs.shift() : undefined;
  }

  async heartbeat(job: ClaimedJob): Promise<HeartbeatReply> {
    this.heartbeatCalls += 1;
    this.attempts.push({ call: "heartbeat", attempt: job.retryCount });
    const next = this.heartbeats.shift();
    if (next === undefined || next === false) return { cancelled: false, active: true };
    return next === true ? { cancelled: true, active: false } : next;
  }

  async complete(job: ClaimedJob, output: unknown, usage?: unknown, identity?: unknown): Promise<void> {
    this.attempts.push({ call: "complete", attempt: job.retryCount });
    this.completed.push({
      id: job.id,
      output,
      ...(usage !== undefined ? { usage } : {}),
      ...(identity !== undefined ? { identity } : {})
    });
  }

  async fail(job: ClaimedJob, error: JobError): Promise<void> {
    this.attempts.push({ call: "fail", attempt: job.retryCount });
    this.failed.push({ id: job.id, error });
  }

  released: string[] = [];
  releaseError: Error | undefined;

  async release(job: ClaimedJob): Promise<void> {
    if (this.releaseError) throw this.releaseError;
    this.released.push(job.id);
  }
}

class FakeRunner implements JobRunner {
  readonly capability: JobCapability = "openai-compatible";
  // Optional so the default fake mirrors a non-AI runner (no identity stamped);
  // the aiIdentity test opts in explicitly.
  aiIdentity?: { provider: string; model?: string };
  ran = 0;
  lastSignal: AbortSignal | undefined;

  constructor(
    private readonly behaviour: (
      signal: AbortSignal,
      onUsage?: (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) => void
    ) => Promise<unknown>
  ) {}

  supports(type: JobType): boolean {
    return type === "answer_question";
  }

  async run(
    _job: JobView,
    signal: AbortSignal,
    onUsage?: (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) => void
  ): Promise<unknown> {
    this.ran += 1;
    this.lastSignal = signal;
    return this.behaviour(signal, onUsage);
  }
}

function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  return {
    logger: createLogger({ level: "debug", destination: stream }),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
  };
}

const silentLogger = createLogger({ level: "silent" });

const CAPS: JobCapability[] = ["openai-compatible", "maintenance"];

describe("WorkerLoop", () => {
  it("sends the watcher's capabilities on claim", async () => {
    const api = new FakeApiClient({ jobs: [undefined] });
    const loop = new WorkerLoop(api, [new FakeRunner(async () => ({}))], CAPS, "w1", silentLogger, {
      pollIntervalMs: 1
    });
    // No job available — claim once, then stop.
    await loop.tick();
    assert.equal(api.claims.length, 1);
    assert.deepEqual(api.claims[0], { workerName: "w1", capabilities: CAPS });
  });

  it("completes a successful job exactly once and never fails it", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    const runner = new FakeRunner(async () => ({ answer: "ok" }));
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();
    assert.equal(runner.ran, 1);
    assert.equal(api.completed.length, 1);
    assert.deepEqual(api.completed[0], { id: "job-1", output: { answer: "ok" } });
    assert.equal(api.failed.length, 0);
  });

  it("sums runner-reported usage and attaches it to the completion (#241)", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    const runner = new FakeRunner(async (_signal, onUsage) => {
      onUsage?.({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
      // No totalTokens on this reading: its input+output (45) still counts
      // toward the summed total, so mixed readings never understate spend.
      onUsage?.({ inputTokens: 40, outputTokens: 5 });
      return { answer: "ok" };
    });
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();
    assert.deepEqual(api.completed[0], {
      id: "job-1",
      output: { answer: "ok" },
      usage: { inputTokens: 140, outputTokens: 25, totalTokens: 165 }
    });
  });

  it("stamps the runner's aiIdentity on the completion for cost attribution", async () => {
    // The identity rides the completion even when no usage was reported (the CLI
    // case): it marks which model ran unmetered rather than implying it was free.
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    const runner = new FakeRunner(async () => ({ answer: "ok" }));
    runner.aiIdentity = { provider: "openai-compatible", model: "gpt-test" };
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();
    assert.deepEqual(api.completed[0], {
      id: "job-1",
      output: { answer: "ok" },
      identity: { provider: "openai-compatible", model: "gpt-test" }
    });
  });

  it("fails a job exactly once when the runner throws", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    const runner = new FakeRunner(async () => {
      throw new Error("boom");
    });
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();
    assert.equal(api.completed.length, 0);
    assert.equal(api.failed.length, 1);
    assert.equal(api.failed[0].id, "job-1");
    assert.match(api.failed[0].error.message, /boom/);
    assert.equal(api.failed[0].error.executor, "w1");
  });

  it("aborts the runner when a heartbeat reports the job cancelled", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob({ heartbeatSeconds: 0.02 })], heartbeats: [true] });
    let abortedSignal: AbortSignal | undefined;
    const runner = new FakeRunner(
      (signal) =>
        new Promise((_resolve, reject) => {
          abortedSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
        })
    );
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();
    assert.ok(abortedSignal?.aborted, "runner's signal should be aborted");
    assert.ok(api.heartbeatCalls >= 1, "heartbeat should have been polled");
    // A cancelled job reaches a terminal state server-side, so the loop neither
    // completes nor double-fails it here beyond surfacing the abort.
    assert.equal(api.completed.length, 0);
  });

  it("aborts the runner and reports nothing when a heartbeat says the job is no longer held (J60)", async () => {
    // The claim lapsed (the job was re-queued or re-claimed by another watcher):
    // the run is aborted and neither completed nor failed from here.
    const api = new FakeApiClient({
      jobs: [fakeJob({ heartbeatSeconds: 0.04, retryCount: 2 })],
      heartbeats: [{ cancelled: false, active: false }]
    });
    let abortedSignal: AbortSignal | undefined;
    const runner = new FakeRunner(
      (signal) =>
        new Promise((_resolve, reject) => {
          abortedSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
        })
    );
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();
    assert.ok(abortedSignal?.aborted, "runner's signal should be aborted");
    assert.equal(api.completed.length, 0);
    assert.equal(api.failed.length, 0);
    assert.deepEqual(api.attempts[0], { call: "heartbeat", attempt: 2 }, "the heartbeat names the claimed attempt");
  });

  it("fences completion and failure to the claimed attempt (J60)", async () => {
    const completing = new FakeApiClient({ jobs: [fakeJob({ retryCount: 1 })] });
    await new WorkerLoop(completing, [new FakeRunner(async () => ({}))], CAPS, "w1", silentLogger, {
      pollIntervalMs: 1
    }).tick();
    assert.deepEqual(completing.attempts, [{ call: "complete", attempt: 1 }]);

    const failing = new FakeApiClient({ jobs: [fakeJob({ retryCount: 3 })] });
    const thrower = new FakeRunner(async () => {
      throw new Error("boom");
    });
    await new WorkerLoop(failing, [thrower], CAPS, "w1", silentLogger, { pollIntervalMs: 1 }).tick();
    assert.deepEqual(failing.attempts, [{ call: "fail", attempt: 3 }]);
  });

  it("heartbeats at a quarter of the job's heartbeat window", async () => {
    // heartbeatSeconds 0.08 => 20ms cadence; ~70ms of work should fire ~3 beats.
    const api = new FakeApiClient({ jobs: [fakeJob({ heartbeatSeconds: 0.08 })] });
    const runner = new FakeRunner(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return {};
    });
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();
    assert.ok(api.heartbeatCalls >= 2, `expected multiple heartbeats, got ${api.heartbeatCalls}`);
  });

  it("fails a claimed job when no runner supports its type", async () => {
    // The broker can advertise a capability (e.g. maintenance) that has no runner
    // registered yet; a job of that type must be failed safely, not silently dropped.
    const api = new FakeApiClient({ jobs: [fakeJob({ type: "refresh_flow_snapshot" })] });
    const runner = new FakeRunner(async () => ({})); // only supports answer_question
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();
    assert.equal(runner.ran, 0, "no runner should have executed");
    assert.equal(api.completed.length, 0);
    assert.equal(api.failed.length, 1);
    assert.equal(api.failed[0].id, "job-1");
    assert.match(api.failed[0].error.message, /No runner supports/);
    assert.equal(api.failed[0].error.executor, "w1");
  });

  it("logs and keeps polling when a claim throws instead of crashing", async () => {
    // Reproduces the 401 crash-loop: the first claim rejects (e.g. unauthorized
    // before the service credential is configured). run() must swallow it, back
    // off, and retry on the next cycle rather than letting the rejection escape
    // and kill the process.
    let calls = 0;
    const api: WorkerLoopApiClient = {
      async claim() {
        calls += 1;
        if (calls === 1) {
          throw new Error("POST /api/jobs/claim failed with 401: unauthorized");
        }
        // Subsequent polls report no work; the loop is stopped externally below.
        return undefined;
      },
      async heartbeat() {
        return { cancelled: false, active: true };
      },
      async complete() {},
      async fail() {},
      async release() {}
    };
    const cap = captureLogger();
    const loop = new WorkerLoop(api, [], CAPS, "w1", cap.logger, { pollIntervalMs: 1 });

    const running = loop.run();
    // Wait until the loop has retried past the throwing first claim, then stop
    // it. run() must resolve, not reject, despite that first claim throwing.
    while (calls < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await loop.stop();
    await running;

    assert.ok(calls >= 2, "loop should have retried after the claim error");
    assert.ok(
      cap.lines().some((line) => /401/.test(JSON.stringify(line))),
      "the claim failure should have been logged"
    );
  });

  it("aborts in-flight work on shutdown", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    let seenSignal: AbortSignal | undefined;
    const runner = new FakeRunner(
      (signal) =>
        new Promise((resolve) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => resolve({}), { once: true });
        })
    );
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    const ticking = loop.tick();
    // Let the runner start, then stop the loop.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await loop.stop();
    await ticking;
    assert.ok(seenSignal?.aborted, "shutdown should abort the active runner's signal");
    // Even a runner that resolves on abort is released, never completed: its
    // wound-down result cannot be told apart from a finished one (J53).
    assert.deepEqual(api.released, ["job-1"]);
    assert.equal(api.completed.length, 0);
    assert.equal(api.failed.length, 0);
  });

  it("releases (never fails) a job whose runner rejects on shutdown (J53)", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    const runner = new FakeRunner(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
        })
    );
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    const running = loop.run();
    while (runner.ran === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await loop.stop();
    await running;
    assert.deepEqual(api.released, ["job-1"]);
    assert.equal(api.failed.length, 0, "an interrupted job must not burn a retry");
    assert.equal(api.completed.length, 0);
  });

  it("stops waiting for a runner that ignores its abort and releases after the grace (J53)", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    const runner = new FakeRunner(() => new Promise(() => {})); // never settles
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1, shutdownGraceMs: 10 });
    const ticking = loop.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await loop.stop();
    await ticking;
    assert.deepEqual(api.released, ["job-1"]);
  });

  it("releases a job claimed after stop() without running it", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    const runner = new FakeRunner(async () => ({ answer: "ok" }));
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.stop();
    await loop.tick();
    assert.equal(runner.ran, 0);
    assert.deepEqual(api.released, ["job-1"]);
  });

  it("does not release a job the server cancelled, even if shutdown follows", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob({ heartbeatSeconds: 0.02 })], heartbeats: [true] });
    const runner = new FakeRunner(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => setTimeout(() => reject(new Error("aborted")), 20), { once: true });
        })
    );
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    const ticking = loop.tick();
    while (!runner.lastSignal?.aborted) await new Promise((resolve) => setTimeout(resolve, 2));
    await loop.stop();
    await ticking;
    assert.deepEqual(api.released, []);
    assert.equal(api.failed.length, 0);
  });

  it("still exits cleanly when the shutdown release itself fails", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    api.releaseError = new Error("ECONNREFUSED");
    const runner = new FakeRunner(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );
    const cap = captureLogger();
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", cap.logger, { pollIntervalMs: 1 });
    const ticking = loop.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await loop.stop();
    await ticking;
    assert.equal(api.failed.length, 0);
    assert.ok(cap.lines().some((line) => /could not release/.test(String(line["msg"]))));
  });

  it("ticks liveness from the job heartbeat, not only from the poll loop (J55)", async () => {
    // heartbeatSeconds 0.04 => a 20ms heartbeat; the job runs ~90ms, so the poll
    // loop ticks only once at the end while the heartbeat ticks throughout.
    const api = new FakeApiClient({ jobs: [fakeJob({ heartbeatSeconds: 0.04 })] });
    const runner = new FakeRunner(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return {};
    });
    let ticks = 0;
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, {
      pollIntervalMs: 1,
      onTick: () => {
        ticks += 1;
      }
    });
    await loop.tick(); // tick() is one cycle WITHOUT run()'s per-iteration onTick
    assert.ok(ticks >= 2, `expected heartbeat-driven liveness ticks during the job, got ${ticks}`);
  });

  it("logs a structured completion line on success", async () => {
    const api = new FakeApiClient({ jobs: [fakeJob()] });
    const runner = new FakeRunner(async () => ({ answer: "ok" }));
    const cap = captureLogger();
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", cap.logger, { pollIntervalMs: 1 });
    await loop.tick();

    const done = cap.lines().find((l) => l["outcome"] === "completed");
    assert.ok(done, "expected a completion log");
    assert.equal(typeof done["jobId"], "string");
    assert.equal(typeof done["durationMs"], "number");
  });

  it("runs a job carrying trace context without error (span parenting is a no-op when telemetry is off)", async () => {
    // With telemetry disabled the tracer is a no-op; a job whose envelope carries a
    // traceparent must still run and complete normally.
    const api = new FakeApiClient({ jobs: [fakeJob({ traceContext: { traceparent: "00-abc-def-01" } })] });
    const runner = new FakeRunner(async () => ({ answer: "ok" }));
    const loop = new WorkerLoop(api, [runner], CAPS, "w1", silentLogger, { pollIntervalMs: 1 });
    await loop.tick();

    assert.equal(api.completed.length, 1);
    assert.equal(api.failed.length, 0);
  });
});
