import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

// loadConfig validates a plain env object, so each test passes its own env map
// rather than mutating process.env.
const minimalEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/markdown_magpie",
  AI_PROVIDER: "openai-compatible"
};

function assertThrowsNaming(env: NodeJS.ProcessEnv, ...vars: string[]): Error {
  let error: Error | undefined;
  assert.throws(
    () => loadConfig(env),
    (thrown) => {
      error = thrown as Error;
      return true;
    }
  );
  assert.ok(error, "expected loadConfig to throw");
  for (const name of vars) {
    assert.ok(
      error.message.includes(name),
      `expected error message to name ${name}; got:\n${error.message}`
    );
  }
  return error;
}

describe("loadConfig — valid configs", () => {
  it("applies the documented defaults for a minimal valid env", () => {
    const config = loadConfig(minimalEnv);

    assert.equal(config.databaseUrl, minimalEnv.DATABASE_URL);
    assert.equal(config.aiProvider, "openai-compatible");
    assert.equal(config.port, 4000);
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.logStartupConfig, true);
    assert.equal(config.apiShutdownDrainMs, 10_000);
    assert.equal(config.storage.default, "memory");
    assert.deepEqual(config.storage.overrides, {});
    assert.equal(config.jobs.waitTimeoutMs, 25_000);
    assert.equal(config.jobs.waitPollMs, 250);
    assert.equal(config.jobs.runToCompletionTimeoutMs, undefined);
    assert.equal(config.jobs.scheduleTimezone, "UTC");
    assert.equal(config.watcher.activeWindowMs, 15 * 60 * 1000);
    assert.equal(config.embeddings.azureOpenAi.apiVersion, "2024-10-21");
    assert.equal(config.embeddings.timeoutMs, undefined);
    assert.equal(config.git.provider, "local");
    assert.equal(config.paths.checkoutRoot, ".magpie/checkouts");
    assert.equal(config.paths.snapshotRoot, ".magpie/snapshots");
  });

  it("treats empty strings as unset (so commented-out .env vars use defaults)", () => {
    const config = loadConfig({
      ...minimalEnv,
      OPENAI_COMPATIBLE_API_KEY: "",
      EMBEDDING_TIMEOUT_MS: "",
      MAGPIE_CHECKOUT_ROOT: "",
      GITHUB_TOKEN: ""
    });

    assert.equal(config.embeddings.openAiCompatible.apiKey, undefined);
    assert.equal(config.embeddings.timeoutMs, undefined);
    assert.equal(config.paths.checkoutRoot, ".magpie/checkouts");
    assert.equal(config.git.githubToken, undefined);
  });

  it("parses overrides for a fully-populated env", () => {
    const config = loadConfig({
      ...minimalEnv,
      PORT: "5000",
      NODE_ENV: "production",
      LOG_STARTUP_CONFIG: "false",
      STORAGE_BACKEND: "postgres",
      QUESTION_LOG_STORE: "memory",
      JOB_WAIT_TIMEOUT_MS: "30000",
      JOB_RUN_TO_COMPLETION_TIMEOUT_MS: "60000",
      JOB_SCHEDULE_TIMEZONE: "Europe/London",
      WATCHER_ACTIVE_WINDOW_MS: "60000",
      EMBEDDING_TIMEOUT_MS: "9000",
      OPENAI_COMPATIBLE_BASE_URL: "https://api.example.com/v1",
      OPENAI_COMPATIBLE_API_KEY: "sk-test",
      OPENAI_COMPATIBLE_MODEL: "gpt-test",
      AZURE_OPENAI_API_VERSION: "2025-01-01",
      GIT_PROVIDER: "github",
      GITHUB_TOKEN: "ghp_test",
      MAGPIE_CHECKOUT_ROOT: "/data/checkouts"
    });

    assert.equal(config.port, 5000);
    assert.equal(config.nodeEnv, "production");
    assert.equal(config.logStartupConfig, false);
    assert.equal(config.storage.default, "postgres");
    assert.equal(config.storage.overrides.QUESTION_LOG_STORE, "memory");
    assert.equal(config.jobs.waitTimeoutMs, 30_000);
    assert.equal(config.jobs.runToCompletionTimeoutMs, 60_000);
    assert.equal(config.jobs.scheduleTimezone, "Europe/London");
    assert.equal(config.watcher.activeWindowMs, 60_000);
    assert.equal(config.embeddings.timeoutMs, 9000);
    assert.equal(config.embeddings.openAiCompatible.baseUrl, "https://api.example.com/v1");
    assert.equal(config.embeddings.openAiCompatible.apiKey, "sk-test");
    assert.equal(config.embeddings.azureOpenAi.apiVersion, "2025-01-01");
    assert.equal(config.git.provider, "github");
    assert.equal(config.git.githubToken, "ghp_test");
    assert.equal(config.paths.checkoutRoot, "/data/checkouts");
  });

  it("accepts AUTH_REQUIRED=true when audience and a domain/issuer are present", () => {
    assert.doesNotThrow(() =>
      loadConfig({
        ...minimalEnv,
        AUTH_REQUIRED: "true",
        AUTH0_AUDIENCE: "https://markdown-magpie/api",
        AUTH0_DOMAIN: "tenant.eu.auth0.com"
      })
    );
  });
});

