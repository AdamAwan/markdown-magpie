import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JSONWebKeySet } from "jose";
import { authSettingsFromEnv, createRemoteAuthVerifier, hasScopes, parseBearerToken } from "./index.js";

const issuer = "https://example.auth0.com/";
const audience = "https://markdown-magpie.local/api";

async function signedToken(
  scope: string,
  options: { audience?: string; claims?: Record<string, unknown>; expiresIn?: string | false } = {}
): Promise<{ token: string; jwks: JSONWebKeySet }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "test-key";
  const jwt = new SignJWT({ scope, ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setAudience(options.audience ?? audience)
    .setSubject("auth0|user")
    .setIssuedAt();
  if (options.expiresIn !== false) {
    jwt.setExpirationTime(options.expiresIn ?? "5m");
  }
  const token = await jwt.sign(privateKey);

  return { token, jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] } };
}

test("parseBearerToken extracts a bearer token", () => {
  assert.equal(parseBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(parseBearerToken("Basic abc"), undefined);
});

test("authSettingsFromEnv uses a stable issuer when auth is disabled and Auth0 env is absent", () => {
  const settings = authSettingsFromEnv({});

  assert.equal(settings.required, false);
  assert.equal(settings.issuer, "https://markdown-magpie.local/");
});

test("createRemoteAuthVerifier does not construct a remote JWKS URL when JWKS is injected", async () => {
  const { jwks } = await signedToken("read:knowledge");

  assert.doesNotThrow(() =>
    createRemoteAuthVerifier({
      required: true,
      issuer: "",
      audience,
      jwks: async () => jwks
    })
  );
});

test("createRemoteAuthVerifier accepts a valid scoped RS256 token", async () => {
  const { token, jwks } = await signedToken("read:knowledge ask:knowledge");
  const verifier = createRemoteAuthVerifier({
    required: true,
    issuer,
    audience,
    jwks: async () => jwks
  });

  const principal = await verifier.verify(token);

  assert.equal(principal.subject, "auth0|user");
  assert.deepEqual(principal.scopes, ["read:knowledge", "ask:knowledge"]);
  assert.equal(hasScopes(principal, ["ask:knowledge"]), true);
  assert.equal(hasScopes(principal, ["manage:admin"]), false);
});

test("createRemoteAuthVerifier rejects the wrong audience", async () => {
  const { token, jwks } = await signedToken("read:knowledge", { audience: "wrong" });
  const verifier = createRemoteAuthVerifier({
    required: true,
    issuer,
    audience,
    jwks: async () => jwks
  });

  await assert.rejects(() => verifier.verify(token), /invalid_token/);
});

test("createRemoteAuthVerifier rejects tokens missing exp", async () => {
  const { token, jwks } = await signedToken("read:knowledge", { expiresIn: false });
  const verifier = createRemoteAuthVerifier({
    required: true,
    issuer,
    audience,
    jwks: async () => jwks
  });

  await assert.rejects(() => verifier.verify(token), /invalid_token/);
});
