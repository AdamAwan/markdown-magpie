import type { JWTPayload } from "jose";

// Identity-provider profiles.
//
// Markdown Magpie supports two OAuth/OIDC identity providers: Auth0 (the default,
// and the only one before Entra support) and Microsoft Entra ID (single tenant).
// Everything that differs between them — how the issuer is normalised, where the
// JWKS and token endpoints live by default, which claims carry the subject, scopes,
// roles and service-identity marker, and the shape of the client-credentials
// request — is computed HERE, in one place, so the apps never branch on the
// provider themselves. See docs/authorization.md ("Using Microsoft Entra ID").

export const AUTH_PROVIDERS = ["auth0", "entra"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
const DEFAULT_AUTH_PROVIDER: AuthProvider = "auth0";

// The default Auth0 roles claim key. Kept in sync with the Auth0 post-login Action
// that emits it; overridable via AUTH_ROLES_CLAIM for other deployments/namespaces.
export const DEFAULT_ROLES_CLAIM = "https://magpie.wastedcake.com/roles";

// Entra puts app-role assignments in the standard `roles` claim — of a USER token
// these are the user's app roles; of an APP token they are the application
// permissions granted to the calling client.
const ENTRA_ROLES_CLAIM = "roles";

// Auth0 stamps the OAuth grant used to mint an access token in the standard `gty`
// claim. Machine-to-machine (client-credentials) tokens carry
// `gty: "client-credentials"`. This is the POSITIVE service-identity signal — present
// regardless of whether a post-login Action ran — as opposed to inferring "service"
// from an ABSENT roles claim, which a misconfigured IdP can also produce for a human
// token (dropping flow-scoped authorization open). See docs/authorization.md.
export const CLIENT_CREDENTIALS_GRANT_TYPE = "client-credentials";

// True when an Auth0 token was minted via the client-credentials grant, i.e. it
// belongs to a service / machine-to-machine identity (the watcher, the MCP gateway).
export function isClientCredentialsToken(payload: JWTPayload): boolean {
  return payload["gty"] === CLIENT_CREDENTIALS_GRANT_TYPE;
}

// Entra's positive app-only marker: the `idtyp` optional claim is "app" on tokens
// minted for an application identity (client-credentials). It is an OPTIONAL claim
// the operator must enable on the API app registration; without it no Entra token is
// recognised as a service token (fail closed — an app token then has no `scp` and so
// no scopes either).
const ENTRA_APP_TOKEN_TYPE = "app";

// Parses AUTH_PROVIDER. Unset/blank means the default (auth0); a value is matched
// case-insensitively. Returns undefined for anything unrecognised so callers can
// report it as a configuration error.
export function parseAuthProvider(value: string | undefined): AuthProvider | undefined {
  const normalised = value?.trim().toLowerCase();
  if (!normalised) {
    return DEFAULT_AUTH_PROVIDER;
  }
  return AUTH_PROVIDERS.find((provider) => provider === normalised);
}

// The authorization-relevant facts a verified token yields, provider-neutrally.
interface TokenClaims {
  subject: string;
  scopes: string[];
  roles?: string[];
  isService: boolean;
}

interface ClientCredentialsRequest {
  contentType: string;
  body: string;
}

interface ClientCredentialsParams {
  clientId: string;
  clientSecret: string;
  // Auth0: the API identifier sent as `audience`.
  audience: string;
  // Entra: the API's Application ID URI; the scope requested is `${apiIdUri}/.default`.
  apiIdUri?: string;
}

interface ProviderProfile {
  // Normalises the configured issuer into the exact string the token's `iss` must equal.
  normaliseIssuer(issuer: string): string;
  defaultJwksUri(issuer: string): string;
  defaultTokenUrl(issuer: string): string;
  defaultRolesClaim: string;
  // Entra only: the API Application ID URI used to build scope strings.
  defaultApiIdUri(audience: string): string | undefined;
  claims(payload: JWTPayload, rolesClaim: string): TokenClaims;
  // Builds the client-credentials token request, or undefined when the
  // provider-specific inputs it needs are missing.
  clientCredentialsRequest(params: ClientCredentialsParams): ClientCredentialsRequest | undefined;
}

const auth0Profile: ProviderProfile = {
  // Auth0's `iss` is `https://<domain>/` — exactly one trailing slash.
  normaliseIssuer: (issuer) => trimTrailingSlash(issuer) + "/",
  defaultJwksUri: (issuer) => `${issuer}.well-known/jwks.json`,
  defaultTokenUrl: (issuer) => `${issuer}oauth/token`,
  defaultRolesClaim: DEFAULT_ROLES_CLAIM,
  defaultApiIdUri: () => undefined,
  claims: (payload, rolesClaim) => ({
    subject: payload.sub ?? "",
    scopes: splitScopes(payload["scope"]),
    roles: rolesFromPayload(payload, rolesClaim),
    isService: isClientCredentialsToken(payload)
  }),
  clientCredentialsRequest: ({ clientId, clientSecret, audience }) => ({
    contentType: "application/json",
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience
    })
  })
};

