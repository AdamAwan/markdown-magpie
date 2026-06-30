import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAiProvider, RuntimeConfigHolder } from "../../config-holder.js";

describe("normalizeAiProvider", () => {
  it("rejects the removed mock provider", () => {
    assert.equal(normalizeAiProvider("mock"), undefined);
  });

  it("accepts each supported watcher provider", () => {
    assert.equal(normalizeAiProvider("openai-compatible"), "openai-compatible");
    assert.equal(normalizeAiProvider("azure-openai"), "azure-openai");
    assert.equal(normalizeAiProvider("codex"), "codex");
    assert.equal(normalizeAiProvider("claude"), "claude");
  });

  it("rejects unknown values", () => {
    assert.equal(normalizeAiProvider(undefined), undefined);
    assert.equal(normalizeAiProvider("nope"), undefined);
  });
});

describe("RuntimeConfigHolder", () => {
  it("returns its seeded provider", () => {
    const holder = new RuntimeConfigHolder({ aiProvider: "codex" });
    assert.deepEqual(holder.get(), { aiProvider: "codex" });
  });

  it("update() swaps the active provider at runtime", () => {
    const holder = new RuntimeConfigHolder({ aiProvider: "codex" });
    holder.update({ aiProvider: "claude" });
    assert.deepEqual(holder.get(), { aiProvider: "claude" });
  });

  it("reset() restores the seed without re-reading the environment", () => {
    const holder = new RuntimeConfigHolder({ aiProvider: "codex" });
    holder.update({ aiProvider: "claude" });
    holder.reset();
    assert.deepEqual(holder.get(), { aiProvider: "codex" });
  });
});
