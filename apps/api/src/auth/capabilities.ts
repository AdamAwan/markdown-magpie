import type { Context } from "hono";
import { isClientCredentialsToken, type Principal } from "@magpie/auth";
import type { AppContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";
import type { KnowledgeCapability, KnowledgeRoleGrants } from "../stores/knowledge-repositories.js";

// The subset of a Principal the flow-scoped check reads: the roles claim (present vs.
// absent is load-bearing) and the raw token payload (to detect the POSITIVE
// client-credentials marker).
type PrincipalForCheck = Pick<Principal, "roles" | "payload">;

// Flow-scoped authorization, layered ON TOP of the existing global scope gates
// (requireScopes). The two work together: a caller must satisfy the route's scope
// AND hold the required capability on the resource's flow.
//
// The check is deliberately permissive in three cases so it can be rolled out
// without breaking an existing deployment or the machine callback paths:
//   1. No grants configured  -> feature inactive; behave exactly as before.
//   2. No principal          -> auth is disabled (local dev); scopes already passed.
//   3. Genuine service / machine-to-machine token -> identified by the POSITIVE
//      client-credentials marker (`gty: "client-credentials"`), NOT by an absent
//      roles claim. Auth0's post-login Action only runs on interactive logins, so
//      client-credentials tokens (watcher, MCP) never carry the roles claim; they
//      fall back to scope-only authorization rather than being locked out of the
//      callbacks the system depends on.
//
// Crucially, an absent roles claim is NO LONGER sufficient on its own for the
// carve-out. A human token that reaches here without a roles claim AND without the
// client-credentials marker (e.g. the Auth0 Action was removed or silently dropped
// the claim) is DENIED — it must not be reclassified as an all-flows service
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
    // token without the client-credentials marker is a human token whose roles claim
    // went missing -> fail closed.
    return isClientCredentialsToken(principal.payload);
  }

  return principal.roles.some((role) => {
    const perFlow = grants[role];
    if (!perFlow) {
      return false;
    }
    // A "*" grant covers every flow (and is the only way to match a flow-less
    // resource, e.g. a proposal drafted before flows existed).
    if (perFlow["*"]?.includes(capability)) {
      return true;
    }
    return flowId !== undefined && (perFlow[flowId]?.includes(capability) ?? false);
  });
}

// A token that hits the roles-absent branch above but carries NO positive
// client-credentials marker: i.e. an interactive/human token whose roles claim was
// dropped or never emitted while flow-scoping is active. Such a token is now denied
// (fails closed); surfacing it lets an operator notice the likely IdP misconfiguration
// (a missing/removed Auth0 post-login Action) rather than a silent lockout.
export function isRolelessHumanToken(
  grants: KnowledgeRoleGrants,
  principal: PrincipalForCheck | undefined
): boolean {
  if (Object.keys(grants).length === 0) {
    return false; // feature inactive; nothing to flag
  }
  if (!principal) {
    return false; // auth disabled
  }
  return principal.roles === undefined && !isClientCredentialsToken(principal.payload);
}

// Context-aware convenience: evaluates a capability for the current request using
// the deployment's configured grants and the verified principal.
export function can(
  ctx: AppContext,
  c: Context,
  capability: KnowledgeCapability,
  flowId: string | undefined
): boolean {
  const grants = ctx.knowledgeConfig.roleGrants;
  const principal = c.get("principal");
  const allowed = principalHasCapability(grants, principal, capability, flowId);
  if (!allowed && isRolelessHumanToken(grants, principal)) {
    // Alert: a token reached a flow-scoped gate with global scopes but NO roles claim
    // and NO client-credentials marker while grants are configured. Almost always a
    // missing/removed Auth0 post-login Action (or a dropped namespaced claim). It is
    // now denied rather than granted all-flows access; log so the misconfiguration is
    // visible instead of silent.
    logger.warn(
      { subject: principal?.subject, capability, flowId, scopes: principal?.scopes },
      "flow-scoped access denied: token carries user-facing scopes but no roles claim and no client-credentials marker while KNOWLEDGE_ROLE_GRANTS is configured; check the Auth0 post-login Action that emits the roles claim"
    );
  }
  return allowed;
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