describe("loadConfig — rejects bad/missing config", () => {
  it("requires DATABASE_URL", () => {
    assertThrowsNaming({ AI_PROVIDER: "codex" }, "DATABASE_URL");
  });

  it("rejects a non-URL DATABASE_URL", () => {
    assertThrowsNaming({ ...minimalEnv, DATABASE_URL: "not-a-url" }, "DATABASE_URL");
  });

  it("requires AI_PROVIDER", () => {
    assertThrowsNaming({ DATABASE_URL: minimalEnv.DATABASE_URL }, "AI_PROVIDER");
  });

  it("rejects an unsupported AI_PROVIDER", () => {
    assertThrowsNaming({ ...minimalEnv, AI_PROVIDER: "mock" }, "AI_PROVIDER");
  });

  it("rejects a non-numeric timeout", () => {
    assertThrowsNaming({ ...minimalEnv, JOB_WAIT_TIMEOUT_MS: "soon" }, "JOB_WAIT_TIMEOUT_MS");
  });

  it("rejects a non-positive PORT", () => {
    assertThrowsNaming({ ...minimalEnv, PORT: "0" }, "PORT");
  });

  it("rejects a typo'd storage backend", () => {
    assertThrowsNaming({ ...minimalEnv, STORAGE_BACKEND: "postgress" }, "STORAGE_BACKEND");
  });

  it("rejects a typo'd per-store override", () => {
    assertThrowsNaming({ ...minimalEnv, KNOWLEDGE_STORE: "mem" }, "KNOWLEDGE_STORE");
  });

  it("rejects a malformed embedding base URL", () => {
    assertThrowsNaming(
      { ...minimalEnv, OPENAI_COMPATIBLE_EMBEDDING_BASE_URL: "://bad" },
      "OPENAI_COMPATIBLE_EMBEDDING_BASE_URL"
    );
  });

  it("requires the audience when AUTH_REQUIRED=true", () => {
    assertThrowsNaming(
      { ...minimalEnv, AUTH_REQUIRED: "true", AUTH0_DOMAIN: "tenant.eu.auth0.com" },
      "AUTH0_AUDIENCE"
    );
  });

  it("requires a domain or issuer when AUTH_REQUIRED=true", () => {
    assertThrowsNaming(
      { ...minimalEnv, AUTH_REQUIRED: "true", AUTH0_AUDIENCE: "https://markdown-magpie/api" },
      "AUTH0_ISSUER_BASE_URL"
    );
  });

  it("aggregates every offending var into one message", () => {
    const error = assertThrowsNaming(
      { JOB_WAIT_TIMEOUT_MS: "soon", STORAGE_BACKEND: "postgress" },
      "DATABASE_URL",
      "AI_PROVIDER",
      "JOB_WAIT_TIMEOUT_MS",
      "STORAGE_BACKEND"
    );
    // One throw, not first-failure-only.
    assert.match(error.message, /configuration/i);
  });
});
