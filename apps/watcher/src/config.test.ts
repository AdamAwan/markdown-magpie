import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadWatcherConfig } from "./config.js";

// A minimal auth-enabled environment that satisfies every production gate, so
// individual tests can omit exactly the one var they are exercising.
function validProdEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AUTH_REQUIRED: "true",
    API_BASE_URL: "https://api.magpie.example",
    WATCHER_API_CLIENT_ID: "client-id",
    WATCHER_API_CLIENT_SECRET: "client-secret",
    AUTH0_AUDIENCE: "https://api.magpie.example/api",
    AUTH0_ISSUER_BASE_URL: "https://tenant.example.auth0.com",
    ...overrides
  };
}

describe("loadWatcherConfig — dev (auth disabled)", () => {
  it("applies safe localhost defaults when nothing is set", () => {
    const config = loadWatcherConfig({ AUTH_REQUIRED: "false" });
    assert.equal(config.apiBaseUrl, "http://localhost:4000");
    assert.equal(config.watcherName, "local-dev-watcher");
    assert.equal(config.pollIntervalMs, 2000);
    assert.equal(config.auth.required, false);
    assert.equal(config.auth.staticToken, undefined);
    assert.equal(config.auth.clientId, undefined);
  });

  it("does not require API_BASE_URL or credentials when auth is disabled", () => {
    assert.doesNotThrow(() => loadWatcherConfig({ AUTH_REQUIRED: "false" }));
  });

  it("parses valid overrides", () => {
    const config = loadWatcherConfig({
      AUTH_REQUIRED: "false",
      API_BASE_URL: "http://api.local:8080",
      WATCHER_NAME: "worker-a",
      WATCHER_POLL_INTERVAL_MS: "500"
    });
    assert.equal(config.apiBaseUrl, "http://api.local:8080");
    assert.equal(config.watcherName, "worker-a");
    assert.equal(config.pollIntervalMs, 500);
  });

  it("treats blank env values as unset (falls back to defaults)", () => {
    const config = loadWatcherConfig({ AUTH_REQUIRED: "false", API_BASE_URL: "  ", WATCHER_NAME: "" });
    assert.equal(config.apiBaseUrl, "http://localhost:4000");
    assert.equal(config.watcherName, "local-dev-watcher");
  });

  it("defaults the maintenance orchestration timeout to 15 minutes", () => {
    const config = loadWatcherConfig({ AUTH_REQUIRED: "false" });
    assert.equal(config.maintenanceTimeoutMs, 15 * 60_000);
  });

  it("parses WATCHER_MAINTENANCE_TIMEOUT_MS", () => {
    const config = loadWatcherConfig({ AUTH_REQUIRED: "false", WATCHER_MAINTENANCE_TIMEOUT_MS: "600000" });
    assert.equal(config.maintenanceTimeoutMs, 600000);
  });
});

describe("loadWatcherConfig — field validation", () => {
  it("rejects a malformed API_BASE_URL", () => {
    assert.throws(() => loadWatcherConfig({ AUTH_REQUIRED: "false", API_BASE_URL: "not-a-url" }), /API_BASE_URL/);
  });

  it("rejects a non-positive-integer poll interval", () => {
    assert.throws(() => loadWatcherConfig({ AUTH_REQUIRED: "false", WATCHER_POLL_INTERVAL_MS: "0" }), /WATCHER_POLL_INTERVAL_MS/);
    assert.throws(() => loadWatcherConfig({ AUTH_REQUIRED: "false", WATCHER_POLL_INTERVAL_MS: "-5" }), /WATCHER_POLL_INTERVAL_MS/);
    assert.throws(() => loadWatcherConfig({ AUTH_REQUIRED: "false", WATCHER_POLL_INTERVAL_MS: "3.5" }), /WATCHER_POLL_INTERVAL_MS/);
    assert.throws(() => loadWatcherConfig({ AUTH_REQUIRED: "false", WATCHER_POLL_INTERVAL_MS: "nope" }), /WATCHER_POLL_INTERVAL_MS/);
  });

  it("rejects a lone client-credential half regardless of auth mode", () => {
    assert.throws(
      () => loadWatcherConfig({ AUTH_REQUIRED: "false", WATCHER_API_CLIENT_ID: "id-only" }),
      /WATCHER_API_CLIENT_SECRET/
    );
    assert.throws(
      () => loadWatcherConfig({ AUTH_REQUIRED: "false", WATCHER_API_CLIENT_SECRET: "secret-only" }),
      /WATCHER_API_CLIENT_ID/
    );
  });
});

describe("loadWatcherConfig — production (auth enabled, fail-fast)", () => {
  it("accepts a fully configured production environment", () => {
    const config = loadWatcherConfig(validProdEnv());
    assert.equal(config.apiBaseUrl, "https://api.magpie.example");
    assert.equal(config.auth.required, true);
    assert.equal(config.auth.clientId, "client-id");
    assert.equal(config.auth.tokenUrl, "https://tenant.example.auth0.com/oauth/token");
    assert.equal(config.auth.audience, "https://api.magpie.example/api");
  });

  it("defaults AUTH_REQUIRED to enabled (fails closed) when unset", () => {
    // No AUTH_REQUIRED at all → auth on → the prod gates apply.
    assert.throws(() => loadWatcherConfig({}), /API_BASE_URL/);
  });

  it("requires API_BASE_URL when auth is enabled (no silent localhost fallback)", () => {
    const env = validProdEnv();
    delete env.API_BASE_URL;
    assert.throws(() => loadWatcherConfig(env), /API_BASE_URL/);
  });

  it("requires a credential when auth is enabled", () => {
    const env = validProdEnv();
    delete env.WATCHER_API_CLIENT_ID;
    delete env.WATCHER_API_CLIENT_SECRET;
    assert.throws(() => loadWatcherConfig(env), /needs a credential/);
  });

  it("accepts a legacy static API_TOKEN in place of client credentials", () => {
    const env = validProdEnv();
    delete env.WATCHER_API_CLIENT_ID;
    delete env.WATCHER_API_CLIENT_SECRET;
    env.API_TOKEN = "static-token";
    const config = loadWatcherConfig(env);
    assert.equal(config.auth.staticToken, "static-token");
  });

  it("rejects the placeholder audience with client credentials", () => {
    assert.throws(
      () => loadWatcherConfig(validProdEnv({ AUTH0_AUDIENCE: "https://markdown-magpie.local/api" })),
      /AUTH0_AUDIENCE/
    );
  });

  it("requires an audience for the client-credentials grant", () => {
    const env = validProdEnv();
    delete env.AUTH0_AUDIENCE;
    assert.throws(() => loadWatcherConfig(env), /AUTH0_AUDIENCE/);
  });

  it("requires an issuer/domain for the client-credentials grant", () => {
    const env = validProdEnv();
    delete env.AUTH0_ISSUER_BASE_URL;
    delete env.AUTH0_DOMAIN;
    assert.throws(() => loadWatcherConfig(env), /AUTH0_ISSUER_BASE_URL/);
  });

  it("aggregates multiple errors into one message", () => {
    // Auth on, but API_BASE_URL missing AND no credential → both reported.
    let message = "";
    try {
      loadWatcherConfig({ AUTH_REQUIRED: "true" });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /API_BASE_URL/);
    assert.match(message, /needs a credential/);
  });
});
