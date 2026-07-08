import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import type { OpenPullRequestRef, WatcherApi } from "../http-client.js";
import { RefreshFlowSnapshotRunner } from "./refresh-flow-snapshot.js";

function job(): JobView {
  return {
    id: "j",
    type: "refresh_flow_snapshot",
    queueName: "refresh_flow_snapshot",
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
    routeByEmbedding: async () => ({ status: "abstain" }),
    proposalExecutionContext: async () => ({ proposal: {}, repository: {} }),
    reconcileGaps: async () => ({ ok: true }),
    verifyClosure: async () => ({ proposalId: "p", closureStatus: "verified_closed", perQuestion: [] }),
    runSourceSync: async () => ({ runIds: [] }),
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
    runImprovePatrol: async () => ({ runId: "run-1", selectedCount: 0, enqueuedCount: 0 }),
    listOpenPullRequests: async () => open,
    sourceMapEntries: async () => []
  };
}

describe("RefreshFlowSnapshotRunner", () => {
  it("declares the github capability and supports only refresh_flow_snapshot", () => {
    const runner = new RefreshFlowSnapshotRunner(fakeApi([]));
    assert.equal(runner.capability, "github");
    assert.ok(runner.supports("refresh_flow_snapshot"));
    assert.ok(!runner.supports("publish_proposal"));
    assert.ok(!runner.supports("process_gaps_to_pull_requests"));
  });

  it("polls each open PR and returns schema-valid merged/closed results", async () => {
    const api = fakeApi([
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ]);
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async (url) =>
        url?.endsWith("/1")
          ? { merged: true, state: "closed", mergeable: "unknown" }
          : { merged: false, state: "closed", mergeable: "unknown" },
      async () => "none"
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string; state: string; merged: boolean }>;
    };
    assert.deepEqual(output.results, [
      { proposalId: "p1", state: "closed", merged: true },
      { proposalId: "p2", state: "closed", merged: false }
    ]);
  });

  it("attaches the review decision for a still-open PR", async () => {
    const api = fakeApi([{ proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" }]);
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async () => ({ merged: false, state: "open", mergeable: "mergeable" }),
      async () => "approved"
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string; reviewDecision?: string }>;
    };
    assert.equal(output.results[0].reviewDecision, "approved");
  });

  it("reports mergeable=conflicting for a still-open stale PR", async () => {
    const api = fakeApi([{ proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" }]);
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async () => ({ merged: false, state: "open", mergeable: "conflicting" }),
      async () => "none"
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string; mergeable?: string }>;
    };
    assert.equal(output.results[0].mergeable, "conflicting");
  });

  it("omits an unknown mergeability so it carries no signal", async () => {
    const api = fakeApi([{ proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" }]);
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async () => ({ merged: false, state: "open", mergeable: "unknown" }),
      async () => "none"
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string; mergeable?: string }>;
    };
    assert.equal("mergeable" in output.results[0], false);
  });

  it("does not look up the review decision for a merged/closing PR", async () => {
    const api = fakeApi([{ proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" }]);
    let reviewLookups = 0;
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async () => ({ merged: true, state: "closed", mergeable: "unknown" }),
      async () => {
        reviewLookups += 1;
        return "approved";
      }
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string; reviewDecision?: string }>;
    };
    assert.equal(reviewLookups, 0, "a closing PR needs no review lookup");
    assert.equal(output.results[0].reviewDecision, undefined);
  });

  it("still reports an open PR when the review lookup throws", async () => {
    const api = fakeApi([{ proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" }]);
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async () => ({ merged: false, state: "open", mergeable: "unknown" }),
      async () => {
        throw new Error("graphql exploded");
      }
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string; state: string; reviewDecision?: string }>;
    };
    assert.deepEqual(output.results, [{ proposalId: "p1", state: "open", merged: false }]);
  });

  it("skips PRs whose status could not be resolved without failing the job", async () => {
    const api = fakeApi([
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "not-a-pr" }
    ]);
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async (url) => (url?.endsWith("/1") ? { merged: false, state: "open", mergeable: "mergeable" } : undefined),
      async () => "none"
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string }>;
    };
    assert.deepEqual(output.results.map((r) => r.proposalId), ["p1"]);
  });

  it("continues past a status lookup that throws", async () => {
    const api = fakeApi([
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ]);
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async (url) => {
        if (url?.endsWith("/1")) throw new Error("rate limited");
        return { merged: true, state: "closed", mergeable: "unknown" };
      },
      async () => "none"
    );
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
    const runner = new RefreshFlowSnapshotRunner(
      api,
      async () => {
        controller.abort();
        return { merged: false, state: "open", mergeable: "mergeable" };
      },
      async () => "none"
    );
    await assert.rejects(() => runner.run(job(), controller.signal));
  });
});
