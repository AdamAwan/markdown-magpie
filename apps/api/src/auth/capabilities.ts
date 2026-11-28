import type { Context, MiddlewareHandler } from "hono";
import { providerProfile, type Principal } from "@magpie/auth";
import type { AppContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";
import type { KnowledgeCapability, KnowledgeRoleGrants } from "../stores/knowledge-repositories.js";

// The subset of a Principal the flow-scoped check reads: the roles claim (present vs.
// absent is load-bearing) and the POSITIVE service-identity marker the verifier
// computed from the provider's own claim (Auth0 `gty`, Entra `idtyp`).
type PrincipalForCheck = Pick<Principal, "roles" | "isService">;

// Flow-scoped authorization, layered ON TOP of the existing global scope gates
// (requireScopes). The two work together: a caller must satisfy the route's scope
// AND hold the required capability on the resource's flow.
//
// The check is deliberately permissive in three cases so it can be rolled out
// without breaking an existing deployment or the machine callback paths:
//   1. No grants configured  -> feature inactive; behave exactly as before.
//   2. No principal          -> auth is disabled (local dev); scopes already passed.
//   3. Genuine service / machine-to-machine token -> identified by the POSITIVE
//      service marker (`principal.isService`: Auth0 `gty: "client-credentials"`,
//      Entra `idtyp: "app"`), NOT by an absent roles claim. Client-credentials
//      tokens (watcher, MCP) carry no user roles (Auth0's post-login Action only
//      runs on interactive logins; Entra app-token `roles` are permissions, mapped to
//      scopes); they fall back to scope-only authorization rather than being locked
//      out of the callbacks the system depends on.
//
// Crucially, an absent roles claim is NO LONGER sufficient on its own for the
// carve-out. A human token that reaches here without a roles claim AND without the
// service marker (e.g. the Auth0 Action was removed or silently dropped the claim,
// or an Entra user has no app-role assignment) is DENIED — it must not be reclassified as an all-flows service
// principal, which would fail flow-scoping open. Only a role-aware principal (roles
// claim PRESENT, even if empty) is held to the per-flow grants.
export function principalHasCapability(
  grants: KnowledgeRoleGrants,
  principal: PrincipalForCheck | undefined,
  capability: KnowledgeCapability,
  flowId: string | undefined
): boolean {
  if (Object.keys(grants).length === 0) {
    return true; // (1) feature inactive
  }
  if (!principal) {
    return true; // (2) auth disabled
  }
  if (principal.roles === undefined) {
    // (3) Only a POSITIVE service signal grants the scope-only bypass. A roleless
    // token without the service marker is a human token whose roles claim went
    // missing -> fail closed.
    return principal.isService;
  }

  return rolesGrant(grants, principal.roles, capability, flowId);
}

// Whether any of the roles is granted the capability on the flow. A "*" grant
// covers every flow (and is the only way to match a flow-less resource, e.g. a
// proposal drafted before flows existed, or a deployment-wide capability).
function rolesGrant(
  grants: KnowledgeRoleGrants,
  roles: readonly string[],
  capability: KnowledgeCapability,
  flowId: string | undefined
): boolean {
  return roles.some((role) => {
    const perFlow = grants[role];
    if (!perFlow) {
      return false;
    }
    if (perFlow["*"]?.includes(capability)) {
      return true;
    }
    return flowId !== undefined && (perFlow[flowId]?.includes(capability) ?? false);
  });
}

// The deployment-wide capabilities that authorize privileged actions for HUMAN
// principals when the IdP's scopes are not per-user (docs/authorization.md AZ27):
// `admin` for config writes and destructive deletes/reset, `ops` for job and
// schedule management.
export type PrivilegedCapability = Extract<KnowledgeCapability, "admin" | "ops">;

// Privileged-action check, layered on top of the route's scope gate.
//
// Scopes are a per-user signal only when the IdP filters them per user (Auth0
// RBAC). Entra grants every consented delegated scope to EVERY user who can sign
// in, so on Entra a user token holding `manage:admin`/`manage:jobs` proves
// nothing about the user; the only per-user signal is the app ROLES on the token.
// So, for a human principal on a provider without per-user scopes, the action
// requires the capability on the "*" flow via KNOWLEDGE_ROLE_GRANTS — strictly:
// there is NO "no grants configured" carve-out here (the API refuses to boot on
// Entra without grants anyway), and a roleless human is denied.
//
// Unchanged cases: no principal (auth disabled; the scope layer already passed),
// a genuine service principal (its scopes are per-application permissions an
// administrator consented to), and providers whose scopes are per-user (Auth0),
// where the scope gate alone is the per-user check — exactly as before.
export function principalHasPrivilege(
  grants: KnowledgeRoleGrants,
  principal: PrincipalForCheck | undefined,
  capability: PrivilegedCapability,
  perUserScopes: boolean
): boolean {
  if (!principal || principal.isService || perUserScopes) {
    return true;
  }
  if (principal.roles === undefined) {
    return false;
  }
  return rolesGrant(grants, principal.roles, capability, undefined);
}

// Route middleware form of principalHasPrivilege: mount it after the route's
// requireScopes gate. Denies with 403 forbidden, matching requireScopes.
export function requirePrivilege(ctx: AppContext, capability: PrivilegedCapability): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get("principal");
    const perUserScopes = providerProfile(ctx.settings.auth.provider).perUserScopes;
    if (!principalHasPrivilege(ctx.knowledgeConfig.roleGrants, principal, capability, perUserScopes)) {
      logger.warn(
        { subject: principal?.subject, capability, roles: principal?.roles },
        'privileged action denied: the identity provider\'s scopes are not per-user, so this action requires the capability on "*" via a role in KNOWLEDGE_ROLE_GRANTS'
      );
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}

// A token that hits the roles-absent branch above but carries NO positive service
// marker: i.e. an interactive/human token whose roles claim was dropped or never
// emitted while flow-scoping is active. Such a token is now denied (fails closed);
// surfacing it lets an operator notice the likely IdP misconfiguration (a
// missing/removed Auth0 post-login Action, or an Entra user with no app-role
// assignment) rather than a silent lockout.
export function isRolelessHumanToken(grants: KnowledgeRoleGrants, principal: PrincipalForCheck | undefined): boolean {
  if (Object.keys(grants).length === 0) {
    return false; // feature inactive; nothing to flag
  }
  if (!principal) {
    return false; // auth disabled
  }
  return principal.roles === undefined && !principal.isService;
}

// Context-aware convenience: evaluates a capability for the current request using
// the deployment's configured grants and the verified principal.
export function can(ctx: AppContext, c: Context, capability: KnowledgeCapability, flowId: string | undefined): boolean {
  const grants = ctx.knowledgeConfig.roleGrants;
  const principal = c.get("principal");
  const allowed = principalHasCapability(grants, principal, capability, flowId);
  if (!allowed && isRolelessHumanToken(grants, principal)) {
    // Alert: a token reached a flow-scoped gate with global scopes but NO roles claim
    // and NO service marker while grants are configured. Almost always an IdP
    // misconfiguration (a missing/removed Auth0 post-login Action or dropped
    // namespaced claim; an Entra user with no app-role assignment). It is now denied
    // rather than granted all-flows access; log so the misconfiguration is visible
    // instead of silent.
    logger.warn(
      { subject: principal?.subject, capability, flowId, scopes: principal?.scopes },
      "flow-scoped access denied: token carries user-facing scopes but no roles claim and no service-identity marker while KNOWLEDGE_ROLE_GRANTS is configured; check that the identity provider emits the roles claim (AUTH_ROLES_CLAIM) for this user"
    );
  }
  return allowed;
}

// Whether the caller holds ANY of the capabilities on the flow. Read routes use
// this where more than one capability legitimately exposes the same material —
// e.g. the indexed knowledge base is the published answer corpus, which an `ask`
// grant already reaches through /api/retrieve.
export function canAny(
  ctx: AppContext,
  c: Context,
  capabilities: readonly KnowledgeCapability[],
  flowId: string | undefined
): boolean {
  return capabilities.some((capability) => can(ctx, c, capability, flowId));
}

// The configured flows whose resources a read route may return to this caller,
// for filtering a list (docs/authorization.md AZ30). `undefined` means the read
// is UNRESTRICTED — flow-scoping inactive, auth disabled, a service principal, or
// a wildcard ("*") grant of one of the capabilities — so flow-less resources stay
// visible too. Otherwise the caller sees exactly the listed flows' resources and
// no flow-less ones (a "*" grant is the only way to match a flow-less resource,
// AZ14); an empty array means nothing is visible.
export function readableFlowIds(
  ctx: AppContext,
  c: Context,
  capabilities: readonly KnowledgeCapability[]
): string[] | undefined {
  if (canAny(ctx, c, capabilities, undefined)) {
    return undefined;
  }
  const grants = ctx.knowledgeConfig.roleGrants;
  const principal = c.get("principal");
  return ctx.knowledgeConfig.flows
    .filter((flow) => capabilities.some((capability) => principalHasCapability(grants, principal, capability, flow.id)))
    .map((flow) => flow.id);
}

// Guard form: throws 403 forbidden (matching requireScopes' shape) when the
// principal lacks the capability on the flow.
export function assertCan(
  ctx: AppContext,
  c: Context,
  capability: KnowledgeCapability,
  flowId: string | undefined
): void {
  if (!can(ctx, c, capability, flowId)) {
    throw new HttpError(403, "forbidden");
  }
}
