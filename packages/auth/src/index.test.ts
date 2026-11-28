import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JSONWebKeySet } from "jose";
import {
  authEnvIssues,
  authSettingsFromEnv,
  CLIENT_CREDENTIALS_GRANT_TYPE,
  createRemoteAuthVerifier,
  DEFAULT_ROLES_CLAIM,
  hasScopes,
  isAuthRequired,
  isClientCredentialsToken,
  parseAuthProvider,
  parseBearerToken,
  providerProfile,
  rolesFromPayload
} from "./index.js";

const issuer = "https://example.auth0.com/";
const audience = "https://markdown-magpie.local/api";

async function signedToken(
  scope: string,
  options: {
    audience?: string;
    issuer?: string;
    subject?: string;
    claims?: Record<string, unknown>;
    expiresIn?: string | false;
  } = {}
): Promise<{ token: string; jwks: JSONWebKeySet }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "test-key";
  const jwt = new SignJWT({ ...(scope ? { scope } : {}), ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setSubject(options.subject ?? "auth0|user")
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

test("authSettingsFromEnv keeps today's Auth0 behaviour from the legacy env names alone", () => {
  const settings = authSettingsFromEnv({
    AUTH0_DOMAIN: "tenant.eu.auth0.com",
    AUTH0_AUDIENCE: "https://magpie.example/api"
  });
  assert.equal(settings.provider, "auth0");
  assert.equal(settings.issuer, "https://tenant.eu.auth0.com/");
  assert.equal(settings.audience, "https://magpie.example/api");
  assert.equal(settings.jwksUri, "https://tenant.eu.auth0.com/.well-known/jwks.json");
  assert.equal(settings.tokenUrl, "https://tenant.eu.auth0.com/oauth/token");
  assert.equal(settings.rolesClaim, DEFAULT_ROLES_CLAIM);
  assert.equal(settings.apiIdUri, undefined);

  // AUTH0_ISSUER_BASE_URL wins over AUTH0_DOMAIN and is normalised to one trailing slash.
  const viaIssuer = authSettingsFromEnv({
    AUTH0_ISSUER_BASE_URL: "https://custom.example.com//",
    AUTH0_DOMAIN: "ignored.auth0.com",
    AUTH0_JWKS_URI: "https://keys.example.com/jwks.json"
  });
  assert.equal(viaIssuer.issuer, "https://custom.example.com/");
  assert.equal(viaIssuer.jwksUri, "https://keys.example.com/jwks.json");
});

test("authSettingsFromEnv prefers the generic AUTH_* names over the legacy ones", () => {
  const settings = authSettingsFromEnv({
    AUTH_ISSUER: "https://new.example.com",
    AUTH0_ISSUER_BASE_URL: "https://old.example.com",
    AUTH_AUDIENCE: "https://new.example/api",
    AUTH0_AUDIENCE: "https://old.example/api",
    AUTH_JWKS_URI: "https://new.example.com/keys",
    AUTH0_JWKS_URI: "https://old.example.com/keys",
    AUTH_TOKEN_URL: "https://new.example.com/token"
  });
  assert.equal(settings.issuer, "https://new.example.com/");
  assert.equal(settings.audience, "https://new.example/api");
  assert.equal(settings.jwksUri, "https://new.example.com/keys");
  assert.equal(settings.tokenUrl, "https://new.example.com/token");
});

test("authSettingsFromEnv for entra keeps the issuer verbatim and derives Entra endpoints", () => {
  const tenantIssuer = "https://login.microsoftonline.com/tenant-id/v2.0";
  const settings = authSettingsFromEnv({
    AUTH_PROVIDER: "entra",
    AUTH_ISSUER: tenantIssuer,
    AUTH_AUDIENCE: "api-client-guid"
  });
  assert.equal(settings.provider, "entra");
  assert.equal(settings.issuer, tenantIssuer, "no trailing slash may be added to an Entra issuer");
  assert.equal(settings.jwksUri, "https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys");
  assert.equal(settings.tokenUrl, "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token");
  assert.equal(settings.rolesClaim, "roles");
  assert.equal(settings.apiIdUri, "api://api-client-guid");

  const overridden = authSettingsFromEnv({
    AUTH_PROVIDER: "Entra",
    AUTH_ISSUER: tenantIssuer,
    AUTH_AUDIENCE: "api-client-guid",
    AUTH_API_ID_URI: "api://magpie.example.com"
  });
  assert.equal(overridden.provider, "entra");
  assert.equal(overridden.apiIdUri, "api://magpie.example.com");
});

test("MCP authorization server default: auth0 advertises the issuer, entra the versioned oauth21 identifier", () => {
  assert.equal(providerProfile("auth0").defaultMcpAuthorizationServer("https://t.auth0.com/"), "https://t.auth0.com/");
  assert.equal(
    providerProfile(undefined).defaultMcpAuthorizationServer("https://t.auth0.com/"),
    "https://t.auth0.com/"
  );
  const entra = providerProfile("entra");
  assert.equal(
    entra.defaultMcpAuthorizationServer("https://login.microsoftonline.com/tenant-id/v2.0"),
    "https://login.microsoftonline.com/tenant-id/oauth21/2026-08"
  );
  // Tolerates an issuer configured with a trailing slash.
  assert.equal(
    entra.defaultMcpAuthorizationServer("https://login.microsoftonline.com/tenant-id/v2.0/"),
    "https://login.microsoftonline.com/tenant-id/oauth21/2026-08"
  );
});

test("only Auth0 user-token scopes are per-user; Entra delegated scopes reach every user (AZ27)", () => {
  assert.equal(providerProfile("auth0").perUserScopes, true);
  assert.equal(providerProfile(undefined).perUserScopes, true);
  assert.equal(providerProfile("entra").perUserScopes, false);
});

test("MCP advertised scopes: auth0 short names, entra qualified with the MCP Application ID URI", () => {
  const idUri = "https://mcp.contoso.com/mcp";
  assert.equal(providerProfile("auth0").advertisedMcpScope("read:knowledge", idUri), "read:knowledge");
  assert.equal(
    providerProfile("entra").advertisedMcpScope("read:knowledge", idUri),
    "https://mcp.contoso.com/mcp/read:knowledge"
  );
});

test("MCP resource issues: none for auth0; entra needs issuer, MCP_AUDIENCE and an Application-ID-URI-shaped URL", () => {
  const url = "https://mcp.contoso.com/mcp";
  const ok = { resourceUrl: url, resourceIdUri: url, audienceConfigured: true, issuerConfigured: true };
  const localhost = "http://localhost:4001/mcp";
  assert.deepEqual(
    providerProfile("auth0").mcpResourceIssues({
      resourceUrl: localhost,
      resourceIdUri: localhost,
      audienceConfigured: false,
      issuerConfigured: false
    }),
    []
  );
  const entra = providerProfile("entra");
  const first = (overrides: Partial<typeof ok>): string => entra.mcpResourceIssues({ ...ok, ...overrides })[0] ?? "";
  assert.deepEqual(entra.mcpResourceIssues(ok), []);
  assert.equal(entra.mcpResourceIssues({ ...ok, audienceConfigured: false }).length, 1);
  assert.match(first({ audienceConfigured: false }), /MCP_AUDIENCE/);
  assert.match(first({ issuerConfigured: false }), /AUTH_ISSUER/);
  assert.match(first({ resourceUrl: localhost, resourceIdUri: localhost }), /https/);
  assert.match(first({ resourceUrl: `${url}/`, resourceIdUri: `${url}/` }), /MCP_RESOURCE_URL .* trailing slash/);
  assert.match(
    first({ resourceUrl: "https://mcp.contoso.com/", resourceIdUri: "https://mcp.contoso.com/" }),
    /non-empty path/
  );
  assert.match(first({ resourceUrl: "not a url", resourceIdUri: "not a url" }), /valid URL/);
  assert.match(first({ resourceIdUri: "api://mcp/" }), /MCP_API_ID_URI .* trailing slash/);
  assert.match(first({ resourceIdUri: 'api://m"cp' }), /MCP_API_ID_URI .* quotes/);
  assert.match(first({ resourceIdUri: "api://m cp" }), /whitespace/);
});

test("an unrecognised AUTH_PROVIDER is a configuration error", () => {
  assert.equal(parseAuthProvider(undefined), "auth0");
  assert.equal(parseAuthProvider(" "), "auth0");
  assert.equal(parseAuthProvider("ENTRA"), "entra");
  assert.equal(parseAuthProvider("okta"), undefined);
  assert.throws(() => authSettingsFromEnv({ AUTH_PROVIDER: "okta" }), /AUTH_PROVIDER/);
  assert.deepEqual(
    authEnvIssues({ AUTH_PROVIDER: "okta" }, { requireEndpoints: false, context: "x" }).map((i) => i.variable),
    ["AUTH_PROVIDER"]
  );
});

test("authEnvIssues accepts either the generic or the legacy names", () => {
  const opts = { requireEndpoints: true, context: "when auth is enabled" };
  assert.deepEqual(authEnvIssues({ AUTH0_DOMAIN: "t.auth0.com", AUTH0_AUDIENCE: "https://a/api" }, opts), []);
  assert.deepEqual(
    authEnvIssues({ AUTH_PROVIDER: "entra", AUTH_ISSUER: "https://i/v2.0", AUTH_AUDIENCE: "guid" }, opts),
    []
  );
  const missing = authEnvIssues({}, opts);
  assert.deepEqual(
    missing.map((i) => i.variable),
    ["AUTH_AUDIENCE", "AUTH_ISSUER"]
  );
  assert.match(missing[0]?.message ?? "", /AUTH0_AUDIENCE/);
  assert.match(missing[1]?.message ?? "", /AUTH0_ISSUER_BASE_URL/);
  const placeholder = authEnvIssues(
    { AUTH_AUDIENCE: "https://markdown-magpie.local/api", AUTH_ISSUER: "https://i" },
    opts
  );
  assert.match(placeholder[0]?.message ?? "", /placeholder/);
  // Endpoint checks are skipped when not required.
  assert.deepEqual(authEnvIssues({}, { requireEndpoints: false, context: "" }), []);
});

test("auth0 principals: isService only from the positive gty marker", async () => {
  const human = await signedToken("read:knowledge");
  const service = await signedToken("read:knowledge", { claims: { gty: CLIENT_CREDENTIALS_GRANT_TYPE } });
  for (const [token, expected] of [
    [human, false],
    [service, true]
  ] as const) {
    const verifier = createRemoteAuthVerifier({ required: true, issuer, audience, jwks: async () => token.jwks });
    assert.equal((await verifier.verify(token.token)).isService, expected);
  }
});

const entraIssuer = "https://login.microsoftonline.com/tenant-id/v2.0";
const entraAudience = "api-client-guid";

function entraVerifier(jwks: JSONWebKeySet) {
  return createRemoteAuthVerifier({
    provider: "entra",
    required: true,
    issuer: entraIssuer,
    audience: entraAudience,
    rolesClaim: "roles",
    jwks: async () => jwks
  });
}

test("entra user token: scp scopes, oid subject, roles claim as user roles, not a service", async () => {
  const { token, jwks } = await signedToken("", {
    issuer: entraIssuer,
    audience: entraAudience,
    subject: "pairwise-sub",
    claims: { scp: "read:knowledge ask:knowledge", oid: "user-oid", roles: ["kb-ops"], idtyp: "user" }
  });

  const principal = await entraVerifier(jwks).verify(token);

  assert.equal(principal.subject, "user-oid");
  assert.deepEqual(principal.scopes, ["read:knowledge", "ask:knowledge"]);
  assert.deepEqual(principal.roles, ["kb-ops"]);
  assert.equal(principal.isService, false);
});

test("entra user token without oid falls back to sub; no roles claim stays undefined", async () => {
  const { token, jwks } = await signedToken("", {
    issuer: entraIssuer,
    audience: entraAudience,
    subject: "pairwise-sub",
    claims: { scp: "read:knowledge" }
  });

  const principal = await entraVerifier(jwks).verify(token);

  assert.equal(principal.subject, "pairwise-sub");
  assert.equal(principal.roles, undefined);
  assert.equal(principal.isService, false);
});

test("entra app token: roles become scopes, NOT user roles, and idtyp=app marks a service", async () => {
  const { token, jwks } = await signedToken("", {
    issuer: entraIssuer,
    audience: entraAudience,
    subject: "sp-oid",
    claims: { roles: ["read:knowledge", "act:on-behalf-of"], oid: "sp-oid", idtyp: "app" }
  });

  const principal = await entraVerifier(jwks).verify(token);

  assert.equal(principal.subject, "sp-oid");
  assert.deepEqual(principal.scopes, ["read:knowledge", "act:on-behalf-of"]);
  assert.equal(principal.roles, undefined);
  assert.equal(principal.isService, true);
});

test("entra app token WITHOUT the idtyp optional claim fails closed (no scopes, not a service)", async () => {
  const { token, jwks } = await signedToken("", {
    issuer: entraIssuer,
    audience: entraAudience,
    claims: { roles: ["read:knowledge"], oid: "sp-oid" }
  });

  const principal = await entraVerifier(jwks).verify(token);

  assert.deepEqual(principal.scopes, []);
  assert.equal(principal.isService, false);
});

test("entra issuer is validated exactly (a trailing slash does not match)", async () => {
  const { token, jwks } = await signedToken("", {
    issuer: `${entraIssuer}/`,
    audience: entraAudience,
    claims: { scp: "read:knowledge" }
  });

  await assert.rejects(() => entraVerifier(jwks).verify(token), /invalid_token/);
});
