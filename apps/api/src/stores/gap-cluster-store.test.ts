import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryGapClusterStore } from "./gap-cluster-store.js";

describe("InMemoryGapClusterStore", () => {
  it("creates an active cluster and lists it", async () => {
    const store = new InMemoryGapClusterStore();
    const cluster = await store.createCluster({ flowId: "f1", title: "Cheese & cats", rationale: "r", revision: 3 });
    assert.equal(cluster.status, "active");
    assert.equal(cluster.flowId, "f1");
    assert.equal(cluster.reconciliationRevision, 3);

    const active = await store.listActiveClusters();
    assert.deepEqual(active.map((c) => c.id), [cluster.id]);
  });

  it("keeps exactly one active membership per gap", async () => {
    const store = new InMemoryGapClusterStore();
    const a = await store.createCluster({ title: "A", revision: 1 });
    const b = await store.createCluster({ title: "B", revision: 1 });

    await store.assignGapToCluster(a.id, "gap-1", "first");
    await store.assignGapToCluster(b.id, "gap-1", "moved");

    const inA = await store.listMembershipsForCluster(a.id);
    const inB = await store.listMembershipsForCluster(b.id);
    assert.equal(inA.length, 0, "gap moved out of A");
    assert.equal(inB.length, 1, "gap now active in B");
    assert.equal(inB[0].gapId, "gap-1");
  });

  it("freezes a cluster so it no longer lists as active", async () => {
    const store = new InMemoryGapClusterStore();
    const c = await store.createCluster({ title: "A", revision: 1 });
    await store.freezeCluster(c.id);
    assert.deepEqual(await store.listActiveClusters(), []);
    const fetched = await store.getCluster(c.id);
    assert.equal(fetched?.status, "frozen");
  });

  it("tracks the processed revision", async () => {
    const store = new InMemoryGapClusterStore();
    assert.equal(await store.getProcessedRevision(), 0);
    await store.setProcessedRevision(7, "2026-06-18T00:00:00.000Z");
    assert.equal(await store.getProcessedRevision(), 7);
  });

  it("enqueues and drains publication actions", async () => {
    const store = new InMemoryGapClusterStore();
    const action = await store.enqueuePublicationAction("prop-1", "publish");
    assert.equal(action.status, "pending");

    const pending = await store.listPendingPublicationActions();
    assert.equal(pending.length, 1);

    await store.markPublicationActionDone(action.id);
    assert.deepEqual(await store.listPendingPublicationActions(), []);

    const action2 = await store.enqueuePublicationAction("prop-2", "supersede");
    await store.markPublicationActionFailed(action2.id, "push rejected");
    const stillPending = await store.listPendingPublicationActions();
    // Failed actions are retryable: they stay visible to the next run.
    assert.equal(stillPending.length, 1);
    assert.equal(stillPending[0].attempts, 1);
    assert.equal(stillPending[0].lastError, "push rejected");
  });
});
