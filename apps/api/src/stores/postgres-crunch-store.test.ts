import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { CrunchPlan } from "@magpie/core";
import { PostgresCrunchStore } from "./postgres-crunch-store.js";
import type { CrunchRunInput } from "./crunch-store.js";

// Integration tests for the Postgres-backed crunch store. They self-skip
// unless DATABASE_URL points at a migrated database (see scripts/migrate.mjs);
// CI provides one via a pgvector service container. This is the template to
// follow for the other Postgres* stores — round-trip through real SQL and
// assert by the ids you created so parallel rows never make the suite flaky.
const databaseUrl = process.env.DATABASE_URL;

// Each run gets a unique flow/destination so rows never collide across tests.
function draftRun(): CrunchRunInput {
  return {
    flowId: `flow-${randomUUID()}`,
    destinationId: `dest-${randomUUID()}`,
    trigger: "manual",
    status: "running",
    documentCount: 5
  };
}

function samplePlan(): CrunchPlan {
  return { summary: "Consolidate cat care docs", operations: [], rationale: "Reduce duplication" };
}

describe("PostgresCrunchStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresCrunchStore(databaseUrl as string);

  it("round-trips a run through create and get", async () => {
    const created = await store.createRun(draftRun());
    assert.equal(created.status, "running");
    assert.equal(created.documentCount, 5);

    const fetched = await store.getRun(created.id);
    assert.equal(fetched?.id, created.id);
    assert.equal(fetched?.status, created.status);
    assert.equal(fetched?.documentCount, created.documentCount);
  });

  it("creates a run with optional fields and retrieves them", async () => {
    const jobId = `job-${randomUUID()}`;
    const created = await store.createRun({
      ...draftRun(),
      jobId
    });
    assert.equal(created.jobId, jobId);

    const fetched = await store.getRun(created.id);
    assert.equal(fetched?.jobId, jobId);
  });

  it("finds a run by job id", async () => {
    const jobId = `lookup-${randomUUID()}`;
    const created = await store.createRun({
      ...draftRun(),
      jobId
    });

    const fetched = await store.getRunByJobId(jobId);
    assert.equal(fetched?.id, created.id);
    assert.equal(fetched?.jobId, jobId);
  });

  it("completes a run with a plan", async () => {
    const created = await store.createRun(draftRun());
    const plan = samplePlan();

    const completed = await store.completeRun(created.id, plan);
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.plan, plan);
    assert.ok(completed?.completedAt);

    const fetched = await store.getRun(created.id);
    assert.equal(fetched?.status, "completed");
    assert.deepEqual(fetched?.plan, plan);
  });

  it("fails a run with an error message", async () => {
    const created = await store.createRun(draftRun());
    const errorMsg = "something went wrong";

    const failed = await store.failRun(created.id, errorMsg);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, errorMsg);
    assert.ok(failed?.completedAt);

    const fetched = await store.getRun(created.id);
    assert.equal(fetched?.status, "failed");
    assert.equal(fetched?.error, errorMsg);
  });

  it("records a publication on a run", async () => {
    const created = await store.createRun(draftRun());
    const publication = {
      provider: "local-git" as const,
      branchName: `magpie/crunch-${randomUUID()}`,
      commitSha: "abc123",
      publishedAt: new Date().toISOString()
    };

    const published = await store.recordRunPublication(created.id, publication);
    assert.equal(published?.status, "published");
    assert.deepEqual(published?.publication, publication);

    const fetched = await store.getRun(created.id);
    assert.equal(fetched?.status, "published");
    assert.deepEqual(fetched?.publication, publication);
  });

  it("lists runs ordered by creation time", async () => {
    const first = await store.createRun(draftRun());
    const second = await store.createRun(draftRun());

    const runs = await store.listRuns(100);
    const ids = runs.map((r) => r.id);
    assert.ok(ids.includes(first.id), "first run should appear in list");
    assert.ok(ids.includes(second.id), "second run should appear in list");
  });

  it("gets settings for a specific flow", async () => {
    const flowId = `flow-${randomUUID()}`;
    const settings = await store.getSettings(flowId);
    assert.equal(settings.flowId, flowId);
    assert.equal(settings.enabled, false);
    assert.equal(settings.cron, "0 2 * * *");
  });

  it("gets default settings when flow id is undefined", async () => {
    const settings = await store.getSettings(undefined);
    assert.equal(settings.flowId, undefined);
    assert.equal(settings.enabled, false);
  });

  it("updates settings and retrieves updated values", async () => {
    const flowId = `flow-${randomUUID()}`;
    const updated = await store.updateSettings(flowId, {
      enabled: true,
      cron: "0 0 * * *"
    });

    assert.equal(updated.flowId, flowId);
    assert.equal(updated.enabled, true);
    assert.equal(updated.cron, "0 0 * * *");

    const fetched = await store.getSettings(flowId);
    assert.equal(fetched.enabled, true);
    assert.equal(fetched.cron, "0 0 * * *");
  });

  it("returns undefined when updating or fetching an unknown run id", async () => {
    assert.equal(await store.getRun("00000000-0000-0000-0000-000000000000"), undefined);
    assert.equal(
      await store.completeRun("00000000-0000-0000-0000-000000000000", samplePlan()),
      undefined
    );
    assert.equal(
      await store.failRun("00000000-0000-0000-0000-000000000000", "error"),
      undefined
    );
  });
});
