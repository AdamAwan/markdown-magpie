import { decodeJwt } from "jose";
import type { Principal } from "./index.js";
import { providerProfile, type AuthProvider } from "./provider.js";

// Trusted on-behalf-of delegation.
//
// The HTTP MCP server authenticates the END USER at its edge, then calls the
// downstream API with its OWN machine-to-machine token (service identity). To let
// the API's per-flow authorization apply to the real user, the MCP forwards the
// user's verified identity (subject + roles) in these headers. The API honors them
// ONLY when the authenticated caller holds ON_BEHALF_OF_SCOPE — a permission
// granted solely to the MCP service. So the trust chain is: (1) the API verifies
// the M2M token + this scope → the caller really is the trusted MCP gateway; (2)
// that gateway asserts a user identity it independently verified.
//
// This is the "trusted subsystem" / BFF pattern: no IdP token-exchange machinery,
// and the API stays the single source of authorization truth.

// The scope a caller must hold for its forwarded on-behalf-of headers to be
// honored. Granted only to the MCP's own M2M application.
export const ON_BEHALF_OF_SCOPE = "act:on-behalf-of";

// Lower-case header names (HTTP headers are case-insensitive; Hono/undici surface
// them lower-cased). The roles header's PRESENCE is what activates delegation for a
// request — an absent roles header means "no delegation, use my own identity".
export const ON_BEHALF_OF_SUBJECT_HEADER = "x-on-behalf-of-subject";
export const ON_BEHALF_OF_ROLES_HEADER = "x-on-behalf-of-roles";

// Whether a service access token carries ON_BEHALF_OF_SCOPE — i.e. whether the
// API will honour the delegation headers sent with it. A DIAGNOSTIC for the
// delegating gateway's own freshly-acquired token (the MCP checks it at startup
// so a missing grant is loud instead of silently falling back to service
// identity, docs/mcp.md M32): the payload is decoded WITHOUT verification, which
// is fine because the API verifies the token on every call and nothing is
// authorized from this result. Scopes are read the way the verifier reads them
// for the provider (Auth0 `scope`; Entra app token `roles`). Returns undefined
// for a token that is not a decodable JWT (an opaque token cannot be inspected).
export function tokenGrantsOnBehalfOf(accessToken: string, provider: AuthProvider): boolean | undefined {
  let payload: ReturnType<typeof decodeJwt>;
  try {
    payload = decodeJwt(accessToken);
  } catch {
    return undefined;
  }
  const profile = providerProfile(provider);
  return profile.claims(payload, profile.defaultRolesClaim).scopes.includes(ON_BEHALF_OF_SCOPE);
}

// Serializes the forwarded role names for the roles header. JSON (not
// space-delimited) so a role name is never ambiguous.
export function serializeOnBehalfRoles(roles: string[]): string {
  return JSON.stringify(roles);
}

// Parses the roles header. Returns undefined when absent or malformed (the caller
// treats undefined as "no delegation"); string entries only.
export function parseOnBehalfRoles(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

// Produces the principal the API should authorize as, applying on-behalf-of
// delegation when — and only when — the verified caller is allowed to delegate
// (holds ON_BEHALF_OF_SCOPE) AND a roles header is present. The delegated principal
// keeps the CALLER's scopes (the transport identity's global capabilities) but
// swaps in the forwarded user's subject and roles, so the API's flow-scoped checks
// evaluate as the end user — and is no longer a service principal (`isService`
// false), since it now stands for that user. Any other request returns the
// principal unchanged.
export function resolveEffectivePrincipal(
  principal: Principal,
  headers: { subject: string | undefined; roles: string | undefined }
): Principal {
  if (!principal.scopes.includes(ON_BEHALF_OF_SCOPE)) {
    return principal;
  }
  const roles = parseOnBehalfRoles(headers.roles);
  if (roles === undefined) {
    return principal;
  }
  return {
    ...principal,
    subject: headers.subject ?? principal.subject,
    roles,
    isService: false
  };
}
