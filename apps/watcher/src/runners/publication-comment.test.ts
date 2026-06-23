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
    type: "comment_pull_request",
    input: { pullRequestUrl: "https://github.com/o/r/pull/7", body: "folded in" }
  }) as unknown as JobView;

test("PublicationRunner supports comment_pull_request", () => {
  const runner = new PublicationRunner({} as WatcherApi, makeDeps({}));
  assert.ok(runner.supports("comment_pull_request"));
});

test("comment_pull_request posts the comment and returns its url", async () => {
  const calls: Array<{ pullRequestUrl: string; body: string }> = [];
  const deps = makeDeps({
    commentOnPullRequest: async (req) => {
      calls.push(req);
      return "https://github.com/o/r/pull/7#issuecomment-1";
    }
  });
  const runner = new PublicationRunner({} as WatcherApi, deps);
  const out = (await runner.run(job(), new AbortController().signal)) as { commentUrl?: string };
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pullRequestUrl, "https://github.com/o/r/pull/7");
  assert.equal(out.commentUrl, "https://github.com/o/r/pull/7#issuecomment-1");
});

test("comment_pull_request with no token yields no commentUrl", async () => {
  const deps = makeDeps({ commentOnPullRequest: async () => undefined });
  const runner = new PublicationRunner({} as WatcherApi, deps);
  const out = (await runner.run(job(), new AbortController().signal)) as { commentUrl?: string };
  assert.equal(out.commentUrl, undefined);
});
