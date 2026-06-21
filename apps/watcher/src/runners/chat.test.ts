import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatProvider, ChatRequest, ChatResponse } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import type { RetrievedSection, WatcherApi } from "../http-client.js";
import { ChatRunner } from "./chat.js";

function job(type: JobView["type"], input: unknown): JobView {
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
    expireInSeconds: 300
  };
}

class FakeChatProvider implements ChatProvider {
  requests: ChatRequest[] = [];
  constructor(private readonly reply: (request: ChatRequest) => string) {}
  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    return { content: this.reply(request) };
  }
}

const SECTIONS: RetrievedSection[] = [
  {
    sectionId: "doc-1#deploy",
    documentId: "doc-1",
    anchor: "deploy",
    path: "ops/deploy.md",
    heading: "Deploy",
    content: "Run the deploy script."
  }
];

function fakeApi(overrides: Partial<WatcherApi> = {}): WatcherApi {
  return {
    claim: async () => undefined,
    heartbeat: async () => ({ cancelled: false }),
    complete: async () => undefined,
    fail: async () => undefined,
    retrieve: async () => SECTIONS,
    proposalExecutionContext: async () => ({ proposal: {}, repository: {} }),
    crunchExecutionContext: async () => ({ run: {}, repository: {} }),
    ...overrides
  };
}

describe("ChatRunner", () => {
  it("declares its provider capability and supports AI job types", () => {
    const runner = new ChatRunner("openai-compatible", new FakeChatProvider(() => "{}"), fakeApi());
    assert.equal(runner.capability, "openai-compatible");
    assert.ok(runner.supports("answer_question"));
    assert.ok(runner.supports("summarize_gap"));
    assert.ok(!runner.supports("publish_proposal"));
  });

  it("routes, retrieves, answers, and derives citations for answer_question", async () => {
    let retrievedFlow: string | undefined = "unset";
    const api = fakeApi({
      retrieve: async (_question, flowId) => {
        retrievedFlow = flowId;
        return SECTIONS;
      }
    });
    const chat = new FakeChatProvider((request) => {
      // The routing call asks for a flow id; the answer call asks the question.
      if (request.system.includes("flow")) {
        return JSON.stringify({ flowId: "flow-b", confidence: "high" });
      }
      return JSON.stringify({ answer: "Run the deploy script.", confidence: "high", isKnowledgeGap: false });
    });
    const runner = new ChatRunner("openai-compatible", chat, api);
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I deploy?",
        flows: [
          { id: "flow-a", name: "Alpha" },
          { id: "flow-b", name: "Beta" }
        ],
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as { citations: unknown[]; flowId?: string };

    assert.equal(retrievedFlow, "flow-b", "should retrieve with the routed flow id");
    assert.equal(output.flowId, "flow-b");
    assert.equal(output.citations.length, 1);
  });

  it("runs buildPrompt -> chat -> parseJobOutput for non-answer jobs", async () => {
    const chat = new FakeChatProvider(() => JSON.stringify({ summary: "s", priority: 1, rationale: "r" }));
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = await runner.run(job("summarize_gap", { questions: ["q"], citedSections: [] }), new AbortController().signal);
    assert.deepEqual(output, { summary: "s", priority: 1, rationale: "r" });
  });

  it("passes the abort signal through to the chat provider", async () => {
    const chat = new FakeChatProvider(() => JSON.stringify({ summary: "s", priority: 1, rationale: "r" }));
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const controller = new AbortController();
    await runner.run(job("summarize_gap", { questions: ["q"], citedSections: [] }), controller.signal);
    assert.equal(chat.requests.at(-1)?.signal, controller.signal);
  });
});
