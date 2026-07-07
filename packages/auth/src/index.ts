import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

export { createApiTokenProvider, type ApiTokenProvider, type ApiTokenProviderConfig } from "./api-token.js";
export {
  ON_BEHALF_OF_SCOPE,
  ON_BEHALF_OF_SUBJECT_HEADER,
  ON_BEHALF_OF_ROLES_HEADER,
  serializeOnBehalfRoles,
  parseOnBehalfRoles,
  resolveEffectivePrincipal
} from "./on-behalf-of.js";

export interface AuthSettings {
  required: boolean;
  issuer: string;
  audience: string;
  jwksUri?: string;
  // The full JWT claim key that carries the principal's role names, emitted by the
  // Auth0 post-login Action (a namespaced custom claim, e.g.
  // "https://magpie.wastedcake.com/roles"). Auth0 requires custom claims to be
  // namespaced with a URL, so this is the whole key, not just the namespace.
  // Optional so existing settings literals need not change; the verifier falls back
  // to DEFAULT_ROLES_CLAIM when unset.
  rolesClaim?: string;
}

// The default roles claim key. Kept in sync with the Auth0 post-login Action that
// emits it; overridable via AUTH_ROLES_CLAIM for other deployments/namespaces.
export const DEFAULT_ROLES_CLAIM = "https://magpie.wastedcake.com/roles";

export interface Principal {
  subject: string;
  scopes: string[];
  // Role names carried by the token, or absent/`undefined` when the token has no
  // roles claim at all. The distinction is load-bearing: interactive user logins run
  // the Auth0 Action and always carry the claim (possibly an empty array), whereas
  // machine-to-machine (client-credentials) tokens never do. Downstream flow-scoped
  // authorization treats an ABSENT claim as a service/legacy principal (scope-only,
  // no flow restriction) and a PRESENT claim as a role-aware principal whose flow
  // access is fully determined by these roles.
  roles?: string[];
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

export function authSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const issuerBase =
    env.AUTH0_ISSUER_BASE_URL ?? (env.AUTH0_DOMAIN ? `https://${env.AUTH0_DOMAIN}` : "https://markdown-magpie.local");
  const issuer = trimTrailingSlash(issuerBase) + "/";

  return {
    required: isAuthRequired(env.AUTH_REQUIRED),
    issuer,
    audience: env.AUTH0_AUDIENCE ?? "https://markdown-magpie.local/api",
    jwksUri: env.AUTH0_JWKS_URI,
    rolesClaim: env.AUTH_ROLES_CLAIM?.trim() || DEFAULT_ROLES_CLAIM
  };
}

export function parseBearerToken(header: string | null | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1];
}

export function hasScopes(principal: Principal, requiredScopes: readonly string[]): boolean {
  return requiredScopes.every((scope) => principal.scopes.includes(scope));
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

export function createRemoteAuthVerifier(options: AuthSettings & { jwks?: () => Promise<JSONWebKeySet> }) {
  let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  function getRemoteJwks(): ReturnType<typeof createRemoteJWKSet> {
    remoteJwks ??= createRemoteJWKSet(new URL(options.jwksUri ?? `${options.issuer}.well-known/jwks.json`));
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

        return {
          subject: payload.sub ?? "",
          scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [],
          roles: rolesFromPayload(payload, options.rolesClaim ?? DEFAULT_ROLES_CLAIM),
          payload
        };
      } catch (error) {
        if (error instanceof AuthError) {
          throw error;
        }
        throw new AuthError("invalid_token");
      }
    }
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
