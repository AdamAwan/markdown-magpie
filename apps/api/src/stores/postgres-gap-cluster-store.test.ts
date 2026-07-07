import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresGapClusterStore } from "./postgres-gap-cluster-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Self-skips unless DATABASE_URL points at a migrated database (see
// scripts/migrate.mjs). Run via `npm run test:db`.
const databaseUrl = process.env.DATABASE_URL;

describe("PostgresGapClusterStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresGapClusterStore(makeTestPool(databaseUrl as string));

  it("round-trips an active cluster", async () => {
    const title = `cluster-${randomUUID()}`;
    const created = await store.createCluster({ flowId: "flow-a", title, rationale: "why", revision: 2 });
    assert.equal(created.title, title);
    assert.equal(created.status, "active");
    assert.equal(created.reconciliationRevision, 2);

    const fetched = await store.getCluster(created.id);
    assert.equal(fetched?.title, title);

    const active = await store.listActiveClusters();
    assert.ok(active.some((c) => c.id === created.id));
  });

  it("enforces one active membership per gap across clusters", async () => {
    const a = await store.createCluster({ title: `a-${randomUUID()}`, revision: 1 });
    const b = await store.createCluster({ title: `b-${randomUUID()}`, revision: 1 });
    // A real gap row is required by the FK; create one via raw SQL helper.
    const gapId = await insertGap(databaseUrl as string);

    await store.assignGapToCluster(a.id, gapId, "first");
    await store.assignGapToCluster(b.id, gapId, "moved");

    assert.equal((await store.listMembershipsForCluster(a.id)).length, 0);
    const inB = await store.listMembershipsForCluster(b.id);
    assert.equal(inB.length, 1);
    assert.equal(inB[0].gapId, gapId);
  });

  it("scopes active clusters and memberships to a flow", async () => {
    const flow = `flow-${randomUUID()}`;
    const inFlow = await store.createCluster({ flowId: flow, title: `in-${randomUUID()}`, revision: 1 });
    const otherFlow = await store.createCluster({ flowId: `other-${randomUUID()}`, title: "x", revision: 1 });
    const gapId = await insertGap(databaseUrl as string);
    await store.assignGapToCluster(inFlow.id, gapId, "in");

    const clusters = await store.listActiveClustersForFlow(flow);
    assert.deepEqual(clusters.map((c) => c.id), [inFlow.id]);
    assert.ok(!clusters.some((c) => c.id === otherFlow.id));

    const memberships = await store.listActiveMembershipsForFlow(flow);
    assert.deepEqual(memberships.map((m) => m.gapId), [gapId]);

    // The limit bounds the scan.
    const second = await store.createCluster({ flowId: flow, title: `in2-${randomUUID()}`, revision: 1 });
    const limited = await store.listActiveClustersForFlow(flow, 1);
    assert.equal(limited.length, 1);
    assert.ok([inFlow.id, second.id].includes(limited[0].id));
  });

  it("batch-assigns many gaps in one call, deactivating any prior membership", async () => {
    const a = await store.createCluster({ title: `a-${randomUUID()}`, revision: 1 });
    const b = await store.createCluster({ title: `b-${randomUUID()}`, revision: 1 });
    const g1 = await insertGap(databaseUrl as string);
    const g2 = await insertGap(databaseUrl as string);
    await store.assignGapToCluster(a.id, g1, "first");

    await store.assignGapsToCluster(b.id, [g1, g2], "batch");

    assert.equal((await store.listMembershipsForCluster(a.id)).length, 0);
    const inB = await store.listMembershipsForCluster(b.id);
    assert.deepEqual(inB.map((m) => m.gapId).sort(), [g1, g2].sort());
  });

  it("freezes clusters", async () => {
    const c = await store.createCluster({ title: `f-${randomUUID()}`, revision: 1 });
    await store.freezeCluster(c.id);
    assert.equal((await store.getCluster(c.id))?.status, "frozen");
    assert.ok(!(await store.listActiveClusters()).some((x) => x.id === c.id));
  });

  it("persists the processed revision per flow", async () => {
    await store.setProcessedRevision(undefined, 11, new Date(0).toISOString());
    assert.equal(await store.getProcessedRevision(), 11);
    await store.setProcessedRevision(undefined, 12, new Date(1000).toISOString());
    assert.equal(await store.getProcessedRevision(), 12);

    // A named flow tracks independently of the default flow.
    await store.setProcessedRevision("alpha", 5, new Date(2000).toISOString());
    assert.equal(await store.getProcessedRevision("alpha"), 5);
    assert.equal(await store.getProcessedRevision(), 12, "the default flow is unaffected");
  });

  it("persists the reshape composition hash per flow, independent of the processed revision", async () => {
    const flow = `hash-${randomUUID()}`;
    // Unset until the first reshape.
    assert.equal(await store.getReshapeCompositionHash(flow), undefined);

    // setReshapeCompositionHash can seed the flow's row before setProcessedRevision.
    await store.setReshapeCompositionHash(flow, "hash-1");
    assert.equal(await store.getReshapeCompositionHash(flow), "hash-1");
    assert.equal(await store.getProcessedRevision(flow), 0, "seeding the hash leaves the revision at its default");

    // A later processed-revision write must not clobber the hash.
    await store.setProcessedRevision(flow, 7, new Date(3000).toISOString());
    assert.equal(await store.getReshapeCompositionHash(flow), "hash-1", "the hash survives a processed-revision write");
    assert.equal(await store.getProcessedRevision(flow), 7);

    // And updating the hash must not disturb the revision.
    await store.setReshapeCompositionHash(flow, "hash-2");
    assert.equal(await store.getReshapeCompositionHash(flow), "hash-2");
    assert.equal(await store.getProcessedRevision(flow), 7, "updating the hash leaves the revision alone");
  });

  it("round-trips the representative embedding, clearing on null", async () => {
    const embedding = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
    const replacement = Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1 : 0));

    const created = await store.createCluster({
      title: `rep-${randomUUID()}`,
      revision: 1,
      representativeEmbedding: embedding
    });
    assert.deepEqual((await store.getCluster(created.id))?.representativeEmbedding, embedding);

    await store.setClusterRepresentative(created.id, replacement);
    assert.deepEqual((await store.getCluster(created.id))?.representativeEmbedding, replacement);

    await store.setClusterRepresentative(created.id, null);
    assert.equal((await store.getCluster(created.id))?.representativeEmbedding, undefined);

    const bare = await store.createCluster({ title: `bare-${randomUUID()}`, revision: 1 });
    assert.equal((await store.getCluster(bare.id))?.representativeEmbedding, undefined);
  });

  it("queues and retries publication actions", async () => {
    const proposalId = await insertProposal(databaseUrl as string);
    const action = await store.enqueuePublicationAction(proposalId, "publish");
    assert.equal(action.status, "pending");

    await store.markPublicationActionFailed(action.id, "boom");
    const pending = await store.listPendingPublicationActions();
    const mine = pending.find((a) => a.id === action.id);
    assert.equal(mine?.attempts, 1);
    assert.equal(mine?.lastError, "boom");

    await store.markPublicationActionDone(action.id);
    assert.ok(!(await store.listPendingPublicationActions()).some((a) => a.id === action.id));
  });
});

// Minimal raw-SQL helpers so FK constraints are satisfied without coupling to the
// other stores' APIs.
async function insertGap(databaseUrl: string): Promise<string> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const q = await pool.query<{ id: string }>(
      "INSERT INTO questions (id, question, chat_provider, asked_at) VALUES ($1, 'q', 'codex', now()) RETURNING id",
      [`q-${randomUUID()}`]
    );
    const g = await pool.query<{ id: string }>(
      "INSERT INTO question_gaps (question_id, summary) VALUES ($1, $2) RETURNING id::text AS id",
      [q.rows[0].id, `gap-${randomUUID()}`]
    );
    return g.rows[0].id;
  } finally {
    await pool.end();
  }
}

async function insertProposal(databaseUrl: string): Promise<string> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const id = `prop-${randomUUID()}`;
  try {
    await pool.query(
      "INSERT INTO proposals (id, title, status, target_path, markdown) VALUES ($1, 't', 'draft', 'p.md', '#')",
      [id]
    );
    return id;
  } finally {
    await pool.end();
  }
}
