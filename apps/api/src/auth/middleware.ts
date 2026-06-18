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

export interface ApiAuthOptions {
  auth?: AuthSettings & { jwks?: () => Promise<JSONWebKeySet> };
  env?: NodeJS.ProcessEnv;
  jwks?: () => Promise<JSONWebKeySet>;
}

type PrincipalContext = {
  set(key: "principal", value: Principal): void;
  get(key: "principal"): Principal | undefined;
};

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
      (c as unknown as PrincipalContext).set("principal", principal);
      await next();
    } catch (error) {
      if (error instanceof AuthError) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return c.json({ error: "unauthorized" }, 401);
    }
  };
}

export function requireScopes(...scopes: string[]): MiddlewareHandler {
  return async (c, next) => {
    const principal = (c as unknown as PrincipalContext).get("principal");
    if (!principal) {
      await next();
      return;
    }

    if (!hasScopes(principal, scopes)) {
      return c.json({ error: "forbidden" }, 403);
    }

    await next();
  };
}
