import type { Context } from "hono";
import type { Principal } from "@magpie/auth";
import type { AppContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import type { KnowledgeCapability, KnowledgeRoleGrants } from "../stores/knowledge-repositories.js";

// Flow-scoped authorization, layered ON TOP of the existing global scope gates
// (requireScopes). The two work together: a caller must satisfy the route's scope
// AND hold the required capability on the resource's flow.
//
// The check is deliberately permissive in three cases so it can be rolled out
// without breaking an existing deployment or the machine callback paths:
//   1. No grants configured  -> feature inactive; behave exactly as before.
//   2. No principal          -> auth is disabled (local dev); scopes already passed.
//   3. principal.roles absent -> a service/machine-to-machine token. Auth0's
//      post-login Action only runs on interactive logins, so client-credentials
//      tokens (watcher, MCP) never carry the roles claim; they fall back to
//      scope-only authorization rather than being locked out of callbacks.
// Only a role-aware principal (roles claim PRESENT, even if empty) is held to the
// per-flow grants.
export function principalHasCapability(
  grants: KnowledgeRoleGrants,
  principal: Pick<Principal, "roles"> | undefined,
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
    return true; // (3) service / M2M token
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

// Context-aware convenience: evaluates a capability for the current request using
// the deployment's configured grants and the verified principal.
export function can(
  ctx: AppContext,
  c: Context,
  capability: KnowledgeCapability,
  flowId: string | undefined
): boolean {
  return principalHasCapability(ctx.knowledgeConfig.roleGrants, c.get("principal"), capability, flowId);
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
