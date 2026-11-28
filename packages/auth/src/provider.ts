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

// The versioned Entra authorization-server identifier MCP clients are pointed at
// from the MCP server's protected-resource metadata. Advertising
// `https://login.microsoftonline.com/<tenant-id>/oauth21/2026-08` (instead of the
// plain v2.0 authority) is what enables Client ID Metadata Document (CIMD) clients
// to sign in without pre-registration ("Secure an MCP server with Microsoft Entra
// ID"). It is an AUTHORIZATION SERVER identifier only: the tokens it issues still
// carry `iss` = `https://login.microsoftonline.com/<tenant-id>/v2.0`, so the
// verifier keeps validating against AUTH_ISSUER.
const ENTRA_MCP_AUTHORIZATION_SERVER_VERSION = "oauth21/2026-08";

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

// Inputs to the MCP server's provider-specific startup checks.
interface McpResourceConfig {
  // The public /mcp URL (MCP_RESOURCE_URL).
  resourceUrl: string;
  // The MCP app's Application ID URI advertised scopes are qualified with
  // (MCP_API_ID_URI, defaulting to resourceUrl).
  resourceIdUri: string;
  // Whether MCP_AUDIENCE was set explicitly (rather than defaulted to resourceUrl).
  audienceConfigured: boolean;
  // Whether an issuer was configured (AUTH_ISSUER or a legacy fallback) rather
  // than left at the placeholder.
  issuerConfigured: boolean;
}

interface ProviderProfile {
  // Normalises the configured issuer into the exact string the token's `iss` must equal.
  normaliseIssuer(issuer: string): string;
  defaultJwksUri(issuer: string): string;
  defaultTokenUrl(issuer: string): string;
  defaultRolesClaim: string;
  // Whether a USER token's scopes are filtered per user by the IdP. Auth0 RBAC
  // issues each user only the permissions their roles carry, so a scope gate is
  // a per-user check. Entra grants every consented delegated scope to every user
  // who can sign in, so a user token's `scp` says nothing about the user — the
  // API then authorizes privileged actions from the user's app ROLES instead
  // (`requirePrivilege`, apps/api/src/auth/capabilities.ts; docs/authorization.md
  // AZ27). Service (app-only) tokens are unaffected: their scopes are
  // per-application grants an administrator consented to.
  perUserScopes: boolean;
  // Entra only: the API Application ID URI used to build scope strings.
  defaultApiIdUri(audience: string): string | undefined;
  claims(payload: JWTPayload, rolesClaim: string): TokenClaims;
  // Builds the client-credentials token request, or undefined when the
  // provider-specific inputs it needs are missing.
  clientCredentialsRequest(params: ClientCredentialsParams): ClientCredentialsRequest | undefined;
  // The authorization server the MCP server advertises in its protected-resource
  // metadata, derived from the (normalised) issuer.
  defaultMcpAuthorizationServer(issuer: string): string;
  // The form in which the MCP server advertises a scope (protected-resource
  // `scopes_supported`, WWW-Authenticate `scope=`). `resourceIdUri` is the MCP
  // server's own Application ID URI (Entra). Inbound tokens still carry the SHORT
  // scope name, so verification never uses this form.
  advertisedMcpScope(scope: string, resourceIdUri: string): string;
  // The scopes the MCP 401 challenge asks a client to sign in with (short names).
  // `basic` is the user-level subset; elevated scopes are then requested by step-up
  // (the 403 insufficient_scope challenge) only when a tool needs them.
  mcpSignInScopes(scopes: { all: readonly string[]; basic: readonly string[] }): readonly string[];
  // Provider-specific MCP configuration problems that must stop the HTTP MCP
  // server from starting (auth required). Each entry is a complete message.
  mcpResourceIssues(config: McpResourceConfig): string[];
}

const auth0Profile: ProviderProfile = {
  // Auth0's `iss` is `https://<domain>/` — exactly one trailing slash.
  normaliseIssuer: (issuer) => trimTrailingSlash(issuer) + "/",
  defaultJwksUri: (issuer) => `${issuer}.well-known/jwks.json`,
  defaultTokenUrl: (issuer) => `${issuer}oauth/token`,
  defaultRolesClaim: DEFAULT_ROLES_CLAIM,
  perUserScopes: true,
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
  }),
  // Auth0 is its own authorization server; the issuer is advertised unchanged.
  defaultMcpAuthorizationServer: (issuer) => issuer,
  // Auth0 scopes are plain names; the MCP audience is chosen via RFC 8707 `resource`.
  advertisedMcpScope: (scope) => scope,
  // Auth0 filters requested scopes by per-user RBAC, so asking for all of them is
  // safe and keeps clients without step-up support working.
  mcpSignInScopes: ({ all }) => all,
  mcpResourceIssues: () => []
};

