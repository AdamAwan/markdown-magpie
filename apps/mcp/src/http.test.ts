import { test } from "node:test";
import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import { AddressInfo } from "node:net";
import type { Express } from "express";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { createHttpMcpApp, mcpAuthSettingsFromEnv, type HttpMcpOptions } from "./http.js";

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
  function send(method: string, path: string, payload?: unknown, extraHeaders?: Record<string, string>): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const server: Server = app.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        const body = payload === undefined ? undefined : JSON.stringify(payload);
        const headers: Record<string, string> = { host: "127.0.0.1" };
        if (body !== undefined) {
          headers["content-type"] = "application/json";
        }
        if (extraHeaders) {
          Object.assign(headers, extraHeaders);
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
    get: (path: string, authorization?: string) =>
      send("GET", path, undefined, authorization === undefined ? undefined : { authorization }),
    post: (path: string) => {
      const extraHeaders: Record<string, string> = {};
      const chain = {
        set(name: string, value: string) {
          // Existing tests call .set("authorization", ...); generalising to any
          // header lets newer tests add the Accept header the transport needs.
          extraHeaders[name] = value;
          return chain;
        },
        send(payload: unknown) {
          return send("POST", path, payload, extraHeaders);
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
      let body: unknown;
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
  token: (scopes?: string[], audience?: string) => Promise<string>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = "test-key";
  const jwks = {
    keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }]
  } satisfies JSONWebKeySet;

  return {
    jwks: async () => jwks,
    token: async (scopes = [], audience = authAudience) => {
      const jwt = await new SignJWT({ scope: scopes.join(" ") })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject("test-user")
        .setIssuer(authIssuer)
        .setAudience(audience)
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

test("a valid scoped tools/call dispatches and calls the API with the service token (not the user token)", async () => {
  const auth = await makeTestAuth();
  // A user token that is unmistakably distinct from the configured service
  // token, so a downstream leak of the inbound bearer would be obvious.
  const userScopedToken = await auth.token(["read:knowledge"]);
  const serviceToken = "service-token-distinct-from-user";

  // Capture the outbound API request and return a minimal valid search payload
  // so the kb.search tool dispatches end-to-end through the transport. kb.search
  // is the simplest tool: a single GET via getJson, no answer-polling loop.
  const originalFetch = globalThis.fetch;
  let captured: { url: string; authorization: string | null } | undefined;
  const fetchStub: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    captured = { url, authorization: headers.get("authorization") };
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  globalThis.fetch = fetchStub;

  try {
    const app = createHttpMcpApp(
      testOptions({
        auth: { required: true, issuer: authIssuer, audience: authAudience, jwks: auth.jwks },
        apiToken: serviceToken
      })
    );
    const res = await request(app)
      .post("/mcp")
      .set("authorization", userScopedToken)
      // The Streamable HTTP transport requires the client to accept both content
      // types on POST; without this it rejects with 406 before dispatching.
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb.search", arguments: { query: "hi" } } });

    // The tool passed auth/scope and was dispatched (not gated).
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 200);

    // The tool actually ran: the stubbed downstream fetch was invoked.
    assert.ok(captured, "expected the kb.search tool to call the downstream API");
    assert.match(captured.url, /\/api\/knowledge\/search\?q=hi/);

    // The downstream call carries the configured service token, never the
    // inbound user token.
    assert.equal(captured.authorization, `Bearer ${serviceToken}`);
    // The inbound user token must not leak downstream. userScopedToken is the
    // full "Bearer <jwt>" the client sent; assert no substring of it appears.
    const userJwt = userScopedToken.replace(/^Bearer /, "");
    assert.ok(
      captured.authorization !== null && !captured.authorization.includes(userJwt),
      "inbound user token must not be forwarded downstream"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("with token exchange enabled, the API is called as the user (exchanged token, not service or raw user token)", async () => {
  const auth = await makeTestAuth();
  const userScopedToken = await auth.token(["read:knowledge"]);
  const userJwt = userScopedToken.replace(/^Bearer /, "");
  const serviceToken = "service-token-distinct";
  const exchangedToken = "exchanged-api-token-for-user";
  const tokenUrl = `${authIssuer}oauth/token`;

  const originalFetch = globalThis.fetch;
  let exchangeBody: URLSearchParams | undefined;
  let captured: { url: string; authorization: string | null } | undefined;
  const fetchStub: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url === tokenUrl) {
      // The RFC 8693 exchange: verify it forwards the user's token as the subject.
      exchangeBody = new URLSearchParams(init?.body as string);
      return new Response(JSON.stringify({ access_token: exchangedToken, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    captured = { url, authorization: headers.get("authorization") };
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  globalThis.fetch = fetchStub;

  try {
    const app = createHttpMcpApp(
      testOptions({
        auth: { required: true, issuer: authIssuer, audience: authAudience, jwks: auth.jwks },
        apiToken: serviceToken,
        apiClientId: "mcp-client",
        apiClientSecret: "mcp-secret",
        apiTokenUrl: tokenUrl,
        apiAudience: "https://magpie.wastedcake.com",
        userTokenExchange: true
      })
    );
    const res = await request(app)
      .post("/mcp")
      .set("authorization", userScopedToken)
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb.search", arguments: { query: "hi" } } });

    assert.equal(res.status, 200);
    // The exchange happened with the user's token as the subject.
    assert.equal(exchangeBody?.get("subject_token"), userJwt);
    assert.equal(exchangeBody?.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
    // The downstream API call carries the EXCHANGED token — acting as the user.
    assert.ok(captured, "expected the kb.search tool to call the downstream API");
    assert.equal(captured.authorization, `Bearer ${exchangedToken}`);
    // Neither the raw inbound user token nor the M2M service token is used downstream.
    assert.ok(captured.authorization !== null && !captured.authorization.includes(userJwt));
    assert.notEqual(captured.authorization, `Bearer ${serviceToken}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a token whose aud is the MCP resource url is accepted (MCP audience, not the web API audience)", async () => {
  const auth = await makeTestAuth();
  // The server is configured with the /mcp URL as its audience, exactly as
  // mcpAuthSettingsFromEnv resolves it in production.
  const app = createHttpMcpApp(
    testOptions({ auth: { required: true, issuer: authIssuer, audience: resourceUrl, jwks: auth.jwks } })
  );
  const res = await request(app)
    .post("/mcp")
    .set("authorization", await auth.token(["read:knowledge"], resourceUrl))
    .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  // Passed the auth boundary: an MCP-audience token is honoured.
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});

test("a token minted for the web API audience is rejected by the MCP server", async () => {
  const auth = await makeTestAuth();
  const app = createHttpMcpApp(
    testOptions({ auth: { required: true, issuer: authIssuer, audience: resourceUrl, jwks: auth.jwks } })
  );
  // This is the exact bug class: a token whose aud is the WEB API audience must
  // not be accepted by the MCP server, even though it is otherwise valid.
  const res = await request(app)
    .post("/mcp")
    .set("authorization", await auth.token(["read:knowledge"], authAudience))
    .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(res.status, 401);
});

test("mcpAuthSettingsFromEnv validates against the MCP resource url, not the web API audience", () => {
  const env: NodeJS.ProcessEnv = {
    AUTH_REQUIRED: "true",
    AUTH0_DOMAIN: "wastedcake.eu.auth0.com",
    AUTH0_AUDIENCE: "https://magpie.wastedcake.com",
    MCP_RESOURCE_URL: "https://mcp-magpie.wastedcake.com/mcp"
  };
  const settings = mcpAuthSettingsFromEnv(env, "https://mcp-magpie.wastedcake.com/mcp");
  assert.equal(settings.audience, "https://mcp-magpie.wastedcake.com/mcp");
  assert.notEqual(settings.audience, "https://magpie.wastedcake.com");
  assert.equal(settings.required, true);
  assert.equal(settings.issuer, "https://wastedcake.eu.auth0.com/");
});

test("MCP_AUDIENCE overrides the resource url when explicitly set", () => {
  const env: NodeJS.ProcessEnv = {
    MCP_RESOURCE_URL: "https://mcp-magpie.wastedcake.com/mcp",
    MCP_AUDIENCE: "https://custom.example/audience"
  };
  const settings = mcpAuthSettingsFromEnv(env, "https://mcp-magpie.wastedcake.com/mcp");
  assert.equal(settings.audience, "https://custom.example/audience");
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
