import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import type { OpenPullRequestRef, WatcherApi } from "../http-client.js";
import { RefreshPullRequestsRunner } from "./refresh-pull-requests.js";

function job(): JobView {
  return {
    id: "j",
    type: "refresh_pull_requests",
    queueName: "refresh_pull_requests",
    deadLetter: false,
    state: "active",
    input: {},
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300
  };
}

function fakeApi(open: OpenPullRequestRef[]): WatcherApi {
  return {
    claim: async () => undefined,
    heartbeat: async () => ({ cancelled: false }),
    complete: async () => undefined,
    fail: async () => undefined,
    retrieve: async () => [],
    proposalExecutionContext: async () => ({ proposal: {}, repository: {} }),
    crunchExecutionContext: async () => ({ run: {}, repository: {} }),
    sourceSyncExecutionContext: async () => ({ run: {}, sourceName: "", repository: {} }),
    reconcileGaps: async () => ({ ok: true }),
    runSourceSync: async () => ({ runIds: [] }),
    triggerScheduledCrunch: async () => ({ runId: "run-1", jobId: "job-1" }),
    listOpenPullRequests: async () => open
  };
}

describe("RefreshPullRequestsRunner", () => {
  it("declares the github capability and supports only refresh_pull_requests", () => {
    const runner = new RefreshPullRequestsRunner(fakeApi([]));
    assert.equal(runner.capability, "github");
    assert.ok(runner.supports("refresh_pull_requests"));
    assert.ok(!runner.supports("publish_proposal"));
    assert.ok(!runner.supports("process_gaps_to_pull_requests"));
  });

  it("polls each open PR and returns schema-valid merged/closed results", async () => {
    const api = fakeApi([
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ]);
    const runner = new RefreshPullRequestsRunner(api, async (url) =>
      url?.endsWith("/1") ? { merged: true, state: "closed" } : { merged: false, state: "closed" }
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string; state: string; merged: boolean }>;
    };
    assert.deepEqual(output.results, [
      { proposalId: "p1", state: "closed", merged: true },
      { proposalId: "p2", state: "closed", merged: false }
    ]);
  });

  it("skips PRs whose status could not be resolved without failing the job", async () => {
    const api = fakeApi([
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "not-a-pr" }
    ]);
    const runner = new RefreshPullRequestsRunner(api, async (url) =>
      url?.endsWith("/1") ? { merged: false, state: "open" } : undefined
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string }>;
    };
    assert.deepEqual(output.results.map((r) => r.proposalId), ["p1"]);
  });

  it("continues past a lookup that throws", async () => {
    const api = fakeApi([
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ]);
    const runner = new RefreshPullRequestsRunner(api, async (url) => {
      if (url?.endsWith("/1")) throw new Error("rate limited");
      return { merged: true, state: "closed" };
    });
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string }>;
    };
    assert.deepEqual(output.results.map((r) => r.proposalId), ["p2"]);
  });

  it("aborts between requests when the signal fires", async () => {
    const controller = new AbortController();
    const api = fakeApi([
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ]);
    const runner = new RefreshPullRequestsRunner(api, async () => {
      controller.abort();
      return { merged: false, state: "open" };
    });
    await assert.rejects(() => runner.run(job(), controller.signal));
  });
});
