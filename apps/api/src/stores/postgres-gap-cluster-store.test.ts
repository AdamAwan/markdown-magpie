import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresGapClusterStore } from "./postgres-gap-cluster-store.js";

// Self-skips unless DATABASE_URL points at a migrated database (see
// scripts/migrate.mjs). Run via `npm run test:db`.
const databaseUrl = process.env.DATABASE_URL;

describe("PostgresGapClusterStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresGapClusterStore(databaseUrl as string);

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
