import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

// loadConfig validates a plain env object, so each test passes its own env map
// rather than mutating process.env.
const minimalEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/markdown_magpie",
  AI_PROVIDER: "openai-compatible",
  // Auth fails closed by default; these baseline tests exercise non-auth config,
  // so they explicitly opt out. Auth-specific behaviour is tested separately.
  AUTH_REQUIRED: "false"
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
    // CORS defaults to allow-any-origin when unset.
    assert.equal(config.cors.allowedOrigins, "*");
    // Abstain-biased flow-router defaults.
    assert.equal(config.flowRouter.minTopScore, 0.25);
    assert.equal(config.flowRouter.minMargin, 0.05);
  });

  it("honours FLOW_ROUTER_* overrides and falls back to defaults on invalid/out-of-range values", () => {
    const overridden = loadConfig({ ...minimalEnv, FLOW_ROUTER_MIN_SCORE: "0.4", FLOW_ROUTER_MIN_MARGIN: "0.1" });
    assert.equal(overridden.flowRouter.minTopScore, 0.4);
    assert.equal(overridden.flowRouter.minMargin, 0.1);

    // Out of [0,1], non-numeric, and blank all fall back rather than failing boot —
    // a bad threshold must never take the ask path down.
    const invalid = loadConfig({ ...minimalEnv, FLOW_ROUTER_MIN_SCORE: "1.5", FLOW_ROUTER_MIN_MARGIN: "abc" });
    assert.equal(invalid.flowRouter.minTopScore, 0.25);
    assert.equal(invalid.flowRouter.minMargin, 0.05);
  });

  it("defaults AI_PRICING to an empty table and loads a valid one", () => {
    assert.deepEqual(loadConfig(minimalEnv).aiPricing, []);

    const priced = loadConfig({
      ...minimalEnv,
      AI_PRICING: JSON.stringify([{ provider: "openai-compatible", model: "gpt-4o-mini", inputPerMTok: 0.15, outputPerMTok: 0.6 }])
    });
    assert.deepEqual(priced.aiPricing, [
      { provider: "openai-compatible", model: "gpt-4o-mini", inputPerMTok: 0.15, outputPerMTok: 0.6 }
    ]);
  });

  it("fails boot on a malformed AI_PRICING instead of silently mispricing", () => {
    // Pricing is deliberately NOT a fall-back-to-default knob: a bad table
    // would quietly produce wrong monetary numbers.
    assertThrowsNaming({ ...minimalEnv, AI_PRICING: "[{bad json" }, "AI_PRICING");
    assertThrowsNaming(
      { ...minimalEnv, AI_PRICING: JSON.stringify([{ provider: "openai", model: "x", inputPerMTok: 1, outputPerMTok: 1 }]) },
      "AI_PRICING"
    );
  });

  it("defaults the gap-assignment threshold and honours a valid override", () => {
    const config = loadConfig(minimalEnv);
    assert.equal(config.gapClustering.assignThreshold, 0.84);

    const overridden = loadConfig({ ...minimalEnv, GAP_CLUSTER_ASSIGN_THRESHOLD: "0.95" });
    assert.equal(overridden.gapClustering.assignThreshold, 0.95);
  });

  it("falls back on out-of-range or non-numeric gap thresholds, including 0", () => {
    for (const bad of ["0", "-0.5", "1.5", "abc", ""]) {
      const config = loadConfig({ ...minimalEnv, GAP_CLUSTER_ASSIGN_THRESHOLD: bad });
      assert.equal(
        config.gapClustering.assignThreshold,
        0.84,
        `value ${JSON.stringify(bad)} must fall back to the default`
      );
    }
  });

  it("parses CORS_ALLOWED_ORIGINS into a trimmed allow-list", () => {
    const config = loadConfig({
      ...minimalEnv,
      CORS_ALLOWED_ORIGINS: " https://app.example , https://admin.example "
    });
    assert.deepEqual(config.cors.allowedOrigins, ["https://app.example", "https://admin.example"]);
  });

  it("treats a literal * or blank CORS_ALLOWED_ORIGINS as allow-any-origin", () => {
    assert.equal(loadConfig({ ...minimalEnv, CORS_ALLOWED_ORIGINS: "*" }).cors.allowedOrigins, "*");
    assert.equal(loadConfig({ ...minimalEnv, CORS_ALLOWED_ORIGINS: "" }).cors.allowedOrigins, "*");
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
    const config = loadConfig({
      ...minimalEnv,
      AUTH_REQUIRED: "true",
      AUTH0_AUDIENCE: "https://markdown-magpie/api",
      AUTH0_DOMAIN: "tenant.eu.auth0.com"
    });
    assert.equal(config.auth.required, true);
    assert.equal(config.auth.audience, "https://markdown-magpie/api");
    assert.equal(config.auth.issuer, "https://tenant.eu.auth0.com/");
  });

  it("applies the documented database pool defaults", () => {
    const config = loadConfig(minimalEnv);
    assert.equal(config.database.poolMax, 10);
    assert.equal(config.database.idleTimeoutMs, 30_000);
    assert.equal(config.database.connectionTimeoutMs, 10_000);
    assert.equal(config.database.statementTimeoutMs, 30_000);
  });

  it("parses database pool overrides", () => {
    const config = loadConfig({
      ...minimalEnv,
      DB_POOL_MAX: "25",
      DB_IDLE_TIMEOUT_MS: "5000",
      DB_CONNECTION_TIMEOUT_MS: "2000",
      DB_STATEMENT_TIMEOUT_MS: "15000"
    });
    assert.equal(config.database.poolMax, 25);
    assert.equal(config.database.idleTimeoutMs, 5000);
    assert.equal(config.database.connectionTimeoutMs, 2000);
    assert.equal(config.database.statementTimeoutMs, 15_000);
  });
});

describe("loadConfig — auth fails closed", () => {
  const authEnabledEnv = {
    DATABASE_URL: minimalEnv.DATABASE_URL,
    AI_PROVIDER: "codex"
  } satisfies NodeJS.ProcessEnv;

  it("requires auth when AUTH_REQUIRED is unset (fail closed)", () => {
    // Unset auth is required, so a valid audience/issuer must be present or boot
    // aborts — a misconfiguration can never silently disable auth.
    const config = loadConfig({
      ...authEnabledEnv,
      AUTH0_AUDIENCE: "https://real-tenant/api",
      AUTH0_DOMAIN: "tenant.eu.auth0.com"
    });
    assert.equal(config.auth.required, true);
  });

  it("fails startup when auth is required (unset) but Auth0 settings are missing", () => {
    assertThrowsNaming(authEnabledEnv, "AUTH0_AUDIENCE", "AUTH0_ISSUER_BASE_URL");
  });

  it("rejects the placeholder audience when auth is enabled", () => {
    const error = assertThrowsNaming(
      {
        ...authEnabledEnv,
        AUTH0_AUDIENCE: "https://markdown-magpie.local/api",
        AUTH0_DOMAIN: "tenant.eu.auth0.com"
      },
      "AUTH0_AUDIENCE"
    );
    assert.match(error.message, /placeholder/i);
  });

  it("only disables auth on an explicit AUTH_REQUIRED=false", () => {
    assert.equal(loadConfig({ ...authEnabledEnv, AUTH_REQUIRED: "false" }).auth.required, false);
    // A typo does NOT disable auth; it stays required and thus needs Auth0 config.
    assertThrowsNaming({ ...authEnabledEnv, AUTH_REQUIRED: "nope" }, "AUTH0_AUDIENCE");
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
