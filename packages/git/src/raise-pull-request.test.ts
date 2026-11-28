import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { raisePullRequest } from "./index.js";

// Fakes only the GitHub REST surface; there is no real GitHub in tests.
interface Call {
  method: string;
  url: string;
}

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITHUB_TOKEN;
let calls: Call[] = [];

function fakeGitHub(handler: (call: Call) => Response): void {
  calls = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { method: init?.method ?? "GET", url };
    calls.push(call);
    return handler(call);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const REQUEST = {
  remoteUrl: "https://github.com/acme/docs.git",
  headBranch: "magpie/proposal-abc-topic",
  baseBranch: "main",
  title: "docs: topic",
  body: "body"
};
const PR = { html_url: "https://github.com/acme/docs/pull/7", number: 7 };

describe("raisePullRequest idempotency (P26)", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "ghp_test";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  it("reuses an already-open PR for the branch instead of creating a duplicate", async () => {
    fakeGitHub(() => json([PR]));
    assert.deepEqual(await raisePullRequest(REQUEST), { url: PR.html_url, number: 7 });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET"],
      "a retry whose earlier create landed opens no second PR"
    );
    assert.match(calls[0].url, /pulls\?state=open&head=acme%3Amagpie%2Fproposal-abc-topic/);
  });

  it("creates the PR when none is open", async () => {
    fakeGitHub((call) => (call.method === "GET" ? json([]) : json(PR, 201)));
    assert.deepEqual(await raisePullRequest(REQUEST), { url: PR.html_url, number: 7 });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "POST"]
    );
  });

  it("adopts the PR that won a create race (422 already exists)", async () => {
    let lookups = 0;
    fakeGitHub((call) => {
      if (call.method === "POST") {
        return json({ message: "Validation Failed: A pull request already exists for acme:magpie/x." }, 422);
      }
      lookups += 1;
      return json(lookups === 1 ? [] : [PR]);
    });
    assert.deepEqual(await raisePullRequest(REQUEST), { url: PR.html_url, number: 7 });
  });

  it("throws when the existing-PR lookup fails, rather than risking a duplicate create", async () => {
    fakeGitHub(() => json({ message: "Server Error" }, 502));
    await assert.rejects(() => raisePullRequest(REQUEST), /lookup failed \(502\)/);
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET"]
    );
  });

  it("throws on a failed create so the publish job is retried", async () => {
    fakeGitHub((call) => (call.method === "GET" ? json([]) : json({ message: "Service Unavailable" }, 503)));
    await assert.rejects(() => raisePullRequest(REQUEST), /creation failed \(503\)/);
  });

  it("degrades to undefined for a non-GitHub remote or without a token", async () => {
    fakeGitHub(() => json([]));
    assert.equal(await raisePullRequest({ ...REQUEST, remoteUrl: "https://dev.azure.com/o/p/_git/r" }), undefined);
    delete process.env.GITHUB_TOKEN;
    assert.equal(await raisePullRequest(REQUEST), undefined);
    assert.equal(calls.length, 0);
  });
});
