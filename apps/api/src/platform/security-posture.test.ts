import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { createLogger } from "@magpie/logger";
import { loadConfig } from "./config.js";
import { logSecurityPosture } from "./security-posture.js";

// Captures the JSON lines a real logger writes, so the test reads exactly what an
// operator's log pipeline would.
function capturingLogger(): { log: ReturnType<typeof createLogger>; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
  return {
    log: createLogger({ destination }),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
  };
}

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/markdown_magpie",
  AI_PROVIDER: "codex"
} satisfies NodeJS.ProcessEnv;

describe("logSecurityPosture", () => {
  it("logs auth state and warns loudly when auth is disabled, storage is in-memory and CORS is open", () => {
    const { log, lines } = capturingLogger();
    const posture = logSecurityPosture(loadConfig({ ...baseEnv, AUTH_REQUIRED: "false" }), log);

    assert.equal(posture.auth.required, false);
    assert.ok(posture.storage.memoryStores.includes("KNOWLEDGE_STORE"));
    const logged = lines();
    const info = logged.find((line) => line.msg === "API security posture");
    assert.ok(info, "the posture line is always logged");
    assert.deepEqual((info.auth as { required: boolean }).required, false);
    const warnings = logged.filter((line) => line.level === 40).map((line) => String(line.msg));
    assert.ok(warnings.some((msg) => /AUTH IS DISABLED/.test(msg)));
    assert.ok(warnings.some((msg) => /In-memory storage/.test(msg)));
    assert.ok(warnings.some((msg) => /CORS allows any origin/.test(msg)));
  });

  it("logs a secure production posture without warnings, including the issuer and audience", () => {
    const { log, lines } = capturingLogger();
    const posture = logSecurityPosture(
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        AUTH_AUDIENCE: "https://real-tenant/api",
        AUTH_ISSUER: "https://tenant.eu.auth0.com/",
        STORAGE_BACKEND: "postgres",
        CORS_ALLOWED_ORIGINS: "https://magpie.example.com"
      }),
      log
    );

    assert.deepEqual(posture.auth, {
      required: true,
      provider: "auth0",
      issuer: "https://tenant.eu.auth0.com/",
      audience: "https://real-tenant/api"
    });
    assert.deepEqual(posture.productionOverrides, []);
    assert.equal(lines().filter((line) => line.level === 40).length, 0);
  });

  it("names the production overrides in effect", () => {
    const { log, lines } = capturingLogger();
    const posture = logSecurityPosture(
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        AUTH_REQUIRED: "false",
        STORAGE_BACKEND: "postgres",
        CORS_ALLOWED_ORIGINS: "https://magpie.example.com",
        MAGPIE_ALLOW_UNAUTHENTICATED_PRODUCTION: "true"
      }),
      log
    );

    assert.deepEqual(posture.productionOverrides, ["MAGPIE_ALLOW_UNAUTHENTICATED_PRODUCTION"]);
    assert.ok(lines().some((line) => /Production safety checks overridden/.test(String(line.msg))));
  });
});
