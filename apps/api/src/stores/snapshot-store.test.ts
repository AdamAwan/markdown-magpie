import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { FlowSnapshot } from "@magpie/core";
import { FileSnapshotStore, InMemorySnapshotStore } from "./snapshot-store.js";

function sampleSnapshot(flowId: string | undefined): FlowSnapshot {
  return {
    flowId,
    takenAt: "2026-06-19T00:00:00.000Z",
    catalogRevision: 7,
    gaps: [
      {
        summary: "How to configure X",
        questionIds: ["q1"],
        count: 1,
        latestAskedAt: "2026-06-19T00:00:00.000Z",
        confidence: "low"
      }
    ],
    proposals: [
      { id: "p1", title: "X", status: "pr-opened", gapClusterId: "c1", pullRequestUrl: "https://github.com/o/r/pull/1" }
    ],
    pullRequests: [
      {
        proposalId: "p1",
        url: "https://github.com/o/r/pull/1",
        merged: false,
        state: "open",
        checkedAt: "2026-06-19T00:00:00.000Z"
      }
    ]
  };
}

describe("InMemorySnapshotStore", () => {
  it("round-trips a snapshot and isolates flows", async () => {
    const store = new InMemorySnapshotStore();
    assert.equal(await store.read(undefined), undefined, "no snapshot before the first write");

    await store.write(sampleSnapshot(undefined));
    await store.write({ ...sampleSnapshot("alpha"), catalogRevision: 99 });

    assert.equal((await store.read(undefined))?.catalogRevision, 7);
    assert.equal((await store.read("alpha"))?.catalogRevision, 99, "each flow keeps its own snapshot");
    assert.equal(await store.read("beta"), undefined);
  });
});

describe("FileSnapshotStore", () => {
  it("writes per-flow files and reads them back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "magpie-snap-"));
    try {
      const store = new FileSnapshotStore(root);
      assert.equal(await store.read(undefined), undefined, "no snapshot before the first write");

      const written = sampleSnapshot(undefined);
      await store.write(written);
      const readBack = await store.read(undefined);
      assert.deepEqual(readBack, written, "the on-disk snapshot round-trips exactly");

      await store.reset();
      assert.equal(await store.read(undefined), undefined, "reset clears the snapshot root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to read a snapshot outside the root via a traversal flowId", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-snap-esc-"));
    try {
      // Plant a full, otherwise-readable snapshot directory *outside* the store root.
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

      const store = new FileSnapshotStore(path.join(base, "root"));
      // Each of these would resolve to `secret` (or its parent) once joined onto the
      // root; the confinement guard must reject them before any filesystem access.
      for (const evil of ["../secret", "..", ".", "../../etc", "a/../../secret", "sub/child"]) {
        assert.equal(await store.read(evil), undefined, `traversal flowId ${JSON.stringify(evil)} must not resolve`);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("throws rather than writing a snapshot outside the root", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "magpie-snap-esc-"));
    try {
      const store = new FileSnapshotStore(path.join(base, "root"));
      await assert.rejects(store.write(sampleSnapshot("../secret")), /flow/i);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
