import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePrimaryBranch } from "./primary-branch.js";

test("configured branch wins over every detected value", () => {
  assert.equal(
    resolvePrimaryBranch({
      configuredBranch: "release",
      detectedDefault: "main",
      detectedCurrent: "feature"
    }),
    "release"
  );
});

test("detected default is used when no branch is configured", () => {
  assert.equal(
    resolvePrimaryBranch({ detectedDefault: "main", detectedCurrent: "feature" }),
    "main"
  );
});

test("detected current is used when configured and default are absent", () => {
  assert.equal(resolvePrimaryBranch({ detectedCurrent: "master" }), "master");
});

test("falls back to main when nothing is known", () => {
  assert.equal(resolvePrimaryBranch({}), "main");
});

test("whitespace-only values are treated as absent at each level", () => {
  assert.equal(
    resolvePrimaryBranch({
      configuredBranch: "   ",
      detectedDefault: "",
      detectedCurrent: "develop"
    }),
    "develop"
  );
});

test("the resolved branch is trimmed", () => {
  assert.equal(resolvePrimaryBranch({ configuredBranch: "  main  " }), "main");
});
