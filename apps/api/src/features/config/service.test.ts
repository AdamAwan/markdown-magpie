import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { normalizeAiProvider, RuntimeConfigHolder } from "../../config-holder.js";

const ENV_KEYS = ["AI_PROVIDER", "AI_JOB_PROVIDER", "CHAT_PROVIDER", "AI_EXECUTION_MODE"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

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

describe("RuntimeConfigHolder.fromEnv", () => {
  const original = snapshotEnv();
  afterEach(() => restoreEnv(original));

  it("fails clearly when AI_PROVIDER is absent (no defaulting to mock)", () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    assert.throws(() => RuntimeConfigHolder.fromEnv(), /AI_PROVIDER must name a supported watcher provider/);
  });

  it("fails when AI_PROVIDER names an unsupported provider", () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.AI_PROVIDER = "mock";
    assert.throws(() => RuntimeConfigHolder.fromEnv(), /AI_PROVIDER must name a supported watcher provider/);
  });

  it("uses AI_PROVIDER when it is a supported provider", () => {
    process.env.AI_PROVIDER = "codex";
    const holder = RuntimeConfigHolder.fromEnv();
    assert.deepEqual(holder.get(), { aiProvider: "codex" });
  });
});
