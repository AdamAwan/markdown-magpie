import type { UserManagerSettings } from "oidc-client-ts";
import type { BrowserAuthConfig } from "./runtimeConfig";

// API scopes the console requests so the issued access token actually carries
// permissions for the web API. Without them the IdP issues a token the API
// rejects/forbids on every protected route. These mirror the web API's defined
// permissions; an authorized user is granted the subset they're allowed (all of
// them when the API's user policy is allow_all and RBAC is off). The single
// source for both providers: auth0 requests them as-is, entra prefixes each
// with the API's Application ID URI.
export const API_SCOPES = [
  "read:knowledge",
  "ask:knowledge",
  "feedback:questions",
  "manage:knowledge",
  "manage:jobs",
  "manage:admin"
] as const;

// The subset of oidc-client-ts settings the console derives from its runtime
// config. Storage (userStore) is browser-only and added by the AuthProvider.
export type OidcSettings = Pick<
  UserManagerSettings,
  | "authority"
  | "client_id"
  | "redirect_uri"
  | "post_logout_redirect_uri"
  | "response_type"
  | "scope"
  | "extraQueryParams"
  | "automaticSilentRenew"
>;

function requestedScopes(config: BrowserAuthConfig): string[] {
  // offline_access asks for a refresh token: silent renewal uses the refresh
  // token grant (no hidden iframe, so third-party-cookie blocking can't break it).
  if (config.provider === "entra") {
    // Entra delegated scopes are addressed as <Application ID URI>/<scope>. It
    // does not need `email` (the console labels the user from name /
    // preferred_username when no email claim is present).
    return ["openid", "profile", "offline_access", ...API_SCOPES.map((scope) => `${config.apiIdUri}/${scope}`)];
  }
  return ["openid", "profile", "email", "offline_access", ...API_SCOPES];
}

// Builds the per-provider OIDC client settings. `origin` is the browser's own
// origin: it is the redirect and post-logout target (see AuthProvider for why the
// configured redirect URI is not trusted).
export function buildOidcSettings(config: BrowserAuthConfig, origin: string): OidcSettings {
  return {
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: origin,
    post_logout_redirect_uri: origin,
    // Authorization code + PKCE (oidc-client-ts's default for "code").
    response_type: "code",
    scope: requestedScopes(config).join(" "),
    // Auth0 only issues a JWT access token for our API when the authorize
    // request names its `audience`; without it the token is opaque (userinfo
    // only). Entra infers the resource from the scopes instead.
    ...(config.provider === "auth0" ? { extraQueryParams: { audience: config.audience } } : {}),
    // Renew ahead of expiry in the background (via the refresh token).
    automaticSilentRenew: true
  };
}
