import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobView } from "@magpie/jobs";
import { PublicationRunner, type PublicationDeps } from "./publication.js";
import type { WatcherApi } from "../http-client.js";

function makeDeps(overrides: Partial<PublicationDeps>): PublicationDeps {
  const fail = () => {
    throw new Error("unexpected dep call");
  };
  return {
    prepareRepository: fail as PublicationDeps["prepareRepository"],
    publishProposal: fail as PublicationDeps["publishProposal"],
    publishChangeset: fail as PublicationDeps["publishChangeset"],
    raisePullRequest: fail as PublicationDeps["raisePullRequest"],
    commentOnPullRequest: fail as PublicationDeps["commentOnPullRequest"],
    ...overrides
  };
}

const job = (): JobView =>
  ({
    id: "j1",
    type: "crosslink_pull_requests",
    input: {
      targets: ["kb/a.md"],
      pullRequests: [
        { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
        { proposalId: "p2", pullRequestUrl: "https://github.com/o/r/pull/2" }
      ]
    }
  }) as unknown as JobView;

test("comments on both PRs, each referencing the other", async () => {
  const calls: Array<{ pullRequestUrl: string; body: string }> = [];
  const deps = makeDeps({
    commentOnPullRequest: async (req) => {
      calls.push(req);
      return "https://github.com/o/r/pull/x#issuecomment-1";
    }
  });
  const runner = new PublicationRunner({} as WatcherApi, deps);

  const out = (await runner.run(job(), new AbortController().signal)) as { commented: string[] };
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pullRequestUrl, "https://github.com/o/r/pull/1");
  assert.match(calls[0].body, /pull\/2/);
  assert.match(calls[0].body, /kb\/a\.md/);
  assert.equal(calls[1].pullRequestUrl, "https://github.com/o/r/pull/2");
  assert.match(calls[1].body, /pull\/1/);
  assert.equal(out.commented.length, 2);
});

test("token-less comment (undefined) yields no commented urls", async () => {
  const deps = makeDeps({ commentOnPullRequest: async () => undefined });
  const runner = new PublicationRunner({} as WatcherApi, deps);
  const out = (await runner.run(job(), new AbortController().signal)) as { commented: string[] };
  assert.equal(out.commented.length, 0);
});