const entraProfile: ProviderProfile = {
  // Entra's v2 `iss` is `https://login.microsoftonline.com/<tenant-id>/v2.0` with NO
  // trailing slash; it is validated exactly as configured (single tenant).
  normaliseIssuer: (issuer) => issuer,
  defaultJwksUri: (issuer) => `${entraAuthorityBase(issuer)}/discovery/v2.0/keys`,
  defaultTokenUrl: (issuer) => `${entraAuthorityBase(issuer)}/oauth2/v2.0/token`,
  defaultRolesClaim: ENTRA_ROLES_CLAIM,
  perUserScopes: false,
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
  },
  defaultMcpAuthorizationServer: (issuer) => `${entraAuthorityBase(issuer)}/${ENTRA_MCP_AUTHORIZATION_SERVER_VERSION}`,
  // Entra scopes are requested fully qualified: `<Application ID URI>/<scope>`.
  advertisedMcpScope: (scope, resourceIdUri) => `${resourceIdUri}/${scope}`,
  // Entra delegated scopes are not per-user, and an elevated scope that needs admin
  // consent would block the WHOLE sign-in for users who can't consent. Sign in with
  // the user-level scopes only; elevated ones are requested via step-up.
  mcpSignInScopes: ({ basic }) => basic,
  mcpResourceIssues: ({ resourceUrl, resourceIdUri, audienceConfigured, issuerConfigured }) => {
    const issues: string[] = [];
    if (!issuerConfigured) {
      issues.push(
        "AUTH_ISSUER must be set to https://login.microsoftonline.com/<tenant-id>/v2.0 when AUTH_PROVIDER=entra " +
          "(tokens are verified against it and the advertised authorization server is derived from it)"
      );
    }
    if (!audienceConfigured) {
      issues.push(
        "MCP_AUDIENCE must be set to the MCP app registration's client-ID GUID when AUTH_PROVIDER=entra " +
          "(v2 access tokens carry aud = that GUID, never the MCP resource URL)"
      );
    }
    issues.push(...entraMcpResourceUrlIssues(resourceUrl));
    issues.push(...entraMcpApiIdUriIssues(resourceIdUri, resourceUrl));
    return issues;
  }
};

// Characters that would break the quoted-string `scope="…"` WWW-Authenticate
// parameter the qualified scopes are advertised in.
const QUOTED_STRING_BREAKERS = /["\\\s]/;

// The Application ID URI qualifies every advertised scope. When it defaults to the
// resource URL, the resource-URL checks already cover its shape; an explicit
// MCP_API_ID_URI gets the trailing-slash check too. Either way it must be safe to
// embed in a quoted string.
function entraMcpApiIdUriIssues(resourceIdUri: string, resourceUrl: string): string[] {
  const explicit = resourceIdUri !== resourceUrl;
  const name = explicit ? "MCP_API_ID_URI" : "MCP_RESOURCE_URL";
  const issues: string[] = [];
  if (explicit && resourceIdUri.endsWith("/")) {
    issues.push(`MCP_API_ID_URI (${resourceIdUri}) must not end with a trailing slash when AUTH_PROVIDER=entra`);
  }
  if (QUOTED_STRING_BREAKERS.test(resourceIdUri)) {
    issues.push(
      `${name} (${resourceIdUri}) qualifies the advertised scopes when AUTH_PROVIDER=entra and must not contain ` +
        "quotes, backslashes or whitespace"
    );
  }
  return issues;
}

// The MCP resource URL doubles as the MCP app's Application ID URI, which Entra
// requires to be an HTTPS URL with a non-empty path and no trailing slash.
function entraMcpResourceUrlIssues(resourceUrl: string): string[] {
  const prefix = `MCP_RESOURCE_URL (${resourceUrl}) is the MCP app's Application ID URI when AUTH_PROVIDER=entra and`;
  let url: URL;
  try {
    url = new URL(resourceUrl);
  } catch {
    return [`${prefix} must be a valid URL`];
  }
  const issues: string[] = [];
  if (url.protocol !== "https:") {
    issues.push(`${prefix} must use https`);
  }
  if (url.pathname === "/" || url.pathname === "") {
    issues.push(`${prefix} must have a non-empty path (e.g. https://mcp.example.com/mcp)`);
  } else if (resourceUrl.endsWith("/")) {
    issues.push(`${prefix} must not end with a trailing slash`);
  }
  return issues;
}

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
