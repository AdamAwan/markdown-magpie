import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresSeedPlanStore } from "./postgres-seed-plan-store.js";
import type { NewSeedPlan } from "./seed-plan-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Self-skips unless DATABASE_URL points at a migrated database (see
// scripts/migrate.mjs). Run via `npm run test:db`.
const databaseUrl = process.env.DATABASE_URL;

function newPlan(overrides: Partial<NewSeedPlan> = {}): NewSeedPlan {
  return {
    flowId: `flow-${randomUUID()}`,
    origin: "manual",
    charter: "Cover operational runbooks",
    persona: "on-call engineers",
    charterProposed: true,
    personaProposed: false,
    items: [
      { title: "Runbook", targetPath: "runbook.md", coverage: ["how to restart"], questions: ["how do I restart?"] },
      { title: "Alerts", coverage: ["alert routing"] }
    ],
    rationale: "The sources cover operations end to end.",
    notes: "focus on operations",
    outlineJobId: `job-${randomUUID()}`,
    sourceHash: "hash-1",
    ...overrides
  };
}

describe("PostgresSeedPlanStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const pool = makeTestPool(databaseUrl as string);
  const store = new PostgresSeedPlanStore(pool);

  it("migration 0051 applied: seed_plans table and proposals.seed_plan_id exist", async () => {
    const table = await pool.query("SELECT to_regclass('seed_plans') AS name");
    assert.equal(table.rows[0].name, "seed_plans");
    const column = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'proposals' AND column_name = 'seed_plan_id'"
    );
    assert.equal(column.rowCount, 1);
  });

  it("create assigns id + per-item uuids + proposed status, stamps timestamps", async () => {
    const plan = await store.create(newPlan());
    assert.ok(plan.id.length > 0);
    assert.equal(plan.status, "proposed");
    assert.equal(plan.items.length, 2);
    for (const item of plan.items) {
      assert.ok(item.id.length > 0);
      assert.equal(item.status, "proposed");
    }
    assert.equal(plan.charterProposed, true);
    assert.equal(plan.personaProposed, false);
    assert.ok(plan.createdAt.length > 0);
  });

  it("create is idempotent on outlineJobId", async () => {
    const outlineJobId = `job-${randomUUID()}`;
    const flowId = `flow-${randomUUID()}`;
    const first = await store.create(newPlan({ outlineJobId, flowId }));
    const second = await store.create(newPlan({ outlineJobId, flowId, rationale: "different" }));
    assert.equal(second.id, first.id);
    assert.equal(second.rationale, first.rationale);
    assert.equal((await store.listByFlow(flowId)).length, 1);
  });

  it("listByFlow returns newest first; latestByFlow filters by status", async () => {
    const flowId = `flow-${randomUUID()}`;
    const first = await store.create(newPlan({ flowId }));
    const second = await store.create(newPlan({ flowId }));

    const plans = await store.listByFlow(flowId);
    assert.deepEqual(
      plans.map((plan) => plan.id),
      [second.id, first.id]
    );

    await store.setStatus(first.id, "dismissed");
    assert.equal((await store.latestByFlow(flowId, "proposed"))?.id, second.id);
    assert.equal((await store.latestByFlow(flowId, "dismissed"))?.id, first.id);
    assert.equal(await store.latestByFlow(flowId, "approved"), undefined);
  });

  it("patch edits charter/persona and per-item fields/status; unknown item ids are ignored", async () => {
    const plan = await store.create(newPlan());
    const item = plan.items[0];
    const patched = await store.patch(plan.id, {
      charter: "Edited charter",
      persona: "Edited persona",
      items: [
        { id: item.id, title: "Edited title", coverage: ["edited point"], status: "dismissed" },
        { id: "no-such-item", title: "ignored" }
      ]
    });
    assert.equal(patched?.charter, "Edited charter");
    assert.equal(patched?.persona, "Edited persona");
    const edited = patched?.items.find((entry) => entry.id === item.id);
    assert.equal(edited?.title, "Edited title");
    assert.deepEqual(edited?.coverage, ["edited point"]);
    assert.equal(edited?.status, "dismissed");
    assert.equal(edited?.targetPath, "runbook.md");
    const other = patched?.items.find((entry) => entry.id !== item.id);
    assert.equal(other?.status, "proposed");
  });

  it("revise replaces items with fresh ids and updates rationale/charter, keeping provenance flags", async () => {
    const plan = await store.create(newPlan());
    const oldIds = new Set(plan.items.map((item) => item.id));
    const revised = await store.revise(plan.id, {
      items: [{ title: "Only", coverage: ["one point"] }],
      charter: "Narrowed charter",
      rationale: "Reshaped per instruction"
    });
    assert.equal(revised?.id, plan.id);
    assert.equal(revised?.rationale, "Reshaped per instruction");
    assert.equal(revised?.charter, "Narrowed charter");
    // Omitted persona keeps its prior value; provenance flags survive.
    assert.equal(revised?.persona, plan.persona);
    assert.equal(revised?.charterProposed, true);
    assert.equal(revised?.items.length, 1);
    assert.equal(revised?.items[0].status, "proposed");
    assert.ok(revised && !oldIds.has(revised.items[0].id));
    assert.equal(await store.revise(randomUUID(), { items: [], rationale: "x" }), undefined);
  });

  it("setItemDraftJob records the job id on exactly that item", async () => {
    const plan = await store.create(newPlan());
    const updated = await store.setItemDraftJob(plan.id, plan.items[1].id, "draft-job-9");
    assert.equal(updated?.items[1].draftJobId, "draft-job-9");
    assert.equal(updated?.items[0].draftJobId, undefined);
  });

  it("setStatus flips the plan; get reflects the change; unknown ids yield undefined", async () => {
    const plan = await store.create(newPlan());
    const approved = await store.setStatus(plan.id, "approved");
    assert.equal(approved?.status, "approved");
    assert.equal((await store.get(plan.id))?.status, "approved");
    assert.equal(await store.setStatus(randomUUID(), "dismissed"), undefined);
    assert.equal(await store.get(randomUUID()), undefined);
  });
});
