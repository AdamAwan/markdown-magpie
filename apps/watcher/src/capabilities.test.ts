import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveCapabilities } from "./capabilities.js";

// A baseline environment with nothing configured. Each test layers on only the
// vars it needs so the assertions stay focused on a single capability gate.
const EMPTY: NodeJS.ProcessEnv = {};

describe("deriveCapabilities", () => {
  it("always advertises maintenance, even with an empty environment", () => {
    assert.deepEqual(deriveCapabilities(EMPTY), ["maintenance"]);
  });

  it("never advertises a mock capability", () => {
    const everything: NodeJS.ProcessEnv = {
      OPENAI_COMPATIBLE_BASE_URL: "https://api.example.com/v1",
      OPENAI_COMPATIBLE_API_KEY: "key",
      OPENAI_COMPATIBLE_MODEL: "gpt",
      AZURE_OPENAI_ENDPOINT: "https://az.example.com",
      AZURE_OPENAI_API_KEY: "key",
      AZURE_OPENAI_CHAT_DEPLOYMENT: "deploy",
      CODEX_CLI_PATH: "codex",
      CLAUDE_CLI_PATH: "claude",
      GITHUB_TOKEN: "tok",
      MAGPIE_GIT_AUTHOR_NAME: "Magpie",
      MAGPIE_GIT_AUTHOR_EMAIL: "magpie@example.com"
    };
    assert.ok(!deriveCapabilities(everything).includes("mock" as never));
  });

  it("advertises openai-compatible only when base url, key, and model are all set", () => {
    assert.ok(!deriveCapabilities({ OPENAI_COMPATIBLE_BASE_URL: "u", OPENAI_COMPATIBLE_API_KEY: "k" })
      .includes("openai-compatible"));
    assert.ok(deriveCapabilities({
      OPENAI_COMPATIBLE_BASE_URL: "https://api.example.com/v1",
      OPENAI_COMPATIBLE_API_KEY: "key",
      OPENAI_COMPATIBLE_MODEL: "gpt"
    }).includes("openai-compatible"));
  });

  it("advertises azure-openai only when endpoint, key, and deployment are all set", () => {
    assert.ok(!deriveCapabilities({ AZURE_OPENAI_ENDPOINT: "e", AZURE_OPENAI_API_KEY: "k" })
      .includes("azure-openai"));
    assert.ok(deriveCapabilities({
      AZURE_OPENAI_ENDPOINT: "https://az.example.com",
      AZURE_OPENAI_API_KEY: "key",
      AZURE_OPENAI_CHAT_DEPLOYMENT: "deploy"
    }).includes("azure-openai"));
  });

  it("advertises codex when its CLI path is configured", () => {
    assert.ok(!deriveCapabilities(EMPTY).includes("codex"));
    assert.ok(deriveCapabilities({ CODEX_CLI_PATH: "/usr/bin/codex" }).includes("codex"));
  });

  it("advertises claude when its CLI path is configured", () => {
    assert.ok(!deriveCapabilities(EMPTY).includes("claude"));
    assert.ok(deriveCapabilities({ CLAUDE_CLI_PATH: "/usr/bin/claude" }).includes("claude"));
  });

  it("advertises github only with a token and a full git author identity", () => {
    assert.ok(!deriveCapabilities({ GITHUB_TOKEN: "tok" }).includes("github"));
    assert.ok(!deriveCapabilities({
      GITHUB_TOKEN: "tok",
      MAGPIE_GIT_AUTHOR_NAME: "Magpie"
    }).includes("github"));
    assert.ok(deriveCapabilities({
      GITHUB_TOKEN: "tok",
      MAGPIE_GIT_AUTHOR_NAME: "Magpie",
      MAGPIE_GIT_AUTHOR_EMAIL: "magpie@example.com"
    }).includes("github"));
  });
});
