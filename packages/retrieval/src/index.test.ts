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

  it("returns undefined with no flows and never calls the provider", async () => {
    assert.equal(await routeQuestionToFlow("anything", [], throwingProvider()), undefined);
  });

  it("short-circuits to the only flow without calling the provider", async () => {
    const decision = await routeQuestionToFlow("anything", [flows[0]], throwingProvider());
    assert.deepEqual(decision, { flowId: "security", confidence: "high" });
  });

  it("returns the model's chosen flow when it is a known id", async () => {
    const provider: ChatProvider = {
      async complete() {
        return { content: JSON.stringify({ flowId: "dev", confidence: "high", rationale: "code question" }) };
      }
    };
    const decision = await routeQuestionToFlow("how do I call the API?", flows, provider);
    assert.equal(decision?.flowId, "dev");
    assert.equal(decision?.confidence, "high");
    assert.equal(decision?.rationale, "code question");
  });

  it("returns undefined when the model names an unknown flow", async () => {
    const provider: ChatProvider = {
      async complete() {
        return { content: JSON.stringify({ flowId: "marketing", confidence: "high" }) };
      }
    };
    assert.equal(await routeQuestionToFlow("q", flows, provider), undefined);
  });

  it("returns undefined when the provider throws", async () => {
    const provider: ChatProvider = {
      async complete() {
        throw new Error("model down");
      }
    };
    assert.equal(await routeQuestionToFlow("q", flows, provider), undefined);
  });
});
