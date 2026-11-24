import assert from "node:assert/strict";
import test from "node:test";
import { API_SCOPES, buildOidcSettings } from "./authSettings";
import type { BrowserAuthConfig } from "./runtimeConfig";

const ORIGIN = "https://magpie.example.com";

const auth0Config: BrowserAuthConfig = {
  provider: "auth0",
  issuer: "https://tenant.eu.auth0.com/",
  clientId: "spa-client",
  audience: "https://magpie.example.com/api",
  redirectUri: "http://misconfigured.example.com",
  apiIdUri: "api://https://magpie.example.com/api"
};

const entraConfig: BrowserAuthConfig = {
  provider: "entra",
  issuer: "https://login.microsoftonline.com/tenant-id/v2.0",
  clientId: "spa-guid",
  audience: "api-guid",
  redirectUri: "http://localhost:3000",
  apiIdUri: "api://api-guid"
};

test("buildOidcSettings (auth0): issuer authority, plain API scopes, audience as an extra authorize param", () => {
  assert.deepEqual(buildOidcSettings(auth0Config, ORIGIN), {
    authority: "https://tenant.eu.auth0.com/",
    client_id: "spa-client",
    redirect_uri: ORIGIN,
    post_logout_redirect_uri: ORIGIN,
    response_type: "code",
    scope: `openid profile email offline_access ${API_SCOPES.join(" ")}`,
    extraQueryParams: { audience: "https://magpie.example.com/api" },
    automaticSilentRenew: true
  });
});

test("buildOidcSettings (entra): issuer authority, API scopes prefixed with the Application ID URI, no audience param", () => {
  const settings = buildOidcSettings(entraConfig, ORIGIN);

  assert.equal(settings.authority, "https://login.microsoftonline.com/tenant-id/v2.0");
  assert.equal(settings.client_id, "spa-guid");
  assert.equal(
    settings.scope,
    "openid profile offline_access api://api-guid/read:knowledge api://api-guid/ask:knowledge " +
      "api://api-guid/feedback:questions api://api-guid/manage:knowledge api://api-guid/manage:jobs " +
      "api://api-guid/manage:admin"
  );
  assert.equal(settings.extraQueryParams, undefined);
  assert.ok(!("extraQueryParams" in settings));
});

test("buildOidcSettings redirects to the browser origin, never the configured redirect URI", () => {
  const settings = buildOidcSettings(auth0Config, ORIGIN);

  assert.equal(settings.redirect_uri, ORIGIN);
  assert.equal(settings.post_logout_redirect_uri, ORIGIN);
});
