import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import type { WatcherApi } from "../http-client.js";
import { MaintenanceRunner } from "./maintenance.js";

function job(type: JobView["type"], input: unknown): JobView {
  return {
    id: "j",
    type,
    queueName: type,
    deadLetter: false,
    state: "active",
    input,
    retryCount: 0,
    retryLimit: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 3600
  };
}

function fakeApi(overrides: Partial<WatcherApi> = {}): WatcherApi {
  return {
    claim: async () => undefined,
    heartbeat: async () => ({ cancelled: false }),
    complete: async () => undefined,
    fail: async () => undefined,
    retrieve: async () => [],
    proposalExecutionContext: async () => ({ proposal: {}, repository: {} }),
    reconcileGaps: async () => ({ ok: true }),
    runSourceSync: async () => ({ runIds: [] }),
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
    runImprovePatrol: async () => ({ runId: "run-1", selectedCount: 0, enqueuedCount: 0 }),
    listOpenPullRequests: async () => [],
    ...overrides
  };
}

describe("MaintenanceRunner", () => {
  it("declares the maintenance capability and supports the maintenance job types", () => {
    const runner = new MaintenanceRunner(fakeApi());
    assert.equal(runner.capability, "maintenance");
    assert.ok(runner.supports("process_gaps_to_pull_requests"));
    assert.ok(runner.supports("source_change_sync"));
    assert.ok(runner.supports("fix_patrol"));
    assert.ok(runner.supports("improve_patrol"));
    assert.ok(!runner.supports("answer_question"));
    // refresh_pull_requests is a github-capability job, not maintenance.
    assert.ok(!runner.supports("refresh_pull_requests"));
  });

  it("POSTs the source-sync orchestration endpoint and returns schema-valid run ids", async () => {
    let called: string | undefined = "unset";
    const api = fakeApi({
      runSourceSync: async (flowId) => {
        called = flowId;
        return { runIds: ["run-1", "run-2"] };
      }
    });
    const runner = new MaintenanceRunner(api);
    const output = (await runner.run(job("source_change_sync", {}), new AbortController().signal)) as {
      runIds: string[];
    };
    assert.equal(called, undefined, "no flowId in input ⇒ watch every configured git source");
    assert.deepEqual(output.runIds, ["run-1", "run-2"]);
  });

  it("forwards a flowId to the source-sync orchestration endpoint when present", async () => {
    let called: string | undefined = "unset";
    const api = fakeApi({
      runSourceSync: async (flowId) => {
        called = flowId;
        return { runIds: [] };
      }
    });
    const runner = new MaintenanceRunner(api);
    const output = (await runner.run(
      job("source_change_sync", { flowId: "flow-x" }),
      new AbortController().signal
    )) as { runIds: string[] };
    assert.equal(called, "flow-x");
    assert.deepEqual(output.runIds, []);
  });

  it("POSTs the fix-patrol endpoint and returns schema-valid output", async () => {
    const calls: Array<string | undefined> = [];
    const api = fakeApi({
      runFixPatrol: async (flowId) => {
        calls.push(flowId);
        return { runId: "run-9", selectedCount: 3, findingCount: 1 };
      }
    });
    const runner = new MaintenanceRunner(api);
    const output = (await runner.run(job("fix_patrol", { flowId: "billing" }), new AbortController().signal)) as {
      runId: string;
      selectedCount: number;
      findingCount: number;
    };
    assert.deepEqual(calls, ["billing"]);
    assert.equal(output.runId, "run-9");
    assert.equal(output.selectedCount, 3);
    assert.equal(output.findingCount, 1);
  });

  it("patrols the default flow when no flowId is present", async () => {
    const calls: Array<string | undefined> = [];
    const api = fakeApi({
      runFixPatrol: async (flowId) => {
        calls.push(flowId);
        return { runId: "run-10", selectedCount: 0, findingCount: 0 };
      }
    });
    const runner = new MaintenanceRunner(api);
    await runner.run(job("fix_patrol", {}), new AbortController().signal);
    assert.deepEqual(calls, [undefined]);
  });

  it("POSTs the improve-patrol endpoint and returns schema-valid output", async () => {
    const calls: Array<string | undefined> = [];
    const api = fakeApi({
      runImprovePatrol: async (flowId) => {
        calls.push(flowId);
        return { runId: "run-11", selectedCount: 2, enqueuedCount: 2 };
      }
    });
    const runner = new MaintenanceRunner(api);
    const output = (await runner.run(job("improve_patrol", { flowId: "billing" }), new AbortController().signal)) as {
      runId: string;
      selectedCount: number;
      enqueuedCount: number;
    };
    assert.deepEqual(calls, ["billing"]);
    assert.equal(output.runId, "run-11");
    assert.equal(output.selectedCount, 2);
    assert.equal(output.enqueuedCount, 2);
  });

  it("improve-patrols the default flow when no flowId is present", async () => {
    const calls: Array<string | undefined> = [];
    const api = fakeApi({
      runImprovePatrol: async (flowId) => {
        calls.push(flowId);
        return { runId: "run-12", selectedCount: 0, enqueuedCount: 0 };
      }
    });
    const runner = new MaintenanceRunner(api);
    await runner.run(job("improve_patrol", {}), new AbortController().signal);
    assert.deepEqual(calls, [undefined]);
  });

  it("POSTs the reconcile endpoint and returns schema-valid output", async () => {
    let called: string | undefined = "unset";
    const api = fakeApi({
      reconcileGaps: async (flowId) => {
        called = flowId;
        return { ok: true };
      }
    });
    const runner = new MaintenanceRunner(api);
    const output = (await runner.run(job("process_gaps_to_pull_requests", {}), new AbortController().signal)) as {
      drafted: number;
      published: number;
    };
    assert.equal(called, undefined, "no flowId in input ⇒ reconcile the default flow");
    assert.equal(output.drafted, 0);
    assert.equal(output.published, 0);
  });

  it("forwards a flowId from the job input when present", async () => {
    let called: string | undefined = "unset";
    const api = fakeApi({
      reconcileGaps: async (flowId) => {
        called = flowId;
        return { ok: true };
      }
    });
    const runner = new MaintenanceRunner(api);
    await runner.run(job("process_gaps_to_pull_requests", { flowId: "flow-x" }), new AbortController().signal);
    assert.equal(called, "flow-x");
  });

  it("rejects job types it does not handle", async () => {
    const runner = new MaintenanceRunner(fakeApi());
    await assert.rejects(() => runner.run(job("answer_question", {}), new AbortController().signal));
  });
});
