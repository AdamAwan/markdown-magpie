import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatProvider, ChatRequest, ChatResponse } from "@magpie/core";
import type { JobRepairContext, JobView } from "@magpie/jobs";
import { REPAIR_OUTPUT } from "@magpie/prompts";
import type { WatcherApi } from "../http-client.js";
import { ChatRunner } from "./chat.js";

function job(type: JobView["type"], input: unknown, repair?: JobRepairContext): JobView {
  return {
    id: "j",
    type,
    queueName: type,
    deadLetter: false,
    state: "active",
    input,
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300,
    ...(repair ? { repair } : {})
  };
}

class RecordingChatProvider implements ChatProvider {
  requests: ChatRequest[] = [];
  constructor(private readonly reply: string) {}
  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    return { content: this.reply };
  }
}

// A WatcherApi whose retrieve() throws — proves the repair path runs NO retrieval.
function noRetrievalApi(): WatcherApi {
  return {
    claim: async () => undefined,
    heartbeat: async () => ({ cancelled: false }),
    complete: async () => undefined,
    fail: async () => undefined,
    retrieve: async () => {
      throw new Error("retrieve must not be called on the repair path");
    },
    routeByEmbedding: async () => ({ status: "abstain" }),
    proposalExecutionContext: async () => ({ proposal: {}, repository: {} }),
    reconcileGaps: async () => ({ ok: true }),
    verifyClosure: async () => ({ proposalId: "p", closureStatus: "verified_closed", perQuestion: [] }),
    runSourceSync: async () => ({ runIds: [] }),
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
    runImprovePatrol: async () => ({ runId: "run-1", selectedCount: 0, enqueuedCount: 0 }),
    runSeedBootstrap: async () => ({ enqueued: false, reason: "no_sources" }),
    listOpenPullRequests: async () => [],
    sourceMapEntries: async () => []
  };
}

test("a job with repair context runs the single-shot reshape and returns corrected output", async () => {
  // summarize_gap output contract: { summary, priority, rationale }. The prior
  // output was missing `rationale`; the repair reply supplies the whole object.
  const chat = new RecordingChatProvider(JSON.stringify({ summary: "s", priority: 1, rationale: "fixed" }));
  const runner = new ChatRunner("openai-compatible", chat, noRetrievalApi());
  const repair: JobRepairContext = {
    attempt: 1,
    priorOutput: { summary: "s", priority: 1 },
    issues: [{ path: "rationale", message: "Required" }]
  };

  const output = await runner.run(
    job("summarize_gap", { provider: "openai-compatible" }, repair),
    new AbortController().signal
  );

  assert.deepEqual(output, { summary: "s", priority: 1, rationale: "fixed" });
  // Exactly one model call, carrying the REPAIR_OUTPUT system prompt and the
  // prior output + the contract violation in the user message.
  assert.equal(chat.requests.length, 1);
  assert.equal(chat.requests[0].system, REPAIR_OUTPUT.instructions);
  assert.match(chat.requests[0].messages[0].content, /rationale: Required/);
});

test("a job without repair context runs the normal generative path", async () => {
  // No repair context → the generic generative path parses the model's JSON as
  // the summarize_gap output directly (no reshape prompt).
  const chat = new RecordingChatProvider(JSON.stringify({ summary: "s", priority: 2, rationale: "normal" }));
  const runner = new ChatRunner("openai-compatible", chat, noRetrievalApi());

  const output = await runner.run(
    job("summarize_gap", { provider: "openai-compatible" }),
    new AbortController().signal
  );

  assert.deepEqual(output, { summary: "s", priority: 2, rationale: "normal" });
  assert.equal(chat.requests.length, 1);
  assert.notEqual(chat.requests[0].system, REPAIR_OUTPUT.instructions);
});
