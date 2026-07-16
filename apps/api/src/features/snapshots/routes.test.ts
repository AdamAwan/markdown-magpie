import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";
import { FileSnapshotStore } from "../../stores/snapshot-store.js";

describe("GET /api/snapshots/:flowId", () => {
  it("rejects an encoded ..%2F traversal instead of reading an out-of-root snapshot", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-snap-route-"));
    try {
      // A complete, otherwise-readable snapshot directory sitting outside the root.
      const secret = path.join(base, "secret");
      await mkdir(secret, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(secret, "meta.json"),
          JSON.stringify({ takenAt: "2026-06-19T00:00:00.000Z", catalogRevision: 1 })
        ),
        writeFile(path.join(secret, "gaps.json"), "[]"),
        writeFile(path.join(secret, "proposals.json"), "[]"),
        writeFile(path.join(secret, "pull-requests.json"), "[]")
      ]);

      const ctx = makeTestContext();
      ctx.stores.snapshots = new FileSnapshotStore(path.join(base, "root"));
      const app = buildApp(ctx);

      // %2F decodes to "/" only after route matching, so this reaches the handler as
      // a single flowId param whose value is "../secret" — which, joined onto
      // <base>/root, would otherwise resolve to the planted <base>/secret directory.
      const res = await app.request("/api/snapshots/..%2Fsecret");
      assert.equal(res.status, 404, "a traversal flowId must not resolve to an out-of-root snapshot");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
