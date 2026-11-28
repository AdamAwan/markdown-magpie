import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { AUTH_PROVIDERS, parseAuthProvider, providerProfile, type AuthProvider } from "./provider.js";

export { createApiTokenProvider, type ApiTokenProvider, type ApiTokenProviderConfig } from "./api-token.js";
export {
  ON_BEHALF_OF_SCOPE,
  ON_BEHALF_OF_SUBJECT_HEADER,
  ON_BEHALF_OF_ROLES_HEADER,
  serializeOnBehalfRoles,
  parseOnBehalfRoles,
  resolveEffectivePrincipal,
  tokenGrantsOnBehalfOf
} from "./on-behalf-of.js";
export {
  AUTH_PROVIDERS,
  CLIENT_CREDENTIALS_GRANT_TYPE,
  DEFAULT_ROLES_CLAIM,
  isClientCredentialsToken,
  parseAuthProvider,
  providerProfile,
  rolesFromPayload,
  type AuthProvider
} from "./provider.js";

export interface AuthSettings {
  // Which identity provider issues the tokens. Optional so existing settings
  // literals need not change; absent means auth0 (the pre-Entra behaviour).
  provider?: AuthProvider;
  required: boolean;
  // The exact `iss` value tokens must carry (already normalised per provider).
  issuer: string;
  audience: string;
  jwksUri?: string;
  // The full JWT claim key that carries the principal's role names. For Auth0 it is
  // emitted by the post-login Action (a namespaced custom claim, e.g.
  // "https://magpie.wastedcake.com/roles" — Auth0 requires custom claims to be
  // namespaced with a URL, so this is the whole key); for Entra it is `roles`.
  // Optional so existing settings literals need not change; the verifier falls back
  // to the provider's default when unset.
  rolesClaim?: string;
  // The client-credentials token endpoint backend services (watcher, MCP) use to
  // obtain their own machine-to-machine token.
  tokenUrl?: string;
  // Entra only: the API's Application ID URI, used to build scope strings
  // (`${apiIdUri}/.default` for client-credentials).
  apiIdUri?: string;
}

// Settings as resolved from the environment: every provider-derived field is filled
// in (apiIdUri stays optional — it only exists for Entra).
export type ResolvedAuthSettings = AuthSettings &
  Required<Pick<AuthSettings, "provider" | "jwksUri" | "rolesClaim" | "tokenUrl">>;

export interface Principal {
  subject: string;
  scopes: string[];
  // Role names carried by the token, or absent/`undefined` when the token has no
  // roles claim at all. The distinction is load-bearing: interactive user logins
  // carry the claim (possibly an empty array), whereas machine-to-machine
  // (client-credentials) tokens never do — and for Entra app tokens the `roles`
  // claim holds application PERMISSIONS, which the verifier maps to scopes, never
  // to roles. Downstream flow-scoped authorization treats a PRESENT claim as a
  // role-aware principal whose flow access is fully determined by these roles. An
  // ABSENT claim is NOT sufficient on its own to grant the service-identity bypass
  // — that requires the POSITIVE service marker (`isService`), so a human token
  // whose roles claim was dropped fails CLOSED rather than open (see
  // apps/api/src/auth/capabilities.ts).
  roles?: string[];
  // True only when the token carries the provider's POSITIVE service-identity
  // marker: Auth0 `gty: "client-credentials"`, Entra `idtyp: "app"`. Computed once
  // at verify time so callers never read provider-specific claims.
  isService: boolean;
  payload: JWTPayload;
}

