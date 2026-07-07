import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStdioAuthToken } from "./main.js";

// Design-mandated guard (design §Testing strategy): auth-required stdio startup
// rejects a missing MCP_AUTH_TOKEN. resolveStdioAuthToken is the pure helper the
// startup path turns into a non-zero exit, so testing it locks the contract
// without spawning the process. Auth fails CLOSED: an unset/blank AUTH_REQUIRED
// keeps the token mandatory; only AUTH_REQUIRED=false disables it.
test("resolveStdioAuthToken throws when auth is required but the token is missing", () => {
  assert.throws(
    () => resolveStdioAuthToken({ AUTH_REQUIRED: "true" }),
    /MCP_AUTH_TOKEN is required unless AUTH_REQUIRED=false/
  );
});

test("resolveStdioAuthToken fails closed: unset AUTH_REQUIRED still requires the token", () => {
  assert.throws(() => resolveStdioAuthToken({}), /MCP_AUTH_TOKEN is required unless AUTH_REQUIRED=false/);
});

test("resolveStdioAuthToken returns the token when auth is required and present", () => {
  assert.equal(resolveStdioAuthToken({ AUTH_REQUIRED: "true", MCP_AUTH_TOKEN: "stdio-token" }), "stdio-token");
});

test("resolveStdioAuthToken returns undefined and never throws when auth is explicitly disabled", () => {
  assert.equal(resolveStdioAuthToken({ AUTH_REQUIRED: "false" }), undefined);
  // A stray token with auth disabled is still returned, keeping the disabled path
  // byte-identical to before.
  assert.equal(resolveStdioAuthToken({ AUTH_REQUIRED: "false", MCP_AUTH_TOKEN: "stray" }), "stray");
});
