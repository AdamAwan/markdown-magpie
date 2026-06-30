import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpLogger, mcpLogDestination } from "./logger.js";

test("stdio transport logs to stderr (fd 2), never stdout", () => {
  assert.equal(mcpLogDestination("stdio"), 2);
});

test("http transport does not pin a file descriptor (uses default stdout)", () => {
  assert.equal(mcpLogDestination("http"), undefined);
});

test("createMcpLogger constructs a usable logger for both transports", () => {
  assert.equal(typeof createMcpLogger("stdio").info, "function");
  assert.equal(typeof createMcpLogger("http").info, "function");
});
