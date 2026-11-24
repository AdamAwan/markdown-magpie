import assert from "node:assert/strict";
import test from "node:test";
import { isAuthConfigured, resolveAuthConfig, resolveRuntimeConfig, serializeRuntimeConfig } from "./runtimeConfig";

test("serializeRuntimeConfig escapes '<' so '</script>' cannot appear literally", () => {
  const config = { apiBaseUrl: "https://example.com</script><script>alert(1)</script>" };
  const serialized = serializeRuntimeConfig(config);

  assert.ok(!serialized.includes("<"), "serialized output must not contain a literal '<'");
  assert.ok(!serialized.includes("</script>"), "serialized output must not contain a literal '</script>'");
});

test("serializeRuntimeConfig round-trips through JSON.parse to the original object", () => {
  const config = {
    apiBaseUrl: "https://example.com</script>",
    auth: { domain: "<img src=x onerror=alert(1)>", clientId: "abc", audience: "aud", redirectUri: "http://x" }
  };
  const serialized = serializeRuntimeConfig(config);

  assert.deepEqual(JSON.parse(serialized), config);
});

test("serializeRuntimeConfig escapes U+2028 and U+2029", () => {
  const config = { value: "line sep para" };
  const serialized = serializeRuntimeConfig(config);

  assert.ok(!serialized.includes(" "), "serialized output must not contain a raw U+2028");
  assert.ok(!serialized.includes(" "), "serialized output must not contain a raw U+2029");
  assert.deepEqual(JSON.parse(serialized), config);
});

test("resolveAuthConfig maps the legacy AUTH0_* names (AUTH0_DOMAIN -> https://<domain>/)", () => {
  const auth = resolveAuthConfig({
    AUTH0_DOMAIN: "tenant.eu.auth0.com",
    AUTH0_CLIENT_ID: "spa-client",
    AUTH0_AUDIENCE: "https://magpie.example/api",
    AUTH0_REDIRECT_URI: "https://magpie.example"
  });

  assert.deepEqual(auth, {
    provider: "auth0",
    issuer: "https://tenant.eu.auth0.com/",
    clientId: "spa-client",
    audience: "https://magpie.example/api",
    redirectUri: "https://magpie.example",
    apiIdUri: "api://https://magpie.example/api"
  });
  assert.equal(isAuthConfigured(auth), true);
});

test("resolveAuthConfig prefers new AUTH_* names over legacy ones, NEXT_PUBLIC_* first within a tier", () => {
  const auth = resolveAuthConfig({
    NEXT_PUBLIC_AUTH_CLIENT_ID: "build-time-client",
    AUTH_CLIENT_ID: "runtime-client",
    AUTH0_CLIENT_ID: "legacy-client",
    AUTH_ISSUER: "https://login.example.com",
    NEXT_PUBLIC_AUTH0_DOMAIN: "legacy.auth0.com",
    AUTH_AUDIENCE: "new-audience",
    NEXT_PUBLIC_AUTH0_AUDIENCE: "legacy-audience"
  });

  assert.equal(auth.clientId, "build-time-client");
  assert.equal(auth.issuer, "https://login.example.com/");
  assert.equal(auth.audience, "new-audience");
});

test("resolveAuthConfig legacy issuer order: NEXT_PUBLIC_AUTH0_DOMAIN, AUTH0_ISSUER_BASE_URL, AUTH0_DOMAIN", () => {
  assert.equal(
    resolveAuthConfig({ AUTH0_ISSUER_BASE_URL: "https://custom.example.com//", AUTH0_DOMAIN: "tenant.auth0.com" })
      .issuer,
    "https://custom.example.com/"
  );
  assert.equal(
    resolveAuthConfig({
      NEXT_PUBLIC_AUTH0_DOMAIN: "build.auth0.com",
      AUTH0_ISSUER_BASE_URL: "https://custom.example.com"
    }).issuer,
    "https://build.auth0.com/"
  );
});

test("resolveAuthConfig keeps an entra issuer verbatim and defaults apiIdUri to api://<audience>", () => {
  const auth = resolveAuthConfig({
    AUTH_PROVIDER: "entra",
    AUTH_ISSUER: "https://login.microsoftonline.com/tenant-id/v2.0",
    AUTH_CLIENT_ID: "spa-guid",
    AUTH_AUDIENCE: "api-guid"
  });

  assert.equal(auth.provider, "entra");
  assert.equal(auth.issuer, "https://login.microsoftonline.com/tenant-id/v2.0");
  assert.equal(auth.apiIdUri, "api://api-guid");
  assert.equal(auth.redirectUri, "http://localhost:3000");
});

test("resolveAuthConfig honours an explicit AUTH_API_ID_URI (trailing slash trimmed)", () => {
  const auth = resolveAuthConfig({
    AUTH_PROVIDER: "Entra",
    AUTH_AUDIENCE: "api-guid",
    NEXT_PUBLIC_AUTH_API_ID_URI: "https://magpie.example.com/api/"
  });

  assert.equal(auth.provider, "entra");
  assert.equal(auth.apiIdUri, "https://magpie.example.com/api");
});

test("resolveAuthConfig rejects an unknown AUTH_PROVIDER", () => {
  assert.throws(() => resolveAuthConfig({ AUTH_PROVIDER: "okta" }), /AUTH_PROVIDER must be "auth0" or "entra"/);
});

test("isAuthConfigured needs issuer, client id and audience", () => {
  assert.equal(isAuthConfigured(resolveAuthConfig({})), false);
  assert.equal(isAuthConfigured(resolveAuthConfig({ AUTH0_DOMAIN: "t.auth0.com", AUTH0_CLIENT_ID: "c" })), false);
});

test("resolveRuntimeConfig resolves the API and MCP URLs with their fallbacks", () => {
  const config = resolveRuntimeConfig({
    PUBLIC_API_BASE_URL: "https://api.example",
    MCP_RESOURCE_URL: "https://mcp.example/mcp"
  });

  assert.equal(config.apiBaseUrl, "https://api.example");
  assert.equal(config.mcpUrl, "https://mcp.example/mcp");
  assert.equal(
    resolveRuntimeConfig({ NEXT_PUBLIC_API_BASE_URL: "https://inline.example", PUBLIC_API_BASE_URL: "x" }).apiBaseUrl,
    "https://inline.example"
  );
});
