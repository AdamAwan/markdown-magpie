import { test } from "node:test";
import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import { AddressInfo } from "node:net";
import type { Express } from "express";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { createHttpMcpApp, type HttpMcpOptions } from "./http.js";

const authIssuer = "https://example.auth0.com/";
const authAudience = "https://markdown-magpie.local/api";
const resourceUrl = "https://mcp-magpie.wastedcake.com/mcp";

interface HttpResponse {
  status: number;
  header: Record<string, string>;
  body: unknown;
  text: string;
}

// Minimal supertest-style helper over node:http so the suite has no extra
// runtime dependency. Boots the Express app on an ephemeral port per request
// chain and tears it down afterwards.
function request(app: Express) {
  function send(method: string, path: string, payload?: unknown, authorization?: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const server: Server = app.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        const body = payload === undefined ? undefined : JSON.stringify(payload);
        const headers: Record<string, string> = { host: "127.0.0.1" };
        if (body !== undefined) {
          headers["content-type"] = "application/json";
        }
        if (authorization !== undefined) {
          headers.authorization = authorization;
        }

        const req = createRequest(port, method, path, headers, (res) => {
          server.close();
          resolve(res);
        }, (err) => {
          server.close();
          reject(err);
        });

        if (body !== undefined) {
          req.write(body);
        }
        req.end();
      });
    });
  }

  return {
    get: (path: string, authorization?: string) => send("GET", path, undefined, authorization),
    post: (path: string) => {
      let authorization: string | undefined;
      const chain = {
        set(_name: string, value: string) {
          authorization = value;
          return chain;
        },
        send(payload: unknown) {
          return send("POST", path, payload, authorization);
        }
      };
      return chain;
    }
  };
}

function createRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  onResponse: (res: HttpResponse) => void,
  onError: (err: Error) => void
) {
  const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const header: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        header[key] = Array.isArray(value) ? value.join(", ") : (value ?? "");
      }
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      onResponse({ status: res.statusCode ?? 0, header, body, text });
    });
  });
  req.on("error", onError);
  return req;
}

async function makeTestAuth(): Promise<{
  jwks: () => Promise<JSONWebKeySet>;
  token: (scopes?: string[]) => Promise<string>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = "test-key";
  const jwks = {
    keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }]
  } satisfies JSONWebKeySet;

  return {
    jwks: async () => jwks,
    token: async (scopes = []) => {
      const jwt = await new SignJWT({ scope: scopes.join(" ") })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject("test-user")
        .setIssuer(authIssuer)
        .setAudience(authAudience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return `Bearer ${jwt}`;
    }
  };
}

function testOptions(overrides: Partial<HttpMcpOptions> = {}): HttpMcpOptions {
  return {
    auth: { required: true, issuer: authIssuer, audience: authAudience },
    resourceUrl,
    apiToken: "service-token",
    ...overrides
  };
}

test("protected-resource metadata exposes the auth0 issuer", async () => {
  const app = createHttpMcpApp({
    auth: { required: true, issuer: authIssuer, audience: authAudience },
    resourceUrl,
    apiToken: "service-token"
  });
  const res = await request(app).get("/.well-known/oauth-protected-resource");
  assert.equal(res.status, 200);
  const body = res.body as { authorization_servers: string[] };
  assert.deepEqual(body.authorization_servers, [authIssuer]);
});

test("protected-resource metadata is also served under /mcp suffix", async () => {
  const app = createHttpMcpApp(testOptions());
  const res = await request(app).get("/.well-known/oauth-protected-resource/mcp");
  assert.equal(res.status, 200);
  const body = res.body as { resource: string; scopes_supported: string[] };
  assert.equal(body.resource, resourceUrl);
  assert.deepEqual(body.scopes_supported, ["read:knowledge", "ask:knowledge", "feedback:questions"]);
});

test("/mcp without a bearer token returns a discovery challenge", async () => {
  const app = createHttpMcpApp(testOptions());
  const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(res.status, 401);
  assert.match(res.header["www-authenticate"], /resource_metadata=/);
});

test("the discovery challenge points at the resource origin metadata url", async () => {
  const app = createHttpMcpApp(testOptions());
  const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.match(
    res.header["www-authenticate"],
    /resource_metadata="https:\/\/mcp-magpie\.wastedcake\.com\/\.well-known\/oauth-protected-resource"/
  );
});

test("/mcp with an invalid bearer token returns a discovery challenge", async () => {
  const auth = await makeTestAuth();
  const app = createHttpMcpApp(testOptions({ auth: { required: true, issuer: authIssuer, audience: authAudience, jwks: auth.jwks } }));
  const res = await request(app)
    .post("/mcp")
    .set("authorization", "Bearer not-a-real-token")
    .send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(res.status, 401);
  assert.match(res.header["www-authenticate"], /resource_metadata=/);
});

test("tools/call kb.search requires read:knowledge scope", async () => {
  const auth = await makeTestAuth();
  const app = createHttpMcpApp(testOptions({ auth: { required: true, issuer: authIssuer, audience: authAudience, jwks: auth.jwks } }));
  const res = await request(app)
    .post("/mcp")
    .set("authorization", await auth.token(["ask:knowledge"]))
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb.search", arguments: { query: "hi" } } });
  assert.equal(res.status, 403);
});

test("tools/call kb.ask requires ask:knowledge scope", async () => {
  const auth = await makeTestAuth();
  const app = createHttpMcpApp(testOptions({ auth: { required: true, issuer: authIssuer, audience: authAudience, jwks: auth.jwks } }));
  const res = await request(app)
    .post("/mcp")
    .set("authorization", await auth.token(["read:knowledge"]))
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb.ask", arguments: { question: "hi" } } });
  assert.equal(res.status, 403);
});

test("tools/call kb.feedback requires feedback:questions scope", async () => {
  const auth = await makeTestAuth();
  const app = createHttpMcpApp(testOptions({ auth: { required: true, issuer: authIssuer, audience: authAudience, jwks: auth.jwks } }));
  const res = await request(app)
    .post("/mcp")
    .set("authorization", await auth.token(["read:knowledge"]))
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb.feedback", arguments: { questionId: "q", kind: "helpful" } } });
  assert.equal(res.status, 403);
});

test("a valid token with the right scope passes the MCP boundary (reaches transport)", async () => {
  const auth = await makeTestAuth();
  const app = createHttpMcpApp(testOptions({ auth: { required: true, issuer: authIssuer, audience: authAudience, jwks: auth.jwks } }));
  // tools/list needs only a valid token (no per-tool scope); it should pass the
  // auth boundary and be handled by the MCP transport (status < 401).
  const res = await request(app)
    .post("/mcp")
    .set("authorization", await auth.token(["read:knowledge"]))
    .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});

test("auth disabled lets /mcp through without a token", async () => {
  const app = createHttpMcpApp({
    auth: { required: false, issuer: authIssuer, audience: authAudience },
    resourceUrl,
    apiToken: undefined
  });
  const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});
