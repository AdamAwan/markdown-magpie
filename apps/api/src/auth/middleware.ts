import type { MiddlewareHandler } from "hono";
import {
  AuthError,
  authSettingsFromEnv,
  createRemoteAuthVerifier,
  hasScopes,
  parseBearerToken,
  resolveEffectivePrincipal,
  ON_BEHALF_OF_ROLES_HEADER,
  ON_BEHALF_OF_SUBJECT_HEADER,
  type AuthSettings,
  type Principal
} from "@magpie/auth";
import type { JSONWebKeySet } from "jose";

declare module "hono" {
  interface ContextVariableMap {
    principal?: Principal;
    // Whether auth is enforced for this app. requireAuth sets it on every request
    // so requireScopes can FAIL CLOSED: deny a principal-absent request unless
    // auth was explicitly disabled. Treated as required (true) when unset.
    authRequired?: boolean;
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
    // Auth explicitly disabled. Mark it on the context so requireScopes knows the
    // principal-absent passthrough is intentional rather than a missing guard.
    return async (c, next) => {
      c.set("authRequired", false);
      await next();
    };
  }

  const verifier = createRemoteAuthVerifier(settings);

  return async (c, next) => {
    c.set("authRequired", true);
    try {
      const principal = await verifier.verify(parseBearerToken(c.req.header("authorization")));
      // Apply on-behalf-of delegation: when a trusted gateway (the MCP service,
      // holding act:on-behalf-of) forwards a verified user identity, authorize as
      // that user. A no-op for every other caller — see resolveEffectivePrincipal.
      const effective = resolveEffectivePrincipal(principal, {
        subject: c.req.header(ON_BEHALF_OF_SUBJECT_HEADER),
        roles: c.req.header(ON_BEHALF_OF_ROLES_HEADER)
      });
      c.set("principal", effective);
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
      // FAIL CLOSED: a missing principal is only allowed when auth was explicitly
      // disabled (local dev). If auth is required (or the flag is unset because
      // requireAuth never ran), deny rather than silently allowing the request.
      if (c.get("authRequired") === false) {
        await next();
        return;
      }
      return c.json({ error: "unauthorized" }, 401);
    }

    if (!hasScopes(principal, scopes)) {
      return c.json({ error: "forbidden" }, 403);
    }

    await next();
  };
}
