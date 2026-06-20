import type { MiddlewareHandler } from "hono";
import {
  AuthError,
  authSettingsFromEnv,
  createRemoteAuthVerifier,
  hasScopes,
  parseBearerToken,
  type AuthSettings,
  type Principal
} from "@magpie/auth";
import type { JSONWebKeySet } from "jose";

declare module "hono" {
  interface ContextVariableMap {
    principal?: Principal;
  }
}

export interface ApiAuthOptions {
  auth?: AuthSettings & { jwks?: () => Promise<JSONWebKeySet> };
  env?: NodeJS.ProcessEnv;
  jwks?: () => Promise<JSONWebKeySet>;
}

export function requireAuth(options: ApiAuthOptions): MiddlewareHandler {
  const settings = options.auth ?? { ...authSettingsFromEnv(options.env), jwks: options.jwks };
  if (!settings?.required) {
    return async (_c, next) => {
      await next();
    };
  }

  const verifier = createRemoteAuthVerifier(settings);

  return async (c, next) => {
    try {
      const principal = await verifier.verify(parseBearerToken(c.req.header("authorization")));
      c.set("principal", principal);
      await next();
    } catch (error) {
      if (error instanceof AuthError) {
        return c.json({ error: "unauthorized" }, 401);
      }
      // The verifier converts all auth failures into AuthError, so anything else is a real
      // programming bug; rethrow it to the global onError handler instead of masking it as 401.
      throw error;
    }
  };
}

export function requireScopes(...scopes: string[]): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      // principal absent => auth disabled (local dev); requireAuth runs first on api.use("*") and guarantees it is set when auth is required.
      await next();
      return;
    }

    if (!hasScopes(principal, scopes)) {
      return c.json({ error: "forbidden" }, 403);
    }

    await next();
  };
}
