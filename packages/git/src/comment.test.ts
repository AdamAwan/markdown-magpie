import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { commentOnPullRequest } from "./index.js";

const origFetch = globalThis.fetch;
const origToken = process.env.GITHUB_TOKEN;
afterEach(() => {
  globalThis.fetch = origFetch;
  if (origToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = origToken;
});

test("returns undefined when there is no token", async () => {
  delete process.env.GITHUB_TOKEN;
  const out = await commentOnPullRequest({ pullRequestUrl: "https://github.com/o/r/pull/7", body: "hi" });
  assert.equal(out, undefined);
});

test("returns undefined for a non-PR url", async () => {
  process.env.GITHUB_TOKEN = "t";
  const out = await commentOnPullRequest({ pullRequestUrl: "https://example.com/x", body: "hi" });
  assert.equal(out, undefined);
});

test("posts to the issues comments endpoint and returns the comment url", async () => {
  process.env.GITHUB_TOKEN = "t";
  let calledUrl = "";
  let calledBody = "";
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calledUrl = url;
    calledBody = init.body;
    return { ok: true, json: async () => ({ html_url: "https://github.com/o/r/pull/7#issuecomment-1" }) };
  }) as unknown as typeof fetch;

  const out = await commentOnPullRequest({ pullRequestUrl: "https://github.com/o/r/pull/7", body: "hello" });
  assert.equal(calledUrl, "https://api.github.com/repos/o/r/issues/7/comments");
  assert.deepEqual(JSON.parse(calledBody), { body: "hello" });
  assert.equal(out, "https://github.com/o/r/pull/7#issuecomment-1");
});
