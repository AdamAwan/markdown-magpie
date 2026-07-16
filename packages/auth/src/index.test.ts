import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JSONWebKeySet } from "jose";
import {
  authSettingsFromEnv,
  CLIENT_CREDENTIALS_GRANT_TYPE,
  createRemoteAuthVerifier,
  DEFAULT_ROLES_CLAIM,
  hasScopes,
  isAuthRequired,
  isClientCredentialsToken,
  parseBearerToken,
  rolesFromPayload
} from "./index.js";

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

test("isAuthRequired fails closed: only an explicit AUTH_REQUIRED=false disables auth", () => {
  // Required by default so a misconfiguration can never silently expose the API.
  assert.equal(isAuthRequired(undefined), true);
  assert.equal(isAuthRequired(""), true);
  assert.equal(isAuthRequired("true"), true);
  assert.equal(isAuthRequired("nonsense"), true);
  // The only opt-out, case/whitespace-insensitive.
  assert.equal(isAuthRequired("false"), false);
  assert.equal(isAuthRequired(" FALSE "), false);
});

test("authSettingsFromEnv requires auth by default and only opts out on AUTH_REQUIRED=false", () => {
  // Fail closed: an absent AUTH_REQUIRED leaves auth required.
  assert.equal(authSettingsFromEnv({}).required, true);

  const disabled = authSettingsFromEnv({ AUTH_REQUIRED: "false" });
  assert.equal(disabled.required, false);
  assert.equal(disabled.issuer, "https://markdown-magpie.local/");
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

test("verifier reads the roles claim into the principal, defaulting the claim key", async () => {
  const { token, jwks } = await signedToken("read:knowledge", {
    claims: { [DEFAULT_ROLES_CLAIM]: ["kb-hr-curators", "kb-ops"] }
  });
  const verifier = createRemoteAuthVerifier({ required: true, issuer, audience, jwks: async () => jwks });

  const principal = await verifier.verify(token);

  assert.deepEqual(principal.roles, ["kb-hr-curators", "kb-ops"]);
});

test("verifier honours a custom rolesClaim key", async () => {
  const claim = "https://example.test/roles";
  const { token, jwks } = await signedToken("read:knowledge", { claims: { [claim]: ["admin"] } });
  const verifier = createRemoteAuthVerifier({
    required: true,
    issuer,
    audience,
    rolesClaim: claim,
    jwks: async () => jwks
  });

  const principal = await verifier.verify(token);

  assert.deepEqual(principal.roles, ["admin"]);
});

test("principal.roles is undefined when the token carries no roles claim (service/M2M path)", async () => {
  const { token, jwks } = await signedToken("read:knowledge");
  const verifier = createRemoteAuthVerifier({ required: true, issuer, audience, jwks: async () => jwks });

  const principal = await verifier.verify(token);

  assert.equal(principal.roles, undefined);
});

test("isClientCredentialsToken is a POSITIVE M2M signal via the gty grant-type claim", () => {
  // Auth0 stamps client-credentials tokens with gty: "client-credentials".
  assert.equal(isClientCredentialsToken({ gty: CLIENT_CREDENTIALS_GRANT_TYPE }), true);
  // A human/interactive token has no such marker (or a different grant type).
  assert.equal(isClientCredentialsToken({}), false);
  assert.equal(isClientCredentialsToken({ gty: "authorization_code" }), false);
  // Non-string gty values are not the marker.
  assert.equal(isClientCredentialsToken({ gty: 1 }), false);
});

test("rolesFromPayload distinguishes absent, empty, and populated claims and drops non-strings", () => {
  const claim = DEFAULT_ROLES_CLAIM;
  // Absent claim -> undefined (service/legacy principal).
  assert.equal(rolesFromPayload({}, claim), undefined);
  // A non-array value is treated as absent rather than coerced.
  assert.equal(rolesFromPayload({ [claim]: "admin" }, claim), undefined);
  // An explicit empty array stays an empty array (role-aware principal, no roles).
  assert.deepEqual(rolesFromPayload({ [claim]: [] }, claim), []);
  // Non-string entries are filtered out.
  assert.deepEqual(rolesFromPayload({ [claim]: ["a", 1, null, "b"] }, claim), ["a", "b"]);
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
