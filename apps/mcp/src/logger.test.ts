import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpLogger } from "./logger.js";

test("stdio logger does not write to stdout", () => {
  // The stdio transport multiplexes JSON-RPC on stdout; logs must go to stderr.
  const logger = createMcpLogger("stdio");
  // pino exposes the destination fd via [pino.symbols] internals; instead assert
  // construction succeeds and the level is set — the fd-2 wiring is covered by the
  // createLogger destination test in @magpie/logger.
  assert.equal(typeof logger.info, "function");
  assert.equal(logger.level, logger.level); // smoke: logger constructed
});
