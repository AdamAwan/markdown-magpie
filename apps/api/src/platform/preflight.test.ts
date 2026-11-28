import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { assertDataPathsWritable, checkPathWritable } from "./preflight.js";

describe("checkPathWritable", () => {
  it("creates a missing directory and reports it writable", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-preflight-"));
    try {
      const target = path.join(base, "nested", "snapshots");
      const error = await checkPathWritable(target);
      assert.equal(error, undefined, "expected the created directory to be writable");
      assert.ok((await stat(target)).isDirectory(), "the directory should have been created");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("leaves no probe file behind on success", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-preflight-"));
    try {
      await checkPathWritable(base);
      await assert.rejects(stat(path.join(base, ".magpie-write-probe")), "the probe file should be cleaned up");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("returns the error message when the directory cannot be created", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-preflight-"));
    try {
      // A file where a directory is expected: mkdir of a child path must fail
      // (ENOTDIR/EEXIST) regardless of platform permission semantics.
      const asFile = path.join(base, "blocker");
      await (await import("node:fs/promises")).writeFile(asFile, "");
      const error = await checkPathWritable(path.join(asFile, "child"));
      assert.ok(error, "expected a non-empty error message");
    } finally {
      await chmod(base, 0o700).catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("assertDataPathsWritable", () => {
  it("throws one error naming every unwritable path and its env var, and only those", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-preflight-"));
    try {
      const blocker = path.join(base, "blocker");
      await writeFile(blocker, "");

      await assert.rejects(
        assertDataPathsWritable([
          { label: "Snapshot directory", envVar: "MAGPIE_SNAPSHOT_ROOT", dir: path.join(blocker, "child") },
          { label: "Checkout directory", envVar: "MAGPIE_CHECKOUT_ROOT", dir: path.join(base, "checkouts") }
        ]),
        (error: Error) => {
          assert.match(error.message, /Snapshot directory is not writable/);
          assert.match(error.message, /MAGPIE_SNAPSHOT_ROOT/);
          assert.ok(error.message.includes(path.join(blocker, "child")));
          assert.doesNotMatch(error.message, /MAGPIE_CHECKOUT_ROOT/, "the writable path is not reported");
          return true;
        }
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("resolves when every path is writable", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-preflight-"));
    try {
      await assertDataPathsWritable([
        { label: "Checkout directory", envVar: "MAGPIE_CHECKOUT_ROOT", dir: path.join(base, "checkouts") }
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
