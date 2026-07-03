import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkPathWritable, preflightDataPaths } from "./preflight.js";

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

describe("preflightDataPaths", () => {
  it("warns once per unwritable path, naming the path and env var", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-preflight-"));
    try {
      const blocker = path.join(base, "blocker");
      await (await import("node:fs/promises")).writeFile(blocker, "");
      const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
      const log = {
        warn: (fields: Record<string, unknown>, message: string) => warnings.push({ fields, message })
      };

      await preflightDataPaths(
        [
          { label: "Snapshot directory", envVar: "MAGPIE_SNAPSHOT_ROOT", dir: path.join(blocker, "child") },
          { label: "Checkout directory", envVar: "MAGPIE_CHECKOUT_ROOT", dir: path.join(base, "checkouts") }
        ],
        log as unknown as Parameters<typeof preflightDataPaths>[1]
      );

      assert.equal(warnings.length, 1, "only the unwritable path should warn");
      const [warning] = warnings;
      assert.match(warning.message, /Snapshot directory is not writable/);
      assert.match(warning.message, /MAGPIE_SNAPSHOT_ROOT/);
      assert.equal(warning.fields.envVar, "MAGPIE_SNAPSHOT_ROOT");
      assert.equal(warning.fields.path, path.join(blocker, "child"));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
