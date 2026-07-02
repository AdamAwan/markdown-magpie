import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "@magpie/logger";
import { initTelemetry } from "./init.js";

const silent = createLogger({ level: "silent" });

test("initTelemetry returns a disabled no-op handle when telemetry is off", async () => {
  const handle = await initTelemetry({ enabled: false, serviceName: "api" }, silent);
  assert.equal(handle.enabled, false);
  // shutdown must be safe to call on the no-op handle.
  await assert.doesNotReject(handle.shutdown());
});
