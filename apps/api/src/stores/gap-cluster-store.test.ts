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

  it("scopes active clusters to one flow and honours the limit", async () => {
    const store = new InMemoryGapClusterStore();
    const a = await store.createCluster({ flowId: "f1", title: "A", revision: 1 });
    const b = await store.createCluster({ flowId: "f1", title: "B", revision: 1 });
    await store.createCluster({ flowId: "f2", title: "C", revision: 1 });
    const dDefault = await store.createCluster({ title: "D", revision: 1 });

    const f1 = await store.listActiveClustersForFlow("f1");
    assert.deepEqual(f1.map((c) => c.id).sort(), [a.id, b.id].sort());

    // undefined flow matches the un-routed/default clusters only.
    const def = await store.listActiveClustersForFlow(undefined);
    assert.deepEqual(def.map((c) => c.id), [dDefault.id]);

    // Frozen clusters drop out, and the limit bounds the result.
    await store.freezeCluster(b.id);
    const limited = await store.listActiveClustersForFlow("f1", 1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0].id, a.id);
  });

  it("scopes active memberships to the cluster's flow", async () => {
    const store = new InMemoryGapClusterStore();
    const f1 = await store.createCluster({ flowId: "f1", title: "A", revision: 1 });
    const f2 = await store.createCluster({ flowId: "f2", title: "B", revision: 1 });
    await store.assignGapToCluster(f1.id, "gap-1");
    await store.assignGapToCluster(f2.id, "gap-2");

    const inF1 = await store.listActiveMembershipsForFlow("f1");
    assert.deepEqual(inF1.map((m) => m.gapId), ["gap-1"]);
    const inF2 = await store.listActiveMembershipsForFlow("f2");
    assert.deepEqual(inF2.map((m) => m.gapId), ["gap-2"]);
  });

  it("batch-assigns many gaps, deactivating any prior membership", async () => {
    const store = new InMemoryGapClusterStore();
    const a = await store.createCluster({ title: "A", revision: 1 });
    const b = await store.createCluster({ title: "B", revision: 1 });
    await store.assignGapToCluster(a.id, "gap-1", "first");

    // gap-1 moves out of A; gap-2/gap-3 are new.
    await store.assignGapsToCluster(b.id, ["gap-1", "gap-2", "gap-3"], "batch");

    assert.equal((await store.listMembershipsForCluster(a.id)).length, 0);
    const inB = await store.listMembershipsForCluster(b.id);
    assert.deepEqual(inB.map((m) => m.gapId).sort(), ["gap-1", "gap-2", "gap-3"]);
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

  it("tracks the processed revision per flow", async () => {
    const store = new InMemoryGapClusterStore();
    assert.equal(await store.getProcessedRevision(), 0);
    await store.setProcessedRevision(undefined, 7, "2026-06-18T00:00:00.000Z");
    assert.equal(await store.getProcessedRevision(), 7, "the default flow's revision advanced");

    // A different flow keeps its own counter — advancing one never touches another.
    assert.equal(await store.getProcessedRevision("alpha"), 0, "another flow is unaffected");
    await store.setProcessedRevision("alpha", 3, "2026-06-18T00:00:00.000Z");
    assert.equal(await store.getProcessedRevision("alpha"), 3);
    assert.equal(await store.getProcessedRevision(), 7, "the default flow's revision is independent");
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