export class AuthError extends Error {
  constructor(
    public readonly code: "missing_token" | "invalid_token" | "forbidden",
    message = code
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// Auth fails CLOSED: it is required unless an operator EXPLICITLY opts out by
// setting AUTH_REQUIRED=false (case-insensitive). An unset, blank, or typo'd
// value leaves auth on, so a misconfigured deployment is locked down rather than
// silently exposed. This is the single source of truth for that rule — the API
// config, watcher, and both MCP transports all call it.
export function isAuthRequired(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false";
}

// The committed placeholder audience from .env.example. Real deployments must
// override it; the API and watcher reject it at boot when auth is enabled.
const PLACEHOLDER_AUDIENCE = "https://markdown-magpie.local/api";
const PLACEHOLDER_ISSUER = "https://markdown-magpie.local";

// The auth env vars the startup checks read: the new generic names alongside
// their legacy Auth0 fallbacks.
interface AuthEnv {
  AUTH_PROVIDER?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH0_DOMAIN?: string;
  AUTH0_ISSUER_BASE_URL?: string;
  AUTH0_AUDIENCE?: string;
}

// First non-blank value: an explicitly-empty var (a blank `FOO=` line) means unset.
function firstSet(...values: (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim()).find((value) => value !== undefined && value !== "");
}

// AUTH_ISSUER, then the legacy AUTH0_ISSUER_BASE_URL, then `https://${AUTH0_DOMAIN}`.
// Undefined when none is set (authSettingsFromEnv then falls back to a placeholder).
export function configuredIssuer(env: AuthEnv): string | undefined {
  const domain = firstSet(env.AUTH0_DOMAIN);
  return firstSet(env.AUTH_ISSUER, env.AUTH0_ISSUER_BASE_URL) ?? (domain ? `https://${domain}` : undefined);
}

function configuredAudience(env: AuthEnv): string | undefined {
  return firstSet(env.AUTH_AUDIENCE, env.AUTH0_AUDIENCE);
}

function invalidProviderMessage(value: string | undefined): string {
  return `must be one of ${AUTH_PROVIDERS.join(", ")} (got "${value}")`;
}

export interface AuthEnvIssue {
  variable: string;
  message: string;
}

// Startup coherence checks shared by the API and watcher config loaders, so both
// accept the new generic names OR their legacy Auth0 fallbacks identically.
// AUTH_PROVIDER is always validated; the audience/issuer checks run only when
// `requireEndpoints` (auth enabled, and — for the watcher — the client-credentials
// grant in use). `context` completes each message ("is required <context>").
export function authEnvIssues(env: AuthEnv, options: { requireEndpoints: boolean; context: string }): AuthEnvIssue[] {
  const issues: AuthEnvIssue[] = [];
  if (parseAuthProvider(env.AUTH_PROVIDER) === undefined) {
    issues.push({ variable: "AUTH_PROVIDER", message: invalidProviderMessage(env.AUTH_PROVIDER) });
  }
  if (!options.requireEndpoints) {
    return issues;
  }
  const audience = configuredAudience(env);
  if (audience === undefined) {
    issues.push({
      variable: "AUTH_AUDIENCE",
      message: `AUTH_AUDIENCE (or legacy AUTH0_AUDIENCE) is required ${options.context}`
    });
  } else if (audience === PLACEHOLDER_AUDIENCE) {
    issues.push({
      variable: "AUTH_AUDIENCE",
      message: `AUTH_AUDIENCE (or legacy AUTH0_AUDIENCE) must be a real API identifier, not the placeholder ${PLACEHOLDER_AUDIENCE}, ${options.context}`
    });
  }
  if (configuredIssuer(env) === undefined) {
    issues.push({
      variable: "AUTH_ISSUER",
      message: `AUTH_ISSUER (or legacy AUTH0_ISSUER_BASE_URL / AUTH0_DOMAIN) is required ${options.context}`
    });
  }
  return issues;
}

// Resolves the deployment's auth settings from the environment. The new generic
// names (AUTH_*) win; the legacy Auth0 names remain as fallbacks so an existing
// Auth0 deployment keeps working with no env changes. Provider-specific defaults
// (issuer normalisation, JWKS/token URLs, roles claim, API ID URI) come from the
// provider profile. Throws on an unrecognised AUTH_PROVIDER (the API and watcher
// config loaders report it, with the rest of their config errors, first).
export function authSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedAuthSettings {
  const provider = parseAuthProvider(env.AUTH_PROVIDER);
  if (provider === undefined) {
    throw new Error(`AUTH_PROVIDER ${invalidProviderMessage(env.AUTH_PROVIDER)}`);
  }
  const profile = providerProfile(provider);
  const issuer = profile.normaliseIssuer(configuredIssuer(env) ?? PLACEHOLDER_ISSUER);
  const audience = configuredAudience(env) ?? PLACEHOLDER_AUDIENCE;

  return {
    provider,
    required: isAuthRequired(env.AUTH_REQUIRED),
    issuer,
    audience,
    jwksUri: firstSet(env.AUTH_JWKS_URI, env.AUTH0_JWKS_URI) ?? profile.defaultJwksUri(issuer),
    rolesClaim: firstSet(env.AUTH_ROLES_CLAIM) ?? profile.defaultRolesClaim,
    tokenUrl: firstSet(env.AUTH_TOKEN_URL) ?? profile.defaultTokenUrl(issuer),
    apiIdUri: firstSet(env.AUTH_API_ID_URI) ?? profile.defaultApiIdUri(audience)
  };
}

export function parseBearerToken(header: string | null | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1];
}

export function hasScopes(principal: Principal, requiredScopes: readonly string[]): boolean {
  return requiredScopes.every((scope) => principal.scopes.includes(scope));
}

export function createRemoteAuthVerifier(options: AuthSettings & { jwks?: () => Promise<JSONWebKeySet> }) {
  const profile = providerProfile(options.provider);
  const rolesClaim = options.rolesClaim ?? profile.defaultRolesClaim;
  let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  function getRemoteJwks(): ReturnType<typeof createRemoteJWKSet> {
    remoteJwks ??= createRemoteJWKSet(new URL(options.jwksUri ?? profile.defaultJwksUri(options.issuer)));
    return remoteJwks;
  }

  return {
    async verify(token: string | undefined): Promise<Principal> {
      if (!token) {
        throw new AuthError("missing_token");
      }

      try {
        const keySet = options.jwks ? createLocalJWKSet(await options.jwks()) : getRemoteJwks();
        const { payload } = await jwtVerify(token, keySet, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ["RS256"],
          requiredClaims: ["exp"]
        });

        return { ...profile.claims(payload, rolesClaim), payload };
      } catch (error) {
        if (error instanceof AuthError) {
          throw error;
        }
        throw new AuthError("invalid_token");
      }
    }
  };
}
