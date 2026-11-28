import assert from "node:assert/strict";
import test from "node:test";
import { buildContentSecurityPolicy, createNonce } from "./csp";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values];
    })
  );
}

test("scripts need the request nonce; no inline or cross-origin script is allowed", () => {
  const policy = directives(buildContentSecurityPolicy({ nonce: "abc123", development: false, env: {} }));
  assert.deepEqual(policy.get("script-src"), ["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
  assert.ok(!policy.get("script-src")?.includes("'unsafe-inline'"));
  assert.ok(!policy.get("script-src")?.includes("'unsafe-eval'"), "no eval in production");
  assert.deepEqual(policy.get("object-src"), ["'none'"]);
  assert.deepEqual(policy.get("base-uri"), ["'self'"]);
  assert.deepEqual(policy.get("frame-ancestors"), ["'self'"]);
});

test("connect-src allows the configured API and the Auth0 issuer origins", () => {
  const policy = directives(
    buildContentSecurityPolicy({
      nonce: "n",
      development: false,
      env: {
        NEXT_PUBLIC_API_BASE_URL: "https://api.magpie.example.com/api",
        AUTH0_DOMAIN: "tenant.eu.auth0.com"
      }
    })
  );
  assert.deepEqual(policy.get("connect-src"), [
    "'self'",
    "https://api.magpie.example.com",
    "https://tenant.eu.auth0.com"
  ]);
  assert.deepEqual(policy.get("frame-src"), ["https://tenant.eu.auth0.com"]);
});

test("connect-src allows the Entra authority origin, and a same-origin API adds nothing", () => {
  const policy = directives(
    buildContentSecurityPolicy({
      nonce: "n",
      development: false,
      env: {
        AUTH_PROVIDER: "entra",
        AUTH_ISSUER: "https://login.microsoftonline.com/0000-tenant/v2.0",
        PUBLIC_API_BASE_URL: ""
      }
    })
  );
  assert.deepEqual(policy.get("connect-src"), ["'self'", "https://login.microsoftonline.com"]);
});

test("with no identity provider configured nothing may be framed", () => {
  const policy = directives(buildContentSecurityPolicy({ nonce: "n", development: false, env: {} }));
  assert.deepEqual(policy.get("frame-src"), ["'none'"]);
  assert.deepEqual(policy.get("connect-src"), ["'self'"]);
});

test("development adds eval (React dev tooling) and the dev server websocket only", () => {
  const policy = directives(buildContentSecurityPolicy({ nonce: "n", development: true, env: {} }));
  assert.ok(policy.get("script-src")?.includes("'unsafe-eval'"));
  assert.ok(policy.get("connect-src")?.includes("ws:"));
});

test("createNonce returns a fresh 128-bit base64 value each call", () => {
  const first = createNonce();
  assert.match(first, /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(createNonce(), first);
});
