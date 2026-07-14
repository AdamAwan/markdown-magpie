import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatProvider } from "@magpie/core";
import { addAiUsage, usageFromLanguageModelUsage, withUsageReporting } from "./usage.js";

describe("addAiUsage", () => {
  it("returns the other side when one is undefined", () => {
    assert.equal(addAiUsage(undefined, undefined), undefined);
    assert.deepEqual(addAiUsage({ inputTokens: 5 }, undefined), { inputTokens: 5 });
    assert.deepEqual(addAiUsage(undefined, { outputTokens: 3 }), { outputTokens: 3 });
  });

  it("sums field-by-field, keeping a field when either side reported it", () => {
    assert.deepEqual(
      addAiUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }, { inputTokens: 40, outputTokens: 5 }),
      { inputTokens: 140, outputTokens: 25, totalTokens: 120 }
    );
  });

  it("omits fields neither side reported", () => {
    assert.deepEqual(addAiUsage({ totalTokens: 10 }, { totalTokens: 4 }), { totalTokens: 14 });
  });
});

describe("withUsageReporting", () => {
  it("forwards each response's usage and returns the response unchanged", async () => {
    const readings: unknown[] = [];
    const inner: ChatProvider = {
      complete: async () => ({ content: "hi", usage: { inputTokens: 7, outputTokens: 2 } })
    };
    const wrapped = withUsageReporting(inner, (usage) => readings.push(usage));

    const response = await wrapped.complete({ system: "s", messages: [{ role: "user", content: "q" }] });

    assert.equal(response.content, "hi");
    assert.deepEqual(readings, [{ inputTokens: 7, outputTokens: 2 }]);
  });

  it("reports nothing when the provider reports no usage", async () => {
    const readings: unknown[] = [];
    const inner: ChatProvider = { complete: async () => ({ content: "hi" }) };
    const wrapped = withUsageReporting(inner, (usage) => readings.push(usage));

    await wrapped.complete({ system: "s", messages: [{ role: "user", content: "q" }] });

    assert.deepEqual(readings, []);
  });
});

describe("usageFromLanguageModelUsage", () => {
  it("maps well-formed token counts", () => {
    assert.deepEqual(usageFromLanguageModelUsage({ inputTokens: 10, outputTokens: 3, totalTokens: 13 }), {
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13
    });
  });

  it("drops NaN/negative/missing fields, returning undefined when nothing survives", () => {
    assert.deepEqual(usageFromLanguageModelUsage({ inputTokens: Number.NaN, totalTokens: 9 }), { totalTokens: 9 });
    assert.equal(usageFromLanguageModelUsage({ inputTokens: Number.NaN, outputTokens: -1 }), undefined);
    assert.equal(usageFromLanguageModelUsage({}), undefined);
  });
});
