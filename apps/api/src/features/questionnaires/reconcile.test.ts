import { test } from "node:test";
import assert from "node:assert/strict";
import { isFastPathReusable } from "./reconcile.js";

test("fast-path only when exactly one candidate and reuse check passes", () => {
  assert.equal(isFastPathReusable(1, { reuse: true }), true);
  assert.equal(isFastPathReusable(2, { reuse: true }), false);
  assert.equal(
    isFastPathReusable(1, { reuse: false, reason: { kind: "new_content", sectionId: "", path: "", heading: "" } }),
    false
  );
  assert.equal(isFastPathReusable(0, { reuse: true }), false);
});
