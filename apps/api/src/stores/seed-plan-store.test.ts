import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemorySeedPlanStore, type NewSeedPlan } from "./seed-plan-store.js";

function newPlan(overrides: Partial<NewSeedPlan> = {}): NewSeedPlan {
  return {
    flowId: "flow-1",
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
    outlineJobId: "job-1",
    sourceHash: "hash-1",
    ...overrides
  };
}

describe("InMemorySeedPlanStore", () => {
  it("create assigns id + per-item uuids + proposed status everywhere, stamps timestamps", async () => {
    const store = new InMemorySeedPlanStore();
    const plan = await store.create(newPlan());
    assert.ok(plan.id.length > 0);
    assert.equal(plan.status, "proposed");
    assert.equal(plan.origin, "manual");
    assert.equal(plan.charter, "Cover operational runbooks");
    assert.equal(plan.charterProposed, true);
    assert.equal(plan.personaProposed, false);
    assert.equal(plan.items.length, 2);
    const ids = new Set(plan.items.map((item) => item.id));
    assert.equal(ids.size, 2);
    for (const item of plan.items) {
      assert.ok(item.id.length > 0);
      assert.equal(item.status, "proposed");
      assert.equal(item.draftJobId, undefined);
    }
    assert.ok(plan.createdAt.length > 0);
    assert.equal(plan.updatedAt, plan.createdAt);
    assert.equal(plan.outlineJobId, "job-1");
    assert.equal(plan.sourceHash, "hash-1");
  });

  it("create is idempotent on outlineJobId", async () => {
    const store = new InMemorySeedPlanStore();
    const first = await store.create(newPlan({ outlineJobId: "job-1" }));
    const second = await store.create(newPlan({ outlineJobId: "job-1", rationale: "different" }));
    assert.equal(second.id, first.id);
    assert.equal(second.rationale, first.rationale);
    assert.equal((await store.listByFlow("flow-1")).length, 1);
  });

  it("listByFlow returns newest first; latestByFlow filters by status", async () => {
    const store = new InMemorySeedPlanStore();
    const first = await store.create(newPlan({ outlineJobId: "job-1" }));
    const second = await store.create(newPlan({ outlineJobId: "job-2" }));
    await store.create(newPlan({ outlineJobId: "job-other", flowId: "flow-2" }));

    const plans = await store.listByFlow("flow-1");
    assert.deepEqual(plans.map((plan) => plan.id), [second.id, first.id]);

    await store.setStatus(first.id, "dismissed");
    const latestProposed = await store.latestByFlow("flow-1", "proposed");
    assert.equal(latestProposed?.id, second.id);
    const latestDismissed = await store.latestByFlow("flow-1", "dismissed");
    assert.equal(latestDismissed?.id, first.id);
    assert.equal(await store.latestByFlow("flow-1", "approved"), undefined);
  });

  it("patch edits charter/persona text and per-item fields/status; unknown item ids are ignored", async () => {
    const store = new InMemorySeedPlanStore();
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
    assert.ok(patched);
    assert.equal(patched?.charter, "Edited charter");
    assert.equal(patched?.persona, "Edited persona");
    const edited = patched?.items.find((entry) => entry.id === item.id);
    assert.equal(edited?.title, "Edited title");
    assert.deepEqual(edited?.coverage, ["edited point"]);
    assert.equal(edited?.status, "dismissed");
    // Untouched fields survive the patch.
    assert.equal(edited?.targetPath, "runbook.md");
    const other = patched?.items.find((entry) => entry.id !== item.id);
    assert.equal(other?.status, "proposed");
    assert.ok(patched && patched.updatedAt >= patched.createdAt);
  });

  it("setItemDraftJob records the job id on exactly that item", async () => {
    const store = new InMemorySeedPlanStore();
    const plan = await store.create(newPlan());
    const updated = await store.setItemDraftJob(plan.id, plan.items[1].id, "draft-job-9");
    assert.equal(updated?.items[1].draftJobId, "draft-job-9");
    assert.equal(updated?.items[0].draftJobId, undefined);
  });

  it("setStatus flips the plan; get reflects every mutation", async () => {
    const store = new InMemorySeedPlanStore();
    const plan = await store.create(newPlan());
    const approved = await store.setStatus(plan.id, "approved");
    assert.equal(approved?.status, "approved");
    const fetched = await store.get(plan.id);
    assert.equal(fetched?.status, "approved");
    assert.equal(await store.setStatus("no-such-plan", "dismissed"), undefined);
    assert.equal(await store.get("no-such-plan"), undefined);
  });
});
