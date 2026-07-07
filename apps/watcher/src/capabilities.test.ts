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
    const runtime = { gitAvailable: () => true };
    assert.ok(!deriveCapabilities({ GITHUB_TOKEN: "tok" }, runtime).includes("github"));
    assert.ok(!deriveCapabilities({
      GITHUB_TOKEN: "tok",
      MAGPIE_GIT_AUTHOR_NAME: "Magpie"
    }, runtime).includes("github"));
    assert.ok(deriveCapabilities({
      GITHUB_TOKEN: "tok",
      MAGPIE_GIT_AUTHOR_NAME: "Magpie",
      MAGPIE_GIT_AUTHOR_EMAIL: "magpie@example.com"
    }, runtime).includes("github"));
  });

  it("does not advertise github when git is unavailable", () => {
    const env = {
      GITHUB_TOKEN: "tok",
      MAGPIE_GIT_AUTHOR_NAME: "Magpie",
      MAGPIE_GIT_AUTHOR_EMAIL: "magpie@example.com"
    };

    assert.ok(!deriveCapabilities(env, { gitAvailable: () => false }).includes("github"));
  });

  it("advertises local-git with a git author identity and git, but no token", () => {
    const runtime = { gitAvailable: () => true };
    const env = { MAGPIE_GIT_AUTHOR_NAME: "Magpie", MAGPIE_GIT_AUTHOR_EMAIL: "magpie@example.com" };
    const capabilities = deriveCapabilities(env, runtime);
    assert.ok(capabilities.includes("local-git"));
    // No token, so it is NOT a github watcher.
    assert.ok(!capabilities.includes("github"));
  });

  it("does not advertise local-git without a full author identity or without git", () => {
    const runtime = { gitAvailable: () => true };
    assert.ok(!deriveCapabilities({ MAGPIE_GIT_AUTHOR_NAME: "Magpie" }, runtime).includes("local-git"));
    assert.ok(!deriveCapabilities(
      { MAGPIE_GIT_AUTHOR_NAME: "Magpie", MAGPIE_GIT_AUTHOR_EMAIL: "magpie@example.com" },
      { gitAvailable: () => false }
    ).includes("local-git"));
  });

  it("a github watcher also advertises local-git so it can publish both destination kinds", () => {
    const capabilities = deriveCapabilities(
      {
        GITHUB_TOKEN: "tok",
        MAGPIE_GIT_AUTHOR_NAME: "Magpie",
        MAGPIE_GIT_AUTHOR_EMAIL: "magpie@example.com"
      },
      { gitAvailable: () => true }
    );
    assert.ok(capabilities.includes("github"));
    assert.ok(capabilities.includes("local-git"));
  });
});
