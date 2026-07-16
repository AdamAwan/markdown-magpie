import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { makeTestContext } from "./test-support/context.js";
import { loadConfig } from "./platform/config.js";
import { buildApp } from "./app.js";

const authIssuer = "https://auth.test/";
const authAudience = "https://markdown-magpie.test/api";

interface TestAuthOptions {
  auth: {
    required: boolean;
    issuer: string;
    audience: string;
    jwks: () => Promise<JSONWebKeySet>;
  };
}

interface TestEnvAuthOptions {
  env: NodeJS.ProcessEnv;
  jwks: () => Promise<JSONWebKeySet>;
}

async function makeTestAuth(): Promise<{
  options: TestAuthOptions;
  envOptions: TestEnvAuthOptions;
  authorization: (scopes?: string[]) => Promise<string>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = "test-key";
  const jwks = {
    keys: [
      {
        ...publicJwk,
        kid,
        alg: "RS256",
        use: "sig"
      }
    ]
  } satisfies JSONWebKeySet;

  return {
    options: {
      auth: {
        required: true,
        issuer: authIssuer,
        audience: authAudience,
        jwks: async () => jwks
      }
    },
    envOptions: {
      env: {
        AUTH_REQUIRED: "true",
        AUTH0_ISSUER_BASE_URL: authIssuer,
        AUTH0_AUDIENCE: authAudience
      },
      jwks: async () => jwks
    },
    authorization: async (scopes = []) => {
      const token = await new SignJWT({ scope: scopes.join(" ") })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject("test-user")
        .setIssuer(authIssuer)
        .setAudience(authAudience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return `Bearer ${token}`;
    }
  };
}

test("GET /api/health returns ok", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "markdown-magpie-api" });
});

test("GET /api/ready reports 503 until the broker has started", async () => {
  // makeTestContext's broker has no pool and has not been started yet.
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/ready");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ready: boolean; checks: { database: boolean; broker: boolean } };
  assert.equal(body.ready, false);
  assert.equal(body.checks.broker, false);
  // No pool => no Postgres dependency to verify, so the DB check is trivially ok.
  assert.equal(body.checks.database, true);
});

test("GET /api/ready reports 200 once the broker is started", async () => {
  const ctx = makeTestContext();
  await ctx.jobs.start();
  const app = buildApp(ctx);
  const res = await app.request("/api/ready");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ready: boolean; checks: { database: boolean; broker: boolean } };
  assert.deepEqual(body, { ready: true, checks: { database: true, broker: true } });
});

test("GET /api/ready is public even when auth is required", async () => {
  const auth = await makeTestAuth();
  const ctx = makeTestContext();
  await ctx.jobs.start();
  const app = buildApp(ctx, auth.options);
  const res = await app.request("/api/ready");
  assert.equal(res.status, 200);
});

test("GET /api/version is public and returns the build info shape", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/version");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sha: unknown; commitMessage: unknown; committedAt: unknown };
  assert.ok("sha" in body);
  assert.ok("commitMessage" in body);
  assert.ok("committedAt" in body);
});

test("auth required leaves version public alongside health", async () => {
  const auth = await makeTestAuth();
  const app = buildApp(makeTestContext(), auth.options);

  const res = await app.request("/api/version");
  assert.equal(res.status, 200);
});

test("auth required leaves health public and rejects missing token on API routes", async () => {
  const auth = await makeTestAuth();
  const app = buildApp(makeTestContext(), auth.options);

  const health = await app.request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "markdown-magpie-api" });

  const stats = await app.request("/api/knowledge/stats");
  assert.equal(stats.status, 401);
  assert.deepEqual(await stats.json(), { error: "unauthorized" });
});

test("auth required rejects valid tokens missing route scopes", async () => {
  const auth = await makeTestAuth();
  const app = buildApp(makeTestContext(), auth.options);

  const res = await app.request("/api/knowledge/stats", {
    headers: { authorization: await auth.authorization(["ask:knowledge"]) }
  });

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
});

