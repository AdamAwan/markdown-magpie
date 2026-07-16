import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchPullRequestReviewDecision } from "./index.js";

const origFetch = globalThis.fetch;
const origToken = process.env.GITHUB_TOKEN;
afterEach(() => {
  globalThis.fetch = origFetch;
  if (origToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = origToken;
});

const PR = "https://github.com/o/r/pull/7";

// Stubs globalThis.fetch, routing the GraphQL POST and the REST reviews GET by URL.
function stubFetch(handlers: { graphql?: () => unknown; reviews?: () => unknown }): void {
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/graphql")) {
      return {
        ok: true,
        json: async () => handlers.graphql?.() ?? { data: { repository: { pullRequest: { reviewDecision: null } } } }
      };
    }
    return { ok: true, json: async () => handlers.reviews?.() ?? [] };
  }) as unknown as typeof fetch;
}

test("returns undefined with no token", async () => {
  delete process.env.GITHUB_TOKEN;
  assert.equal(await fetchPullRequestReviewDecision(PR), undefined);
});

test("returns undefined for a non-PR url", async () => {
  process.env.GITHUB_TOKEN = "t";
  assert.equal(await fetchPullRequestReviewDecision("https://example.com/x"), undefined);
});

test("maps GraphQL APPROVED to approved without hitting the reviews list", async () => {
  process.env.GITHUB_TOKEN = "t";
  let reviewsCalled = false;
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/graphql"))
      return {
        ok: true,
        json: async () => ({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } })
      };
    reviewsCalled = true;
    return { ok: true, json: async () => [] };
  }) as unknown as typeof fetch;
  assert.equal(await fetchPullRequestReviewDecision(PR), "approved");
  assert.equal(reviewsCalled, false, "approved-by-policy needs no reviews fallback");
});

test("maps GraphQL CHANGES_REQUESTED and REVIEW_REQUIRED", async () => {
  process.env.GITHUB_TOKEN = "t";
  stubFetch({ graphql: () => ({ data: { repository: { pullRequest: { reviewDecision: "CHANGES_REQUESTED" } } } }) });
  assert.equal(await fetchPullRequestReviewDecision(PR), "changes_requested");
  stubFetch({ graphql: () => ({ data: { repository: { pullRequest: { reviewDecision: "REVIEW_REQUIRED" } } } }) });
  assert.equal(await fetchPullRequestReviewDecision(PR), "review_required");
});

test("falls back to the reviews list when GraphQL decision is null: any approval counts", async () => {
  process.env.GITHUB_TOKEN = "t";
  stubFetch({ reviews: () => [{ state: "APPROVED", user: { login: "alice" } }] });
  assert.equal(await fetchPullRequestReviewDecision(PR), "approved");
});

test("fallback: a later change request from the same author supersedes their approval", async () => {
  process.env.GITHUB_TOKEN = "t";
  stubFetch({
    reviews: () => [
      { state: "APPROVED", user: { login: "alice" } },
      { state: "CHANGES_REQUESTED", user: { login: "alice" } }
    ]
  });
  assert.equal(await fetchPullRequestReviewDecision(PR), "changes_requested");
});

test("fallback: a dismissed review clears that author's verdict", async () => {
  process.env.GITHUB_TOKEN = "t";
  stubFetch({
    reviews: () => [
      { state: "CHANGES_REQUESTED", user: { login: "alice" } },
      { state: "DISMISSED", user: { login: "alice" } }
    ]
  });
  assert.equal(await fetchPullRequestReviewDecision(PR), "none");
});

test("fallback: only COMMENTED reviews mean none", async () => {
  process.env.GITHUB_TOKEN = "t";
  stubFetch({ reviews: () => [{ state: "COMMENTED", user: { login: "bob" } }] });
  assert.equal(await fetchPullRequestReviewDecision(PR), "none");
});

test("returns undefined when the GraphQL call errors", async () => {
  process.env.GITHUB_TOKEN = "t";
  globalThis.fetch = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch;
  assert.equal(await fetchPullRequestReviewDecision(PR), undefined);
});
