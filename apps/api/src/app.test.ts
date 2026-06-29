import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { makeTestContext } from "./test-support/context.js";
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
  assert.equal(body.prompts.length, 17);
  for (const prompt of body.prompts) {
    assert.equal(typeof prompt.id, "string");
    assert.equal(typeof prompt.title, "string");
    assert.equal(typeof prompt.description, "string");
    assert.equal(typeof prompt.outputShape, "string");
    assert.equal(typeof prompt.instructions, "string");
    assert.ok(Array.isArray(prompt.usedBy));
  }
});
