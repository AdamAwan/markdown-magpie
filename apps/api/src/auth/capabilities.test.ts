import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@magpie/auth";
import { principalHasCapability } from "./capabilities.js";
import type { KnowledgeRoleGrants } from "../stores/knowledge-repositories.js";

const GRANTS: KnowledgeRoleGrants = {
  "kb-hr-curators": { hr: ["read", "manage"] },
  "kb-eng-curators": { eng: ["read", "manage"] },
  "kb-askers-all": { "*": ["ask"] },
  "kb-super": { "*": ["read", "manage", "ask", "admin"] }
};

function principal(roles: string[] | undefined): Pick<Principal, "roles"> {
  return { roles };
}

test("no grants configured -> feature inactive, everything allowed", () => {
  assert.equal(principalHasCapability({}, principal([]), "manage", "hr"), true);
  assert.equal(principalHasCapability({}, principal(undefined), "admin", undefined), true);
});

test("absent principal (auth disabled) is allowed", () => {
  assert.equal(principalHasCapability(GRANTS, undefined, "manage", "hr"), true);
});

test("service/M2M token (roles claim absent) falls back to scope-only (allowed)", () => {
  assert.equal(principalHasCapability(GRANTS, principal(undefined), "manage", "eng"), true);
});

test("role-aware principal is scoped to its flow's granted capabilities", () => {
  const hr = principal(["kb-hr-curators"]);
  assert.equal(principalHasCapability(GRANTS, hr, "read", "hr"), true);
  assert.equal(principalHasCapability(GRANTS, hr, "manage", "hr"), true);
  // No access to another flow.
  assert.equal(principalHasCapability(GRANTS, hr, "read", "eng"), false);
  assert.equal(principalHasCapability(GRANTS, hr, "manage", "eng"), false);
  // No capability it wasn't granted, even on its own flow.
  assert.equal(principalHasCapability(GRANTS, hr, "admin", "hr"), false);
});

test("role-aware principal with empty roles has no flow access", () => {
  const none = principal([]);
  assert.equal(principalHasCapability(GRANTS, none, "read", "hr"), false);
  assert.equal(principalHasCapability(GRANTS, none, "ask", "hr"), false);
});

test('a "*" grant covers every flow and flow-less resources', () => {
  const asker = principal(["kb-askers-all"]);
  assert.equal(principalHasCapability(GRANTS, asker, "ask", "hr"), true);
  assert.equal(principalHasCapability(GRANTS, asker, "ask", "eng"), true);
  // flow-less resource (undefined) only matches via "*".
  assert.equal(principalHasCapability(GRANTS, asker, "ask", undefined), true);
  // but "*":["ask"] does not grant read.
  assert.equal(principalHasCapability(GRANTS, asker, "read", "hr"), false);
});

test("flow-specific read does NOT match a flow-less resource", () => {
  const hr = principal(["kb-hr-curators"]);
  assert.equal(principalHasCapability(GRANTS, hr, "read", undefined), false);
});

test("admin capability is only granted via the wildcard flow", () => {
  assert.equal(principalHasCapability(GRANTS, principal(["kb-super"]), "admin", undefined), true);
  assert.equal(principalHasCapability(GRANTS, principal(["kb-hr-curators"]), "admin", undefined), false);
});

test("multiple roles union their grants", () => {
  const both = principal(["kb-hr-curators", "kb-eng-curators"]);
  assert.equal(principalHasCapability(GRANTS, both, "manage", "hr"), true);
  assert.equal(principalHasCapability(GRANTS, both, "manage", "eng"), true);
});

test("unknown roles on the token are simply ignored", () => {
  assert.equal(principalHasCapability(GRANTS, principal(["not-a-configured-role"]), "read", "hr"), false);
});
