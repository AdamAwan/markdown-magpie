import { test } from "node:test";
import assert from "node:assert/strict";
import { getBuildInfo } from "./build-info.js";

test("getBuildInfo reads sha, commit message and merge time from the environment", () => {
  const info = getBuildInfo({
    MAGPIE_BUILD_SHA: "a97380bdeadbeef",
    MAGPIE_BUILD_COMMIT_MESSAGE: "fix: write folded content into a changeset survivor",
    MAGPIE_BUILD_COMMITTED_AT: "2026-06-30T12:34:56Z"
  });

  assert.deepEqual(info, {
    sha: "a97380bdeadbeef",
    commitMessage: "fix: write folded content into a changeset survivor",
    committedAt: "2026-06-30T12:34:56Z"
  });
});

test("getBuildInfo returns nulls when the build env vars are unset (local/dev)", () => {
  const info = getBuildInfo({});

  assert.deepEqual(info, {
    sha: null,
    commitMessage: null,
    committedAt: null
  });
});

test("getBuildInfo treats blank env values as unset", () => {
  const info = getBuildInfo({
    MAGPIE_BUILD_SHA: "",
    MAGPIE_BUILD_COMMIT_MESSAGE: "   ",
    MAGPIE_BUILD_COMMITTED_AT: ""
  });

  assert.deepEqual(info, {
    sha: null,
    commitMessage: null,
    committedAt: null
  });
});
