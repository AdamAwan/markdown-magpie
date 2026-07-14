import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import type { ChatProvider, ChatRequest, ChatResponse } from "@magpie/core";
import { JOB_TYPES, jobDefinition, type JobView, type JobType } from "@magpie/jobs";
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
    content: "Run the deploy script.",
    relevance: 0.9
  }
];

function providerJobTypes(): JobType[] {
  return JOB_TYPES.filter((type) => {
    try {
      return jobDefinition(type).requiredCapability({ provider: "openai-compatible" }) === "openai-compatible";
    } catch {
      return false;
    }
  });
}

function fakeApi(overrides: Partial<WatcherApi> = {}): WatcherApi {
  return {
    claim: async () => undefined,
    heartbeat: async () => ({ cancelled: false }),
    complete: async () => undefined,
    fail: async () => undefined,
    retrieve: async () => SECTIONS,
    // Default: the embedding router abstains, so routing falls back to the chat
    // router the existing tests mock. Tests that exercise embedding routing override.
    routeByEmbedding: async () => ({ status: "abstain" }),
    proposalExecutionContext: async () => ({ proposal: {}, repository: {} }),
    reconcileGaps: async () => ({ ok: true }),
    verifyClosure: async () => ({ proposalId: "p", closureStatus: "verified_closed", perQuestion: [] }),
    runSourceSync: async () => ({ runIds: [] }),
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
    runImprovePatrol: async () => ({ runId: "run-1", selectedCount: 0, enqueuedCount: 0 }),
    runSeedBootstrap: async () => ({ enqueued: false, reason: "no_sources" }),
    listOpenPullRequests: async () => [],
    sourceMapEntries: async () => [],
    ...overrides
  };
}

