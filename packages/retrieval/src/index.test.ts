import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatProvider } from "@magpie/core";
import { routeQuestionToFlow } from "./index.js";

describe("routeQuestionToFlow", () => {
  const flows = [
    { id: "security", name: "Security Questionnaire", persona: "Formal, high-level." },
    { id: "dev", name: "Internal Developer", persona: "Factual, with code examples." }
  ];

  function throwingProvider(): ChatProvider {
    return {
      async complete() {
        throw new Error("provider should not be called");
      }
    };
  }

  it("is unroutable with no flows and never calls the provider", async () => {
    assert.deepEqual(await routeQuestionToFlow("anything", [], throwingProvider()), {
      status: "unroutable"
    });
  });

  it("short-circuits to the only flow without calling the provider", async () => {
    const route = await routeQuestionToFlow("anything", [flows[0]], throwingProvider());
    assert.deepEqual(route, { status: "routed", flowId: "security", confidence: "high" });
  });

  it("returns the model's chosen flow when it is a known id", async () => {
    const provider: ChatProvider = {
      async complete() {
        return { content: JSON.stringify({ flowId: "dev", confidence: "high", rationale: "code question" }) };
      }
    };
    const route = await routeQuestionToFlow("how do I call the API?", flows, provider);
    assert.deepEqual(route, {
      status: "routed",
      flowId: "dev",
      confidence: "high",
      rationale: "code question"
    });
  });

  it("is unknown when the model abstains with flowId null", async () => {
    const provider: ChatProvider = {
      async complete() {
        return { content: JSON.stringify({ flowId: null, confidence: "low", rationale: "no match" }) };
      }
    };
    assert.deepEqual(await routeQuestionToFlow("q", flows, provider), { status: "unknown" });
  });

  it("is unroutable when the model names an unknown flow", async () => {
    const provider: ChatProvider = {
      async complete() {
        return { content: JSON.stringify({ flowId: "marketing", confidence: "high" }) };
      }
    };
    assert.deepEqual(await routeQuestionToFlow("q", flows, provider), { status: "unroutable" });
  });

  it("is unroutable when the provider throws", async () => {
    const provider: ChatProvider = {
      async complete() {
        throw new Error("model down");
      }
    };
    assert.deepEqual(await routeQuestionToFlow("q", flows, provider), { status: "unroutable" });
  });
});
