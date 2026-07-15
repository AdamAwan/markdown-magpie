import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiUsageFromTokenCounts, type ChatProvider } from "@magpie/core";
import { addAiUsage, withUsageReporting } from "./usage.js";

describe("addAiUsage", () => {
  it("returns the other side when one is undefined", () => {
    assert.equal(addAiUsage(undefined, undefined), undefined);
    assert.deepEqual(addAiUsage({ inputTokens: 5 }, undefined), { inputTokens: 5 });
    assert.deepEqual(addAiUsage(undefined, { outputTokens: 3 }), { outputTokens: 3 });
  });

  it("sums input/output field-by-field, keeping a field when either side reported it", () => {
    const summed = addAiUsage(
      { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      { inputTokens: 40, outputTokens: 5, totalTokens: 45 }
    );
    assert.deepEqual(summed, { inputTokens: 140, outputTokens: 25, totalTokens: 165 });
  });

  it("falls back to a side's input+output when it reported no total, so mixed readings never understate totalTokens", () => {
    // The second reading carries no totalTokens (the AI SDK frequently omits
    // it): its effective total is input+output, so the summed total can never
    // be smaller than the spend the input/output fields prove.
    const summed = addAiUsage(
      { inputTokens: 100, outputTokens: 20, totalTokens: 130 },
      { inputTokens: 40, outputTokens: 5 }
    );
    assert.deepEqual(summed, { inputTokens: 140, outputTokens: 25, totalTokens: 175 });
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

// The shared core sanitizer both the HTTP chat providers and the source-agent
// loop feed raw counts through; exercised here beside its consumers because
// @magpie/core has no test harness of its own.
describe("aiUsageFromTokenCounts", () => {
  it("maps well-formed token counts", () => {
    assert.deepEqual(aiUsageFromTokenCounts({ inputTokens: 10, outputTokens: 3, totalTokens: 13 }), {
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13
    });
  });

  it("rounds fractional counts to the integers the API's completion contract requires", () => {
    // A non-conforming gateway reporting fractional counts must never be able
    // to 400 (and thereby discard) an otherwise good completion.
    assert.deepEqual(aiUsageFromTokenCounts({ inputTokens: 140.5, outputTokens: 24.4 }), {
      inputTokens: 141,
      outputTokens: 24
    });
  });

  it("drops NaN/negative/non-numeric fields, returning undefined when nothing survives", () => {
    assert.deepEqual(aiUsageFromTokenCounts({ inputTokens: Number.NaN, totalTokens: 9 }), { totalTokens: 9 });
    assert.equal(aiUsageFromTokenCounts({ inputTokens: Number.NaN, outputTokens: -1 }), undefined);
    assert.equal(aiUsageFromTokenCounts({ inputTokens: "12" }), undefined);
    assert.equal(aiUsageFromTokenCounts({}), undefined);
  });
});