describe("ChatRunner", () => {
  it("declares its provider capability and supports AI job types", () => {
    const runner = new ChatRunner("openai-compatible", new FakeChatProvider(() => "{}"), fakeApi());
    assert.equal(runner.capability, "openai-compatible");
    for (const type of providerJobTypes()) {
      assert.ok(runner.supports(type), `chat runner should support provider job type ${type}`);
    }
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
      // The routing call asks for a flow id; the grounding check reviews the
      // drafted answer; the answer call asks the question.
      if (request.system.includes("route a user question")) {
        return JSON.stringify({ flowId: "flow-b", confidence: "high" });
      }
      if (request.system.includes("You verify a drafted")) {
        return JSON.stringify({ grounded: true, unsupportedClaims: [] });
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

  it("routes via the embedding router without billing a chat routing call", async () => {
    let retrievedFlow: string | undefined = "unset";
    const api = fakeApi({
      routeByEmbedding: async () => ({ status: "routed", flowId: "flow-b", confidence: "high", margin: 0.4 }),
      retrieve: async (_question, flowId) => {
        retrievedFlow = flowId;
        return SECTIONS;
      }
    });
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("You verify a drafted")) {
        return JSON.stringify({ grounded: true, unsupportedClaims: [] });
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
    )) as { flowId?: string; trace?: { routing: { mode: string; flowId?: string; method?: string } } };

    assert.equal(retrievedFlow, "flow-b", "retrieves with the embedding-routed flow");
    assert.equal(output.flowId, "flow-b");
    assert.ok(
      !chat.requests.some((request) => request.system.includes("route a user question")),
      "no chat routing call when the embedding router is confident"
    );
    assert.equal(output.trace?.routing.mode, "routed");
    assert.equal(output.trace?.routing.method, "embedding", "the trace records the embedding router decided");
  });

  it("falls back to the chat router when the embedding router abstains", async () => {
    let embeddingTried = false;
    const api = fakeApi({
      routeByEmbedding: async () => {
        embeddingTried = true;
        return { status: "abstain" };
      }
    });
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("route a user question")) {
        return JSON.stringify({ flowId: "flow-a", confidence: "high" });
      }
      if (request.system.includes("You verify a drafted")) {
        return JSON.stringify({ grounded: true, unsupportedClaims: [] });
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
    )) as { flowId?: string; trace?: { routing: { method?: string } } };

    assert.ok(embeddingTried, "the embedding router is tried first");
    assert.ok(
      chat.requests.some((request) => request.system.includes("route a user question")),
      "the chat router runs on abstention"
    );
    assert.equal(output.flowId, "flow-a");
    assert.equal(output.trace?.routing.method, "chat", "the trace records the chat router decided");
  });

  it("runs a follow-up search then answers, grounding a followup gap on an empty search", async () => {
    const queries: string[] = [];
    const flowsSeen: Array<string | undefined> = [];
    const api = fakeApi({
      retrieve: async (question, flowId) => {
        queries.push(question);
        flowsSeen.push(flowId);
        // The seed retrieval (the question) returns a section; the model's
        // follow-up search for an example finds nothing → grounds a followup gap.
        return question.includes("example") ? [] : SECTIONS;
      }
    });
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("route a user question")) {
        return JSON.stringify({ flowId: "flow-b", confidence: "high" });
      }
      if (request.system.includes("You verify a drafted")) {
        return JSON.stringify({ grounded: true, unsupportedClaims: [] });
      }
      // Ask to search for an example first; once that search has run, answer and
      // report the missing example as a followup gap.
      if (queries.some((query) => query.includes("example"))) {
        return JSON.stringify({
          action: "answer",
          answer: "Run the deploy script.",
          confidence: "high",
          isKnowledgeGap: false,
          usedSectionIds: ["doc-1#deploy"],
          followupGaps: ["no concrete deploy example"]
        });
      }
      return JSON.stringify({ action: "search", queries: ["deploy example"], rationale: "want an example" });
    });
    const runner = new ChatRunner("openai-compatible", chat, api);
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I deploy?",
        flows: [{ id: "flow-b", name: "Beta" }],
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as {
      citations: unknown[];
      gaps?: Array<{ source: string; summary: string }>;
      trace?: {
        routing: { mode: string; flowId?: string };
        seedSectionCount: number;
        searches: Array<{ query: string; resultCount: number; round: number }>;
        answerContract?: string;
        verification: { status: string };
      };
    };

    assert.ok(queries.some((q) => q.includes("example")), "should run the model's follow-up search");
    assert.ok(
      flowsSeen.every((flowId) => flowId === "flow-b"),
      "follow-up searches stay within the routed flow"
    );
    assert.equal(output.citations.length, 1);
    assert.ok(output.gaps && output.gaps.length === 1);
    assert.equal(output.gaps[0].source, "followup");
    assert.equal(output.gaps[0].summary, "no concrete deploy example");

    // The trace explains the run: routed flow, one empty follow-up search (the
    // thing that grounded the followup gap), and a grounded verification.
    assert.ok(output.trace, "the answer carries a trace");
    assert.equal(output.trace.routing.mode, "routed");
    assert.equal(output.trace.routing.flowId, "flow-b");
    assert.equal(output.trace.seedSectionCount, 1);
    assert.deepEqual(output.trace.searches, [{ query: "deploy example", resultCount: 0, round: 1 }]);
    assert.equal(output.trace.answerContract, "structured");
    assert.equal(output.trace.verification.status, "grounded");
  });

  it("forces a gap-derived search when the model gives up low on the first round", async () => {
    // Reproduces the reported failure: the model answers low / flags a knowledge gap
    // immediately, without ever choosing action:"search". The guard must force one
    // search from the model's own declared gaps before accepting the answer.
    const queries: string[] = [];
    const api = fakeApi({
      retrieve: async (question) => {
        queries.push(question);
        return SECTIONS;
      }
    });
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("route a user question")) {
        return JSON.stringify({ flowId: "flow-b", confidence: "high" });
      }
      // Every assess round the model tries to give up with the same low-confidence
      // knowledge-gap answer. Round 0 is intercepted and a search is forced; round 1
      // (a search has now run) is accepted, so the loop converges.
      return JSON.stringify({
        action: "answer",
        answer: "The knowledge base does not specify Magpie's security certifications.",
        confidence: "low",
        isKnowledgeGap: true,
        gaps: ["specific security certifications held by Magpie"],
        usedSectionIds: []
      });
    });
    const runner = new ChatRunner("openai-compatible", chat, api);
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "What security certifications does Magpie have?",
        flows: [{ id: "flow-b", name: "Beta" }],
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as {
      confidence: string;
      gaps?: Array<{ source: string; summary: string }>;
      trace?: { searches: Array<{ query: string; resultCount: number; round: number }> };
    };

    assert.ok(
      queries.includes("specific security certifications held by Magpie"),
      "the model's declared gap is searched for even though it only ever asked to answer"
    );
    assert.ok(output.trace, "the answer carries a trace");
    assert.deepEqual(
      output.trace.searches,
      [{ query: "specific security certifications held by Magpie", resultCount: 1, round: 1 }],
      "the forced search is recorded in the trace"
    );
    assert.equal(output.confidence, "low", "the answer still ships low once the search did not close the gap");
    assert.ok(output.gaps && output.gaps.some((gap) => gap.source === "auto"), "the knowledge gap is still emitted");
  });

  it("passes the abort signal through to retrieval", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const api = fakeApi({
      retrieve: async (_question, _flowId, _limit, signal) => {
        signals.push(signal);
        return SECTIONS;
      }
    });
    const chat = new FakeChatProvider(() =>
      JSON.stringify({ action: "answer", answer: "ok", confidence: "high", isKnowledgeGap: false, usedSectionIds: [] })
    );
    const runner = new ChatRunner("openai-compatible", chat, api);
    await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I deploy?",
        flows: [{ id: "flow-a", name: "Alpha" }],
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      controller.signal
    );
    assert.ok(signals.length >= 1);
    assert.ok(signals.every((signal) => signal === controller.signal), "retrieve receives the job abort signal");
  });

  it("uses a caller-specified flow directly and skips routing", async () => {
    let retrievedFlow: string | undefined = "unset";
    const api = fakeApi({
      retrieve: async (_question, flowId) => {
        retrievedFlow = flowId;
        return SECTIONS;
      }
    });
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("You verify a drafted")) {
        return JSON.stringify({ grounded: true, unsupportedClaims: [] });
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
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as { flowId?: string };

    assert.equal(retrievedFlow, "flow-a", "should retrieve with the caller-specified flow");
    assert.equal(output.flowId, "flow-a");
    assert.equal(chat.requests.length, 2, "answer + grounding check only — no routing call");
    assert.ok(
      chat.requests.every((request) => !request.system.includes("route a user question")),
      "should not make a routing call"
    );
  });

  it("strips fabricated claims, downgrades to low, and records them as gaps when the grounding check fails", async () => {
    // The fabrication scenario: retrieval returned real material, but the model
    // "sold" the answer with compliance claims (SOC 2) the context never states.
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("You verify a drafted")) {
        assert.match(
          request.messages[0]?.content ?? "",
          /SOC 2 certified/,
          "the verifier reviews the drafted answer"
        );
        assert.match(
          request.messages[0]?.content ?? "",
          /\[section doc-1#deploy\]/,
          "the verifier sees the retrieved context the answer was drafted from"
        );
        return JSON.stringify({
          grounded: false,
          unsupportedClaims: ["SOC 2 compliance status"],
          revisedAnswer: "Run the deploy script."
        });
      }
      return JSON.stringify({
        answer: "Run the deploy script. We are SOC 2 certified.",
        confidence: "high",
        isKnowledgeGap: false,
        usedSectionIds: ["doc-1#deploy"]
      });
    });
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I sell this as secure?",
        flows: [{ id: "flow-a", name: "Alpha" }],
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as {
      answer: string;
      confidence: string;
      gaps?: Array<{ summary: string; source: string }>;
      trace?: { routing: { mode: string }; verification: { status: string; unsupportedClaims?: string[] } };
    };

    assert.equal(output.answer, "Run the deploy script.", "the fabricated claim is stripped from the answer");
    assert.equal(output.confidence, "low", "a fabricating answer ships distrusted, not HIGH");
    assert.ok(output.gaps && output.gaps.length === 1, "the stripped claim is recorded as a gap");
    assert.equal(output.gaps[0].summary, "SOC 2 compliance status");
    assert.equal(output.gaps[0].source, "auto");
    assert.equal(output.trace?.routing.mode, "requested", "caller-pinned flow is traced as requested");
    assert.equal(output.trace?.verification.status, "claims_stripped");
    assert.deepEqual(output.trace?.verification.unsupportedClaims, ["SOC 2 compliance status"]);
  });

  it("sends cited sections in full but uncited retrieved sections as headings only to the verifier", async () => {
    // The pool holds a cited section and a retrieved-but-uncited section. The verifier
    // must see the cited body in full, the uncited section's heading only (its body
    // withheld to save tokens), and the label that keeps an uncited-topic claim from
    // being flagged as fabricated (#169 Part 1).
    const pool: RetrievedSection[] = [
      SECTIONS[0],
      {
        sectionId: "doc-2#extra",
        documentId: "doc-2",
        anchor: "extra",
        path: "ops/extra.md",
        heading: "Extra context",
        content: "Uncited body that must not be re-sent.",
        relevance: 0.8
      }
    ];
    let verifyMessage = "";
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("You verify a drafted")) {
        verifyMessage = request.messages[0]?.content ?? "";
        return JSON.stringify({ grounded: true, unsupportedClaims: [] });
      }
      // Answer cites only the first section, so the second stays uncited-but-retrieved.
      return JSON.stringify({
        answer: "Run the deploy script.",
        confidence: "high",
        isKnowledgeGap: false,
        usedSectionIds: ["doc-1#deploy"]
      });
    });
    const runner = new ChatRunner("openai-compatible", chat, fakeApi({ retrieve: async () => pool }));
    await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I deploy?",
        flows: [{ id: "flow-a", name: "Alpha" }],
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    );

    assert.match(
      verifyMessage,
      /\[section doc-1#deploy\] # Deploy\nRun the deploy script\./,
      "the cited section is shown in full"
    );
    assert.match(verifyMessage, /\[section doc-2#extra\] # Extra context/, "the uncited section's heading is shown");
    assert.doesNotMatch(verifyMessage, /Uncited body that must not be re-sent\./, "the uncited section's body is withheld");
    assert.match(verifyMessage, /Also retrieved \(headings only/, "uncited sections are grouped under the headings-only label");
  });

  it("keeps the drafted answer when the grounding verdict is unparseable (fails open)", async () => {
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("You verify a drafted")) {
        return "not a verdict at all";
      }
      return JSON.stringify({ answer: "Run the deploy script.", confidence: "high", isKnowledgeGap: false });
    });
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I deploy?",
        flows: [{ id: "flow-a", name: "Alpha" }],
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as { answer: string; confidence: string };

    assert.equal(output.answer, "Run the deploy script.");
    assert.equal(output.confidence, "high", "a flaky verifier must not downgrade every answer");
  });

  it("verifies unstructured prose answers despite low confidence and keeps them when grounded", async () => {
    // A model that ignores the JSON contract but genuinely answers in plain prose:
    // the prose is the least-trusted output the loop can produce, so it must pass
    // the grounding check to ship — low confidence alone no longer skips it.
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("You verify a drafted")) {
        return JSON.stringify({ grounded: true, unsupportedClaims: [] });
      }
      return "Run the deploy script.";
    });
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I deploy?",
        flows: [{ id: "flow-a", name: "Alpha" }],
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as { answer: string; confidence: string; trace?: { verification: { status: string } } };

    assert.ok(
      chat.requests.some((request) => request.system.includes("You verify a drafted")),
      "an unstructured answer must be grounding-checked before it ships"
    );
    assert.equal(output.answer, "Run the deploy script.", "grounded prose still ships verbatim");
    assert.equal(output.confidence, "low", "contract-ignoring output stays distrusted");
    assert.equal(output.trace?.verification.status, "grounded");
  });

  it("replaces unstructured prose with the fallback when the grounding verdict is unparseable (fails closed)", async () => {
    // The incident class: a CLI provider's interactive persona leaks through as
    // conversational chatter ("grant me tool access..."). Nothing can vouch for
    // it — the structured contract was ignored AND the verifier produced no
    // verdict — so the raw prose must never reach the reader.
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("You verify a drafted")) {
        return "not a verdict at all";
      }
      return "I need permission to search the knowledge base. Could you grant access to the kb_search tool?";
    });
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I deploy?",
        flows: [{ id: "flow-a", name: "Alpha" }],
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as { answer: string; confidence: string; trace?: { verification: { status: string } } };

    assert.doesNotMatch(output.answer, /grant access/, "unvouched chatter must not ship as the answer");
    assert.match(output.answer, /could not produce a reliable answer/);
    assert.equal(output.confidence, "low");
    assert.equal(output.trace?.verification.status, "verdict_unparseable");
  });

  it("replaces ungrounded unstructured prose with the fallback when the verifier offers no revision", async () => {
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("You verify a drafted")) {
        return JSON.stringify({ grounded: false, unsupportedClaims: ["a permission plea, not an answer"] });
      }
      return "I need permission to search the knowledge base before I can answer.";
    });
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I deploy?",
        flows: [{ id: "flow-a", name: "Alpha" }],
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as {
      answer: string;
      confidence: string;
      gaps?: Array<{ summary: string }>;
      trace?: { verification: { status: string } };
    };

    assert.doesNotMatch(output.answer, /permission/, "ungrounded chatter with no revision must not ship");
    assert.match(output.answer, /could not produce a reliable answer/);
    assert.equal(output.confidence, "low");
    assert.equal(output.trace?.verification.status, "claims_stripped");
    assert.ok(output.gaps?.some((gap) => gap.summary === "a permission plea, not an answer"));
  });

  it("skips the grounding check for knowledge-gap answers", async () => {
    const chat = new FakeChatProvider(() =>
      JSON.stringify({ answer: "Not covered.", confidence: "low", isKnowledgeGap: true, gaps: ["rollback docs"] })
    );
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "How do I roll back?",
        flows: [{ id: "flow-a", name: "Alpha" }],
        requestedFlowId: "flow-a",
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as { confidence: string; trace?: { verification: { status: string; skipReason?: string } } };

    assert.equal(output.confidence, "low");
    assert.ok(
      !chat.requests.some((request) => request.system.includes("You verify a drafted")),
      "a gap answer already ships distrusted — no verify call"
    );
    assert.equal(output.trace?.verification.status, "skipped");
    assert.equal(output.trace?.verification.skipReason, "low_confidence");
  });

  it("withholds the answer and requests flow selection when routing is unknown", async () => {
    let retrieveCalled = false;
    const api = fakeApi({
      retrieve: async () => {
        retrieveCalled = true;
        return SECTIONS;
      }
    });
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("flow")) {
        return JSON.stringify({ flowId: null, confidence: "low", rationale: "no match" });
      }
      return JSON.stringify({ answer: "should not happen", confidence: "high", isKnowledgeGap: false });
    });
    const runner = new ChatRunner("openai-compatible", chat, api);
    const output = (await runner.run(
      job("answer_question", {
        provider: "openai-compatible",
        question: "Something ambiguous?",
        flows: [
          { id: "flow-a", name: "Alpha" },
          { id: "flow-b", name: "Beta" }
        ],
        expectedOutput: "answer_result"
      }),
      new AbortController().signal
    )) as {
      confidence: string;
      flowSelectionRequired?: { availableFlows: Array<{ id: string }> };
      trace?: { routing: { mode: string }; verification: { status: string; skipReason?: string } };
    };

    assert.equal(retrieveCalled, false, "should not retrieve when routing is unknown");
    assert.equal(output.confidence, "unknown");
    assert.deepEqual(
      output.flowSelectionRequired?.availableFlows.map((flow) => flow.id),
      ["flow-a", "flow-b"]
    );
    assert.equal(output.trace?.routing.mode, "unknown", "the abstained routing is traced");
    assert.equal(output.trace?.verification.skipReason, "flow_selection_required");
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

  it("derives reconcile_gap_clusters confirmed flags from one batched critic call, keyed by op id", async () => {
    // The propose call returns one merge, one split, and one dismissal (all unconfirmed
    // in the propose payload). A SINGLE batched critic call then confirms the merge and
    // the dismissal but rejects the split, keyed by the per-op ids.
    let criticMessage = "";
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("strict reviewer")) {
        criticMessage = request.messages.at(-1)?.content ?? "";
        return JSON.stringify({
          verdicts: [
            { id: "merge-0", confirmed: true },
            { id: "split-0", confirmed: false },
            { id: "dismissal-0", confirmed: true }
          ]
        });
      }
      // Propose call.
      return JSON.stringify({
        merges: [{ clusterIds: ["c1", "c2"], rationale: "merge them" }],
        splits: [{ clusterId: "c3", children: [{ gapIds: ["g1"] }, { gapIds: ["g2"] }], rationale: "split it" }],
        dismissals: [{ clusterId: "c4", rationale: "off-topic" }]
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
          { id: "c3", title: "Gamma" },
          { id: "c4", title: "Cats" }
        ]
      }),
      controller.signal
    )) as {
      merges: Array<{ clusterIds: string[]; rationale: string; confirmed: boolean }>;
      splits: Array<{ clusterId: string; children: Array<{ gapIds: string[] }>; rationale: string; confirmed: boolean }>;
      dismissals: Array<{ clusterId: string; rationale: string; confirmed: boolean }>;
    };

    assert.equal(output.merges[0].confirmed, true, "the critic confirmed the merge");
    assert.deepEqual(output.merges[0].clusterIds, ["c1", "c2"]);
    assert.equal(output.splits[0].confirmed, false, "the critic rejected the split");
    assert.equal(output.dismissals[0].confirmed, true, "the critic confirmed the dismissal");

    // Exactly one critic call for the whole reshape (propose + one batched critique).
    const criticCalls = chat.requests.filter((r) => r.system.includes("strict reviewer"));
    assert.equal(criticCalls.length, 1, "one batched critic call, not one per op");
    assert.equal(chat.requests.length, 2, "propose + one batched critic call");
    // The dismissal carries the cluster's scope so the critic can judge off-topic vs uncovered.
    assert.match(criticMessage, /dismissal-0: dismiss cluster c4/, "the dismissal op is listed with its id");
    assert.match(criticMessage, /Cluster under review: cluster c4/, "the critic sees the dismissed cluster's scope");
    // Every chat call honoured the abort signal.
    assert.ok(chat.requests.every((r) => r.signal === controller.signal));
  });

  it("skips the critic call entirely when the reshape proposes nothing", async () => {
    const chat = new FakeChatProvider(() => JSON.stringify({ merges: [], splits: [], dismissals: [] }));
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("reconcile_gap_clusters", {
        provider: "openai-compatible",
        clusters: [{ id: "c1", title: "Alpha" }]
      }),
      new AbortController().signal
    )) as { merges: unknown[]; splits: unknown[]; dismissals: unknown[] };

    assert.deepEqual(output, { merges: [], splits: [], dismissals: [] });
    assert.equal(chat.requests.length, 1, "an empty reshape makes the propose call only — no critic call");
    assert.ok(
      !chat.requests.some((r) => r.system.includes("strict reviewer")),
      "no critic call when nothing was proposed"
    );
  });

  it("treats an unparseable batched critic verdict as not confirmed for reconcile_gap_clusters", async () => {
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

  it("parses a reshape proposal even when the model fences the JSON in prose (reconcile_gap_clusters)", async () => {
    // Providers routinely wrap JSON in a ```json fence or a sentence of preamble.
    // The propose path must tolerate that (via extractJson) rather than silently
    // discarding the whole proposal — the fan-out bug where 100 overlapping clusters
    // each became a proposal because a fenced proposal parsed to empty merges.
    const chat = new FakeChatProvider((request) => {
      if (request.system.includes("strict reviewer")) {
        return JSON.stringify({ verdicts: [{ id: "merge-0", confirmed: true }] });
      }
      return "Here is the reshape:\n```json\n" +
        JSON.stringify({ merges: [{ clusterIds: ["c1", "c2"], rationale: "same doc covers both" }], splits: [], dismissals: [] }) +
        "\n```";
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
    )) as { merges: Array<{ clusterIds: string[]; confirmed: boolean }> };
    assert.equal(output.merges.length, 1, "the fenced proposal was parsed, not discarded");
    assert.deepEqual(output.merges[0].clusterIds, ["c1", "c2"]);
    assert.equal(output.merges[0].confirmed, true, "the parsed merge reached the critic and was confirmed");
  });

  it("asks the provider for JSON on the reshape propose call (reconcile_gap_clusters)", async () => {
    const chat = new FakeChatProvider(() => JSON.stringify({ merges: [], splits: [], dismissals: [] }));
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    await runner.run(
      job("reconcile_gap_clusters", {
        provider: "openai-compatible",
        clusters: [{ id: "c1", title: "Alpha" }]
      }),
      new AbortController().signal
    );
    const propose = chat.requests.find((r) => !r.system.includes("strict reviewer"));
    assert.equal(propose?.responseFormat, "json", "the propose call requests JSON mode like the critic does");
  });

  it("dispatches a seed job with fs sources to the source-agent loop", async () => {
    // A draft_seed_document carrying a local-kind source must run the agentic tool
    // loop over prepared workspaces, not the one-shot generative path.
    const seedOutput = JSON.stringify({
      title: "Statements Module",
      targetPath: "statements/overview.md",
      markdown: "---\ntitle: Statements Module\nstatus: draft\n---\n\n# Statements\n\nGrounded content.",
      rationale: "Grounded in s1/readme.md."
    });
    // The scripted model answers with valid output immediately — no tool turns
    // needed to prove the dispatch went through the agent path.
    const agentModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: seedOutput }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined }
        },
        warnings: []
      }
    });
    const chat = new FakeChatProvider(() => {
      throw new Error("the chat provider must not be called on the agent path");
    });
    const preparedFor: string[] = [];
    const runner = new ChatRunner(
      "openai-compatible",
      chat,
      fakeApi(),
      agentModel,
      "/data/checkouts",
      async (descriptors) => {
        preparedFor.push(...descriptors.map((descriptor) => descriptor.id));
        return { workspaces: [{ sourceId: "s1", name: "Repo", rootDir: "/checkouts/s1" }], notes: [], fetchable: [] };
      }
    );
    const output = (await runner.run(
      job("draft_seed_document", {
        provider: "openai-compatible",
        flowId: "f1",
        coverage: ["statement ingestion"],
        sources: [{ id: "s1", name: "Repo", kind: "local", path: "/srv/repo" }]
      }),
      new AbortController().signal
    )) as { title: string };

    assert.deepEqual(preparedFor, ["s1"], "the job's descriptors are resolved to workspaces");
    assert.equal(output.title, "Statements Module");
    assert.equal(chat.requests.length, 0, "no one-shot generative call is made");
  });

  it("dispatches an improve_document job with fs sources to the source-agent loop", async () => {
    // A patrol child job carrying a local-kind source must run the agentic tool
    // loop over prepared workspaces, not the one-shot generative path.
    const improveOutput = JSON.stringify({ improved: false, rationale: "nothing source-backed to add" });
    // The scripted model answers with valid output immediately — no tool turns
    // needed to prove the dispatch went through the agent path.
    const agentModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: improveOutput }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined }
        },
        warnings: []
      }
    });
    const chat = new FakeChatProvider(() => {
      throw new Error("the chat provider must not be called on the agent path");
    });
    const preparedFor: string[] = [];
    const runner = new ChatRunner(
      "openai-compatible",
      chat,
      fakeApi(),
      agentModel,
      "/data/checkouts",
      async (descriptors) => {
        preparedFor.push(...descriptors.map((descriptor) => descriptor.id));
        return { workspaces: [{ sourceId: "s1", name: "Repo", rootDir: "/checkouts/s1" }], notes: [], fetchable: [] };
      }
    );
    const output = (await runner.run(
      job("improve_document", {
        provider: "openai-compatible",
        path: "kb/a.md",
        content: "# A",
        sources: [{ id: "s1", name: "Repo", kind: "local", path: "/srv/repo" }]
      }),
      new AbortController().signal
    )) as { improved: boolean; rationale: string };

    assert.deepEqual(preparedFor, ["s1"], "the job's descriptors are resolved to workspaces");
    assert.equal(output.improved, false);
    assert.equal(output.rationale, "nothing source-backed to add");
    assert.equal(chat.requests.length, 0, "no one-shot generative call is made");
  });

  it("strips a model-supplied observedSha on the generative path (non-fs sources)", async () => {
    // A seed job with only internet sources runs the plain generative path, which
    // never observes a checkout — so a model-asserted observedSha must be stripped
    // before the output goes back to the worker loop.
    const seedOutput = JSON.stringify({
      title: "T",
      targetPath: "t.md",
      markdown: "---\ntitle: T\nstatus: draft\n---\n\n# T",
      rationale: "r",
      mapUpdates: [{ sourceId: "i1", topic: "t", paths: ["p/"], description: "d", observedSha: "model-lie" }]
    });
    const chat = new FakeChatProvider(() => seedOutput);
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("draft_seed_document", {
        provider: "openai-compatible",
        flowId: "f1",
        coverage: ["statement ingestion"],
        sources: [{ id: "i1", name: "Site", kind: "internet", url: "https://x.example" }]
      }),
      new AbortController().signal
    )) as { mapUpdates?: Array<Record<string, unknown>> };

    assert.deepEqual(output.mapUpdates, [{ sourceId: "i1", topic: "t", paths: ["p/"], description: "d" }]);
  });

  it("strips a model-supplied observedSha when fs sources fall back to the generative path (no agent model)", async () => {
    // fs sources but no agentModel: ChatRunner warns and runs the generative path.
    // No checkout is observed there either, so the sha must still be stripped.
    const verifyOutput = JSON.stringify({
      verdict: "healthy",
      claims: [],
      mapUpdates: [{ sourceId: "s1", topic: "t", paths: ["p/"], description: "d", observedSha: "model-lie" }]
    });
    const chat = new FakeChatProvider(() => verifyOutput);
    const runner = new ChatRunner("openai-compatible", chat, fakeApi());
    const output = (await runner.run(
      job("verify_document", {
        provider: "openai-compatible",
        path: "kb/a.md",
        content: "# A",
        sources: [{ id: "s1", name: "Repo", kind: "local", path: "/srv/repo" }]
      }),
      new AbortController().signal
    )) as { mapUpdates?: Array<Record<string, unknown>> };

    assert.deepEqual(output.mapUpdates, [{ sourceId: "s1", topic: "t", paths: ["p/"], description: "d" }]);
  });

  it("keeps a seed job with only non-fs sources on the generative path", async () => {
    const seedOutput = JSON.stringify({
      title: "T",
      targetPath: "t.md",
      markdown: "---\ntitle: T\nstatus: draft\n---\n\n# T",
      rationale: "r"
    });
    const agentModel = new MockLanguageModelV3({});
    const chat = new FakeChatProvider(() => seedOutput);
    const runner = new ChatRunner("openai-compatible", chat, fakeApi(), agentModel, "/data/checkouts", async () => {
      throw new Error("workspaces must not be prepared for non-fs sources");
    });
    const output = (await runner.run(
      job("draft_seed_document", {
        provider: "openai-compatible",
        flowId: "f1",
        coverage: ["statement ingestion"],
        sources: [{ id: "i1", name: "Site", kind: "internet", url: "https://x.example" }]
      }),
      new AbortController().signal
    )) as { title: string };

    assert.equal(output.title, "T");
    assert.equal(chat.requests.length, 1, "the one-shot generative path handled the job");
  });
});
