import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStdioAuthToken } from "./main.js";

// Design-mandated guard (design §Testing strategy): auth-required stdio startup
// rejects a missing MCP_AUTH_TOKEN. resolveStdioAuthToken is the pure helper the
// startup path turns into a non-zero exit, so testing it locks the contract
// without spawning the process.
test("resolveStdioAuthToken throws when auth is required but the token is missing", () => {
  assert.throws(
    () => resolveStdioAuthToken({ AUTH_REQUIRED: "true" }),
    /MCP_AUTH_TOKEN is required when AUTH_REQUIRED=true/
  );
});

test("resolveStdioAuthToken returns the token when auth is required and present", () => {
  assert.equal(
    resolveStdioAuthToken({ AUTH_REQUIRED: "true", MCP_AUTH_TOKEN: "stdio-token" }),
    "stdio-token"
  );
});

test("resolveStdioAuthToken returns undefined and never throws when auth is disabled", () => {
  assert.equal(resolveStdioAuthToken({}), undefined);
  // A stray token without AUTH_REQUIRED is still returned, keeping the disabled
  // path byte-identical to before.
  assert.equal(resolveStdioAuthToken({ MCP_AUTH_TOKEN: "stray" }), "stray");
});
