import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { ON_BEHALF_OF_ROLES_HEADER, ON_BEHALF_OF_SCOPE, ON_BEHALF_OF_SUBJECT_HEADER } from "@magpie/auth";
import { requireAuth } from "./middleware.js";

// Integration coverage for on-behalf-of delegation as wired into requireAuth: a
// trusted caller (holding act:on-behalf-of) that forwards a user identity is
// authorized as that user; any other caller is unaffected. The pure resolver is
// unit-tested in @magpie/auth.

const issuer = "https://example.auth0.com/";
const audience = "https://markdown-magpie.local/api";

async function signer(): Promise<{
  jwks: () => Promise<JSONWebKeySet>;
  token: (scope: string) => Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = "test-key";
  return {
    jwks: async () => ({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
    token: (scope: string) =>
      new SignJWT({ scope })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("mcp-service@clients")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey)
  };
}

function appWith(jwks: () => Promise<JSONWebKeySet>): Hono {
  const app = new Hono();
  app.use("*", requireAuth({ auth: { required: true, issuer, audience, jwks } }));
  app.get("/whoami", (c) => {
    const p = c.get("principal");
    return c.json({ subject: p?.subject, roles: p?.roles ?? null });
  });
  return app;
}

test("a trusted caller's forwarded user identity is authorized as the user", async () => {
  const { jwks, token } = await signer();
  const res = await appWith(jwks).request("/whoami", {
    headers: {
      authorization: `Bearer ${await token(`${ON_BEHALF_OF_SCOPE} read:knowledge`)}`,
      [ON_BEHALF_OF_SUBJECT_HEADER]: "auth0|end-user",
      [ON_BEHALF_OF_ROLES_HEADER]: JSON.stringify(["kb-hr-curators"])
    }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { subject: "auth0|end-user", roles: ["kb-hr-curators"] });
});

test("forwarded headers are ignored for a caller without the on-behalf-of scope", async () => {
  const { jwks, token } = await signer();
  const res = await appWith(jwks).request("/whoami", {
    headers: {
      authorization: `Bearer ${await token("read:knowledge")}`,
      [ON_BEHALF_OF_SUBJECT_HEADER]: "auth0|end-user",
      [ON_BEHALF_OF_ROLES_HEADER]: JSON.stringify(["kb-super"])
    }
  });
  assert.equal(res.status, 200);
  // The caller's own identity stands; the M2M token carries no roles claim.
  assert.deepEqual(await res.json(), { subject: "mcp-service@clients", roles: null });
});
