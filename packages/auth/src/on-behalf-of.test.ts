import { test } from "node:test";
import assert from "node:assert/strict";
import type { Principal } from "./index.js";
import {
  ON_BEHALF_OF_SCOPE,
  parseOnBehalfRoles,
  resolveEffectivePrincipal,
  serializeOnBehalfRoles
} from "./on-behalf-of.js";

function principal(scopes: string[], roles?: string[]): Principal {
  return { subject: "svc@clients", scopes, roles, payload: {} };
}

test("serialize/parse round-trips role names", () => {
  assert.equal(serializeOnBehalfRoles(["a", "b"]), '["a","b"]');
  assert.deepEqual(parseOnBehalfRoles('["a","b"]'), ["a", "b"]);
});

test("parseOnBehalfRoles returns undefined for absent or malformed, and drops non-strings", () => {
  assert.equal(parseOnBehalfRoles(undefined), undefined);
  assert.equal(parseOnBehalfRoles("{not json"), undefined);
  assert.equal(parseOnBehalfRoles('"nope"'), undefined); // not an array
  assert.deepEqual(parseOnBehalfRoles('["a",1,null,"b"]'), ["a", "b"]);
  assert.deepEqual(parseOnBehalfRoles("[]"), []);
});

test("delegation is ignored when the caller lacks the on-behalf-of scope", () => {
  const caller = principal(["read:knowledge"]); // no act:on-behalf-of
  const effective = resolveEffectivePrincipal(caller, {
    subject: "auth0|user",
    roles: '["kb-hr-curators"]'
  });
  assert.equal(effective, caller, "forged headers must not affect a non-delegating caller");
});

test("delegation is ignored when the roles header is absent (no delegation on this request)", () => {
  const caller = principal([ON_BEHALF_OF_SCOPE, "read:knowledge"]);
  const effective = resolveEffectivePrincipal(caller, { subject: "auth0|user", roles: undefined });
  assert.equal(effective, caller);
});

test("a trusted caller with a roles header is re-scoped to the forwarded user", () => {
  const caller = principal([ON_BEHALF_OF_SCOPE, "read:knowledge", "ask:knowledge"], undefined);
  const effective = resolveEffectivePrincipal(caller, {
    subject: "auth0|user-1",
    roles: '["kb-hr-curators"]'
  });
  // Caller's scopes (transport identity) are preserved...
  assert.deepEqual(effective.scopes, [ON_BEHALF_OF_SCOPE, "read:knowledge", "ask:knowledge"]);
  // ...but subject + roles become the forwarded user's, so flow-scoped checks act
  // as the user. roles present (even []) flips the service bypass into enforcement.
  assert.equal(effective.subject, "auth0|user-1");
  assert.deepEqual(effective.roles, ["kb-hr-curators"]);
});

test("an empty forwarded roles list is fail-closed (role-aware with no flow access)", () => {
  const caller = principal([ON_BEHALF_OF_SCOPE], undefined);
  const effective = resolveEffectivePrincipal(caller, { subject: "auth0|user", roles: "[]" });
  assert.deepEqual(effective.roles, []);
});
