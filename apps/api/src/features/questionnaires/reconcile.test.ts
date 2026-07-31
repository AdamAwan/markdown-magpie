import { test } from "node:test";
import assert from "node:assert/strict";
import { directionsMatch, isFastPathReusable } from "./reconcile.js";

test("fast-path needs one candidate, a passing reuse check, and a matching direction", () => {
  assert.equal(isFastPathReusable(1, { reuse: true }, true), true);
  assert.equal(isFastPathReusable(1, { reuse: true }, false), false);
  assert.equal(isFastPathReusable(2, { reuse: true }, true), false);
  assert.equal(
    isFastPathReusable(
      1,
      { reuse: false, reason: { kind: "new_content", sectionId: "", path: "", heading: "" } },
      true
    ),
    false
  );
  assert.equal(isFastPathReusable(0, { reuse: true }, true), false);
});

test("directionsMatch treats absent, empty and whitespace as the same no-direction", () => {
  assert.equal(directionsMatch(undefined, undefined), true);
  assert.equal(directionsMatch(undefined, ""), true);
  assert.equal(directionsMatch("  \n ", undefined), true);
  assert.equal(directionsMatch("", "   "), true);
});

test("directionsMatch compares exactly after trimming", () => {
  assert.equal(directionsMatch("Company, not product.", "  Company, not product.  "), true);
  assert.equal(directionsMatch("Company, not product.", "Company not product."), false);
  assert.equal(directionsMatch("Company, not product.", undefined), false);
  assert.equal(directionsMatch(undefined, "Company, not product."), false);
});