const entraProfile: ProviderProfile = {
  // Entra's v2 `iss` is `https://login.microsoftonline.com/<tenant-id>/v2.0` with NO
  // trailing slash; it is validated exactly as configured (single tenant).
  normaliseIssuer: (issuer) => issuer,
  defaultJwksUri: (issuer) => `${entraAuthorityBase(issuer)}/discovery/v2.0/keys`,
  defaultTokenUrl: (issuer) => `${entraAuthorityBase(issuer)}/oauth2/v2.0/token`,
  defaultRolesClaim: ENTRA_ROLES_CLAIM,
  defaultApiIdUri: (audience) => `api://${audience}`,
  claims: (payload, rolesClaim) => {
    // Entra's `sub` is pairwise (unique per user PER APPLICATION); `oid` is the
    // stable directory object id, so it is the subject when present.
    const oid = payload["oid"];
    const subject = typeof oid === "string" && oid ? oid : (payload.sub ?? "");
    if (payload["idtyp"] === ENTRA_APP_TOKEN_TYPE) {
      // App-only token: the `roles` claim lists the APPLICATION PERMISSIONS granted
      // to the client — they are its scopes, never user roles.
      return {
        subject,
        scopes: rolesFromPayload(payload, ENTRA_ROLES_CLAIM) ?? [],
        roles: undefined,
        isService: true
      };
    }
    return {
      subject,
      scopes: splitScopes(payload["scp"]),
      roles: rolesFromPayload(payload, rolesClaim),
      isService: false
    };
  },
  clientCredentialsRequest: ({ clientId, clientSecret, apiIdUri }) => {
    if (!apiIdUri) {
      return undefined;
    }
    return {
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: `${apiIdUri}/.default`
      }).toString()
    };
  }
};

export function providerProfile(provider: AuthProvider | undefined): ProviderProfile {
  return provider === "entra" ? entraProfile : auth0Profile;
}

// Reads the role names from a verified token payload. Returns `undefined` when the
// claim is absent (or not an array) — see Principal.roles for why that case is
// distinct from an empty array. String entries only; anything non-string is dropped.
export function rolesFromPayload(payload: JWTPayload, rolesClaim: string): string[] | undefined {
  const claim = payload[rolesClaim];
  if (!Array.isArray(claim)) {
    return undefined;
  }
  return claim.filter((entry): entry is string => typeof entry === "string");
}

function splitScopes(value: unknown): string[] {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

// `https://login.microsoftonline.com/<tenant>/v2.0` -> `https://login.microsoftonline.com/<tenant>`.
function entraAuthorityBase(issuer: string): string {
  return trimTrailingSlash(issuer).replace(/\/v2\.0$/, "");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