test("auth required rejects drafting a proposal from a cluster without manage:knowledge", async () => {
  const auth = await makeTestAuth();
  const app = buildApp(makeTestContext(), auth.options);

  // A read-only principal must not be able to enqueue AI drafting work; this
  // route is a proposal-writing action and requires manage:knowledge like its
  // siblings under /api/proposals.
  const res = await app.request("/api/gaps/clusters/abc/proposal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await auth.authorization(["read:knowledge"])
    },
    body: JSON.stringify({})
  });

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
});

test("auth required from environment rejects missing token without explicit auth options", async () => {
  const auth = await makeTestAuth();
  const app = buildApp(makeTestContext(), auth.envOptions);

  const res = await app.request("/api/knowledge/stats");

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("auth required allows valid tokens with route scopes to reach handlers", async () => {
  const auth = await makeTestAuth();
  const app = buildApp(makeTestContext(), auth.options);

  const res = await app.request("/api/knowledge/stats", {
    headers: { authorization: await auth.authorization(["read:knowledge"]) }
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { documentCount: number; repositoryCount: number; sectionCount: number };
  assert.equal(body.documentCount, 0);
  assert.equal(body.repositoryCount, 0);
  assert.equal(body.sectionCount, 0);
});

test("POST /api/ask with empty question returns 400 question_required", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "" })
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "question_required" });
});

test("unknown route returns not_found", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("the retired /crunch route is gone", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/crunch/runs");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("GET /api/maintenance-runs lists recorded runs", async () => {
  const ctx = makeTestContext();
  await ctx.stores.maintenanceRuns.record({
    taskType: "correctness_patrol",
    trigger: "scheduled",
    status: "completed",
    summary: "checked 1/1 doc · 0 findings",
    details: {}
  });
  const app = buildApp(ctx);
  const res = await app.request("/api/maintenance-runs");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { runs: Array<{ taskType: string; summary: string }> };
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].taskType, "correctness_patrol");
});

test("OPTIONS preflight returns 204", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/ask", { method: "OPTIONS" });
  assert.equal(res.status, 204);
});

test("CORS defaults to allow-any-origin", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/health", {
    headers: { origin: "https://anything.example" }
  });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

function contextWithAllowedOrigins(origins: string): ReturnType<typeof makeTestContext> {
  const settings = loadConfig({
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/markdown_magpie",
    AI_PROVIDER: "codex",
    AUTH_REQUIRED: "false",
    CORS_ALLOWED_ORIGINS: origins
  });
  return makeTestContext({ settings });
}

test("CORS restricts to the configured allow-list", async () => {
  const app = buildApp(contextWithAllowedOrigins("https://app.example, https://admin.example"));

  const allowed = await app.request("/api/health", {
    headers: { origin: "https://app.example" }
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example");

  const denied = await app.request("/api/health", {
    headers: { origin: "https://evil.example" }
  });
  assert.notEqual(denied.headers.get("access-control-allow-origin"), "https://evil.example");
});

test("responses carry standard security headers", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/health");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.ok(res.headers.get("strict-transport-security"));
});

test("GET /api/proposals returns an empty list", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/proposals");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { proposals: [] });
});

test("POST /api/jobs with a bad type returns 400 invalid_job", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "not_a_real_type" })
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_job" });
});

test("GET /api/questions/bogus returns 404 question_not_found", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/questions/bogus");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "question_not_found" });
});

test("POST /api/knowledge/repositories/index rejects a localPath that escapes the allow-root", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/knowledge/repositories/index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ localPath: "../../../../../../etc" })
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "local_path_outside_root");
});

test("GET /api/prompts returns the catalog", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/prompts");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { prompts: Array<Record<string, unknown>> };
  assert.equal(body.prompts.length, 21);
  for (const prompt of body.prompts) {
    assert.equal(typeof prompt.id, "string");
    assert.equal(typeof prompt.title, "string");
    assert.equal(typeof prompt.description, "string");
    assert.equal(typeof prompt.outputShape, "string");
    assert.equal(typeof prompt.instructions, "string");
    assert.ok(Array.isArray(prompt.usedBy));
  }
});
