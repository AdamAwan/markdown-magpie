import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateTokenCost, parseAiPricing } from "./ai-pricing.js";

describe("parseAiPricing", () => {
  it("treats unset/blank as no pricing configured, with no errors", () => {
    assert.deepEqual(parseAiPricing(undefined), { entries: [], errors: [] });
    assert.deepEqual(parseAiPricing(""), { entries: [], errors: [] });
    assert.deepEqual(parseAiPricing("   "), { entries: [], errors: [] });
  });

  it("parses a valid table, one entry per (provider, model) pair", () => {
    const result = parseAiPricing(
      JSON.stringify([
        { provider: "openai-compatible", model: "gpt-4o-mini", inputPerMTok: 0.15, outputPerMTok: 0.6 },
        // A free local vLLM is a legitimate zero-rate entry, distinct from unpriced.
        { provider: "openai-compatible", model: "local-llama", inputPerMTok: 0, outputPerMTok: 0 },
        { provider: "azure-openai", model: "prod-gpt4o", inputPerMTok: 2.5, outputPerMTok: 10 }
      ])
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.entries.length, 3);
    assert.deepEqual(result.entries[0], {
      provider: "openai-compatible",
      model: "gpt-4o-mini",
      inputPerMTok: 0.15,
      outputPerMTok: 0.6
    });
  });

  it("rejects malformed JSON instead of silently ignoring it", () => {
    const result = parseAiPricing("[{not json");
    assert.deepEqual(result.entries, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /must be valid JSON/);
  });

  it("rejects unknown providers, blank models, and negative or non-numeric rates", () => {
    const result = parseAiPricing(
      JSON.stringify([
        { provider: "openai", model: "gpt-4o", inputPerMTok: 1, outputPerMTok: 2 },
        { provider: "claude", model: "  ", inputPerMTok: 1, outputPerMTok: 2 },
        { provider: "codex", model: "o4", inputPerMTok: -1, outputPerMTok: "2" }
      ])
    );
    assert.deepEqual(result.entries, [], "a table with any bad entry yields no entries at all");
    assert.ok(
      result.errors.some((message) => /entry 0.*provider must be one of/.test(message)),
      result.errors.join("\n")
    );
    assert.ok(
      result.errors.some((message) => /entry 1\.model/.test(message)),
      result.errors.join("\n")
    );
    assert.ok(
      result.errors.some((message) => /entry 2\.inputPerMTok/.test(message)),
      result.errors.join("\n")
    );
    assert.ok(
      result.errors.some((message) => /entry 2\.outputPerMTok/.test(message)),
      result.errors.join("\n")
    );
  });

  it("rejects a typo'd rate field name instead of pricing that direction at nothing", () => {
    const result = parseAiPricing(
      JSON.stringify([{ provider: "claude", model: "opus", inputPerMtok: 1, outputPerMTok: 2 }])
    );
    assert.deepEqual(result.entries, []);
    assert.ok(result.errors.length > 0);
  });

  it("rejects duplicate (provider, model) pairs as ambiguous", () => {
    const result = parseAiPricing(
      JSON.stringify([
        { provider: "claude", model: "opus", inputPerMTok: 1, outputPerMTok: 2 },
        { provider: "claude", model: "opus", inputPerMTok: 3, outputPerMTok: 4 }
      ])
    );
    assert.deepEqual(result.entries, []);
    assert.ok(
      result.errors.some((message) => /duplicate entry/.test(message)),
      result.errors.join("\n")
    );
  });
});

describe("estimateTokenCost", () => {
  const entries = parseAiPricing(
    JSON.stringify([{ provider: "openai-compatible", model: "m", inputPerMTok: 2, outputPerMTok: 6 }])
  ).entries;

  it("splits cost into input, output, and total", () => {
    const cost = estimateTokenCost(
      entries,
      { provider: "openai-compatible", model: "m" },
      { inputTokens: 1_000_000, outputTokens: 500_000 }
    );
    assert.deepEqual(cost, { input: 2, output: 3, total: 5 });
  });

  it("returns undefined for an unmatched model (unpriced, not $0)", () => {
    assert.equal(
      estimateTokenCost([], { provider: "openai-compatible", model: "m" }, { inputTokens: 10, outputTokens: 10 }),
      undefined
    );
  });

  it("returns undefined for a null model (a CLI provider's default)", () => {
    assert.equal(
      estimateTokenCost(entries, { provider: "openai-compatible", model: null }, { inputTokens: 10, outputTokens: 10 }),
      undefined
    );
  });

  it("prices a zero-rate free model as a real zero, not undefined", () => {
    const free = parseAiPricing(
      JSON.stringify([{ provider: "openai-compatible", model: "free", inputPerMTok: 0, outputPerMTok: 0 }])
    ).entries;
    assert.deepEqual(
      estimateTokenCost(free, { provider: "openai-compatible", model: "free" }, { inputTokens: 9, outputTokens: 9 }),
      { input: 0, output: 0, total: 0 }
    );
  });
});
