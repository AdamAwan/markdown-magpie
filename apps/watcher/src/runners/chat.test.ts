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
    reconcileGaps: async () => ({ ok: true }),
    runSourceSync: async () => ({ runIds: [] }),
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
    runImprovePatrol: async () => ({ runId: "run-1", selectedCount: 0, enqueuedCount: 0 }),
    listOpenPullRequests: async () => [],
    ...overrides
  };
}

describe("ChatRunner", () => {
  it("declares its provider capability and supports AI job types", () => {
    const runner = new ChatRunner("openai-compatible", new FakeChatProvider(() => "{}"), fakeApi());
    assert.equal(runner.capability, "openai-compatible");
    assert.ok(runner.supports("answer_question"));
    assert.ok(runner.supports("summarize_gap"));
    assert.ok(runner.supports("sync_source_changes_generate_plan"));
    assert.ok(runner.supports("verify_document"));
    assert.ok(runner.supports("fold_markdown_proposal"));
    assert.ok(!runner.supports("publish_proposal"));
  });

  it("runs buildPrompt -> chat -> parseJobOutput for sync_source_changes_generate_plan", async () => {
    // The source-sync plan job produces a MaintenancePlan; the watcher must claim it
    // (it is a provider AI job) and validate the model's plan against the contract.
    const plan = { summary: "Doc updated", operations: [], rationale: "threshold moved" };
    const chat = new FakeChatProvider(() => JSON.stringify(plan));
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = await runner.run(
      job("sync_source_changes_generate_plan", {
        provider: "openai-compatible",
        sourceId: "src-1",
        sourceName: "Pricing rules",
        fromSha: "aaa",
        toSha: "bbb",
        changes: [{ path: "pricing.ts", status: "modified", diff: "- 10\n+ 20" }],
        candidateDocuments: [{ path: "kb/pricing.md", content: "The threshold is 10." }],
        expectedOutput: "maintenance_plan"
      }),
      new AbortController().signal
    );
    assert.deepEqual(output, plan);
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

  it("derives reconcile_gap_clusters confirmed flags from the critic, not from propose", async () => {
    // The propose call returns one merge and one split (both unconfirmed in the
    // propose payload). The critic then confirms the merge but rejects the split.
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("strict reviewer")) {
        // Per-proposal critic call. Confirm a merge, reject a split.
        const content = request.messages.at(-1)?.content ?? "";
        return content.startsWith("Proposed merge")
          ? JSON.stringify({ confirmed: true, rationale: "one doc covers both" })
          : JSON.stringify({ confirmed: false, rationale: "independent topics" });
      }
      // Propose call.
      return JSON.stringify({
        merges: [{ clusterIds: ["c1", "c2"], rationale: "merge them" }],
        splits: [{ clusterId: "c3", children: [{ gapIds: ["g1"] }, { gapIds: ["g2"] }], rationale: "split it" }]
      });
    });
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const controller = new AbortController();
    const output = (await runner.run(
      job("reconcile_gap_clusters", {
        provider: "openai-compatible",
        clusters: [
          { id: "c1", title: "Alpha" },
          { id: "c2", title: "Beta" },
          { id: "c3", title: "Gamma" }
        ]
      }),
      controller.signal
    )) as {
      merges: Array<{ clusterIds: string[]; rationale: string; confirmed: boolean }>;
      splits: Array<{ clusterId: string; children: Array<{ gapIds: string[] }>; rationale: string; confirmed: boolean }>;
    };

    assert.equal(output.merges.length, 1);
    assert.equal(output.merges[0].confirmed, true, "the critic confirmed the merge");
    assert.deepEqual(output.merges[0].clusterIds, ["c1", "c2"]);
    assert.equal(output.splits.length, 1);
    assert.equal(output.splits[0].confirmed, false, "the critic rejected the split");
    // Every chat call honoured the abort signal.
    assert.ok(chat.requests.every((r) => r.signal === controller.signal));
  });

  it("treats an unparseable critic verdict as not confirmed for reconcile_gap_clusters", async () => {
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("strict reviewer")) {
        return "not json at all";
      }
      return JSON.stringify({ merges: [{ clusterIds: ["c1", "c2"], rationale: "merge" }], splits: [] });
    });
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("reconcile_gap_clusters", {
        provider: "openai-compatible",
        clusters: [
          { id: "c1", title: "Alpha" },
          { id: "c2", title: "Beta" }
        ]
      }),
      new AbortController().signal
    )) as { merges: Array<{ confirmed: boolean }> };
    assert.equal(output.merges[0].confirmed, false, "unparseable critic ⇒ not confirmed");
  });
});
