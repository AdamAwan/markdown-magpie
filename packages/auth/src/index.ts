import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload
} from "jose";

export interface AuthSettings {
  required: boolean;
  issuer: string;
  audience: string;
  jwksUri?: string;
}

export interface Principal {
  subject: string;
  scopes: string[];
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

export function authSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const issuerBase =
    env.AUTH0_ISSUER_BASE_URL ??
    (env.AUTH0_DOMAIN ? `https://${env.AUTH0_DOMAIN}` : "https://markdown-magpie.local");
  const issuer = trimTrailingSlash(issuerBase) + "/";

  return {
    required: env.AUTH_REQUIRED === "true",
    issuer,
    audience: env.AUTH0_AUDIENCE ?? "https://markdown-magpie.local/api",
    jwksUri: env.AUTH0_JWKS_URI
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
