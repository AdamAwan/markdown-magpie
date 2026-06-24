# Approval-State Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reconcile gate treat a human-approved PR as non-touchable so the at-draft fold never silently rewrites an approved PR; when an incoming draft overlaps only approved PRs, publish it as its own PR instead.

**Architecture:** The watcher derives each open PR's review decision from GitHub (GraphQL `reviewDecision`, falling back to the REST reviews list), reports it through the `refresh_pull_requests` job output, the API persists it on a new `Proposal.reviewDecision` field, and `openPullRequestSummaries` sets `touchable = reviewDecision !== "approved"`. The gate's decision logic is unchanged — it already defers when every overlap is non-touchable. `reconcileDraftedProposal` gains a `defer` branch that publishes the rival.

**Tech Stack:** TypeScript ESM monorepo (npm workspaces), zod, pg, Node built-in test runner (`node --import tsx --test`), GitHub REST + GraphQL.

**Spec:** `docs/superpowers/specs/2026-06-24-approval-state-tracking-design.md`

## Global Constraints

- UK English in all prose and comments.
- ESM: local imports use a `.js` suffix; `@magpie/*` imports do not.
- `ReviewDecision = "approved" | "changes_requested" | "review_required" | "none"` is defined once in `@magpie/core` and mirrored literally in the zod `z.enum`. Only `"approved"` locks a PR; every other value and the *absence* of a value leave it touchable.
- The gate is defer-conservative: an unknown/undetermined approval state means touchable. A refresh result with no `reviewDecision` must never overwrite a stored value.
- New job-output fields go on the zod schema (`packages/jobs/src/schemas.ts`); this schema uses no `satisfies`, so the enum is mirrored as a string literal list.
- knip runs strict (`npm run deadcode`): every new export must have a consumer. Keep helpers that have no cross-module consumer un-exported (file-local).
- The real gates before push: root `npm run typecheck`, root `npm run deadcode`, and root `npm test` (ALL workspaces — never a subset).
- Two watcher tests fail only on local Windows (a `cat`-based stdin test and a path-separator test); they pass on CI Linux and are not regressions.

---

### Task 1: `ReviewDecision` type + `@magpie/git` review-decision helper

**Files:**
- Modify: `packages/core/src/index.ts` (add `ReviewDecision` type + `Proposal.reviewDecision` field)
- Modify: `packages/git/src/index.ts` (add `fetchPullRequestReviewDecision` + two private helpers; extend the `@magpie/core` type import)
- Create: `packages/git/src/review-decision.test.ts`

**Interfaces:**
- Produces: `export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none"` (core); `Proposal.reviewDecision?: ReviewDecision` (core); `export async function fetchPullRequestReviewDecision(pullRequestUrl: string | undefined): Promise<ReviewDecision | undefined>` (git).
- Consumes: existing private `parseGitHubPullRequestUrl` and `githubFetch` in `packages/git/src/index.ts`; `process.env.GITHUB_TOKEN`.

- [ ] **Step 1: Add the `ReviewDecision` type and `Proposal` field in core**

In `packages/core/src/index.ts`, immediately **above** the `export interface Proposal {` line (currently line 195), add:

```ts
// The watcher's normalised reading of a pull request's review state. Only
// "approved" locks a PR against folding; every other value — and the absence of
// any value — leaves it touchable. Derived from GitHub's GraphQL reviewDecision,
// falling back to its REST reviews list (see @magpie/git fetchPullRequestReviewDecision).
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";
```

Then inside the `Proposal` interface, add this field directly after the `publication?: ProposalPublication;` line:

```ts
  // The latest review decision observed on this proposal's pull request, polled by
  // the watcher's refresh_pull_requests job. Absent until the PR has been polled (or
  // for proposals drafted before this was tracked). An approved PR is non-touchable:
  // the reconcile gate will not fold another change into it.
  reviewDecision?: ReviewDecision;
```

- [ ] **Step 2: Write the failing git tests**

Create `packages/git/src/review-decision.test.ts`:

```ts
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
      return { ok: true, json: async () => handlers.graphql?.() ?? { data: { repository: { pullRequest: { reviewDecision: null } } } } };
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
    if (url.includes("/graphql")) return { ok: true, json: async () => ({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } }) };
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @magpie/git`
Expected: FAIL — `fetchPullRequestReviewDecision` is not exported.

- [ ] **Step 4: Implement the helper in `packages/git/src/index.ts`**

First extend the existing `@magpie/core` type import (lines 1-9) to include `ReviewDecision`. The import is `import type { ... } from "@magpie/core";` — add `ReviewDecision` to that brace list.

Then add the following directly **after** the `fetchPullRequestStatus` function (after line 353, before the `parseGitHubPullRequestUrl` definition):

```ts
// Reads a pull request's review decision. GitHub's GraphQL reviewDecision is the
// authoritative "approved per policy" signal (it accounts for required reviewers,
// CODEOWNERS, and branch protection). When the repository requires no reviews
// GitHub returns null; we then fall back to the REST reviews list and treat any
// human approval with no outstanding change request as approved. Returns undefined
// in the same skip cases as fetchPullRequestStatus (not a GitHub PR url, no token)
// and on any lookup error, so callers treat "couldn't determine" uniformly — an
// undetermined decision leaves the PR touchable.
export async function fetchPullRequestReviewDecision(
  pullRequestUrl: string | undefined
): Promise<ReviewDecision | undefined> {
  const ref = parseGitHubPullRequestUrl(pullRequestUrl);
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!ref || !token) {
    return undefined;
  }
  try {
    const decision = await readReviewDecisionFromGraphql(ref, token);
    if (decision !== null) {
      return decision;
    }
    return await readApprovalFromReviews(ref, token);
  } catch {
    // A failed review lookup must never fail the refresh job; "couldn't determine"
    // is reported as undefined and treated as touchable downstream.
    return undefined;
  }
}

type PullRequestRef = { owner: string; repo: string; number: number };

// GraphQL reviewDecision → our enum. Returns null when GitHub has no policy verdict
// (the repo requires no reviews), signalling the caller to use the reviews fallback.
async function readReviewDecisionFromGraphql(
  ref: PullRequestRef,
  token: string
): Promise<Exclude<ReviewDecision, "none"> | null> {
  const query =
    "query($owner:String!,$repo:String!,$number:Int!){" +
    "repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision}}}";
  const response = await githubFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "markdown-magpie"
    },
    body: JSON.stringify({ query, variables: { owner: ref.owner, repo: ref.repo, number: ref.number } })
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL review lookup failed (${response.status})`);
  }
  const body = (await response.json()) as {
    data?: { repository?: { pullRequest?: { reviewDecision?: string | null } } };
  };
  switch (body.data?.repository?.pullRequest?.reviewDecision ?? null) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return null;
  }
}

// REST fallback: reduce the reviews list (oldest-first) to the latest meaningful
// review per author, then any outstanding change request loses, else any approval
// wins, else none.
async function readApprovalFromReviews(ref: PullRequestRef, token: string): Promise<ReviewDecision> {
  const response = await githubFetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "markdown-magpie"
      }
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub reviews lookup failed (${response.status})`);
  }
  const reviews = (await response.json()) as Array<{ state?: string; user?: { login?: string } | null }>;
  const latestByAuthor = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    switch (review.state) {
      case "APPROVED":
        latestByAuthor.set(login, "APPROVED");
        break;
      case "CHANGES_REQUESTED":
        latestByAuthor.set(login, "CHANGES_REQUESTED");
        break;
      case "DISMISSED":
        latestByAuthor.delete(login);
        break;
      // COMMENTED / PENDING and anything else are not verdicts; ignore.
    }
  }
  const verdicts = [...latestByAuthor.values()];
  if (verdicts.includes("CHANGES_REQUESTED")) {
    return "changes_requested";
  }
  if (verdicts.includes("APPROVED")) {
    return "approved";
  }
  return "none";
}
```

- [ ] **Step 5: Run the git tests to verify they pass**

Run: `npm test -w @magpie/git`
Expected: PASS (all review-decision tests, plus the existing comment/publisher tests).

- [ ] **Step 6: Verify core builds**

Run: `npm run build -w @magpie/core`
Expected: success (the new type and field compile).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/git/src/index.ts packages/git/src/review-decision.test.ts
git commit -m "feat(git): derive a pull request's review decision from GitHub"
```

---

### Task 2: Carry `reviewDecision` on the `refresh_pull_requests` output schema

**Files:**
- Modify: `packages/jobs/src/schemas.ts:230-236` (`refreshPullRequestsOutputSchema`)
- Modify: `packages/jobs/src/schemas.test.ts` (add round-trip tests)

**Interfaces:**
- Produces: `refreshPullRequestsOutputSchema` result objects now allow an optional `reviewDecision` field with the four `ReviewDecision` values.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing schema tests**

Append to `packages/jobs/src/schemas.test.ts`. Add `refreshPullRequestsOutputSchema` to the import block at the top (the existing `import { ... } from "./schemas.js";`), then add:

```ts
test("refresh output schema accepts a result with a reviewDecision", () => {
  const parsed = refreshPullRequestsOutputSchema.parse({
    results: [{ proposalId: "p1", state: "open", merged: false, reviewDecision: "approved" }]
  });
  assert.equal(parsed.results[0].reviewDecision, "approved");
});

test("refresh output schema leaves reviewDecision absent when not provided", () => {
  const parsed = refreshPullRequestsOutputSchema.parse({
    results: [{ proposalId: "p1", state: "closed", merged: true }]
  });
  assert.equal(parsed.results[0].reviewDecision, undefined);
});

test("refresh output schema rejects an unknown reviewDecision value", () => {
  assert.ok(
    !refreshPullRequestsOutputSchema.safeParse({
      results: [{ proposalId: "p1", state: "open", merged: false, reviewDecision: "maybe" }]
    }).success
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/jobs`
Expected: FAIL — the schema strips/rejects `reviewDecision`.

- [ ] **Step 3: Add the field to the schema**

In `packages/jobs/src/schemas.ts`, change `refreshPullRequestsOutputSchema` (lines 230-236) to:

```ts
export const refreshPullRequestsOutputSchema = z.object({
  results: z.array(z.object({
    proposalId: z.string(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    // Mirrors @magpie/core ReviewDecision. Optional: the watcher only attaches it
    // for still-open PRs it could read; a missing value means "undetermined".
    reviewDecision: z.enum(["approved", "changes_requested", "review_required", "none"]).optional()
  }))
});
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/jobs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jobs/src/schemas.ts packages/jobs/src/schemas.test.ts
git commit -m "feat(jobs): allow reviewDecision on refresh_pull_requests results"
```

---

### Task 3: Watcher reports the review decision

**Files:**
- Modify: `apps/watcher/src/runners/refresh-pull-requests.ts`
- Modify: `apps/watcher/src/runners/refresh-pull-requests.test.ts`

**Interfaces:**
- Consumes: `fetchPullRequestReviewDecision` from `@magpie/git` (Task 1); `ReviewDecision` from `@magpie/core`; `refreshPullRequestsOutputSchema` (Task 2).
- Produces: each result the runner emits now carries `reviewDecision?` for still-open PRs. The runner constructor gains a third parameter `fetchPullRequestReviewDecision` (defaulting to the real helper, mirroring `fetchPullRequestStatus`).

- [ ] **Step 1: Update the failing runner tests**

Replace the body of `apps/watcher/src/runners/refresh-pull-requests.test.ts` from the `describe(...)` block onward (keep lines 1-38, the imports + `job()` + `fakeApi()` helpers) with:

```ts
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
    const runner = new RefreshPullRequestsRunner(
      api,
      async (url) => (url?.endsWith("/1") ? { merged: true, state: "closed" } : { merged: false, state: "closed" }),
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
    const runner = new RefreshPullRequestsRunner(
      api,
      async () => ({ merged: false, state: "open" }),
      async () => "approved"
    );
    const output = (await runner.run(job(), new AbortController().signal)) as {
      results: Array<{ proposalId: string; reviewDecision?: string }>;
    };
    assert.equal(output.results[0].reviewDecision, "approved");
  });

  it("does not look up the review decision for a merged/closing PR", async () => {
    const api = fakeApi([{ proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" }]);
    let reviewLookups = 0;
    const runner = new RefreshPullRequestsRunner(
      api,
      async () => ({ merged: true, state: "closed" }),
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
    const runner = new RefreshPullRequestsRunner(
      api,
      async () => ({ merged: false, state: "open" }),
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
    const runner = new RefreshPullRequestsRunner(
      api,
      async (url) => (url?.endsWith("/1") ? { merged: false, state: "open" } : undefined),
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
    const runner = new RefreshPullRequestsRunner(
      api,
      async (url) => {
        if (url?.endsWith("/1")) throw new Error("rate limited");
        return { merged: true, state: "closed" };
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
    const runner = new RefreshPullRequestsRunner(
      api,
      async () => {
        controller.abort();
        return { merged: false, state: "open" };
      },
      async () => "none"
    );
    await assert.rejects(() => runner.run(job(), controller.signal));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="RefreshPullRequestsRunner"`
Expected: FAIL — the constructor takes no third arg and results carry no `reviewDecision`.

- [ ] **Step 3: Implement the runner change**

Replace `apps/watcher/src/runners/refresh-pull-requests.ts` with:

```ts
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import { refreshPullRequestsOutputSchema } from "@magpie/jobs";
import {
  fetchPullRequestStatus as defaultFetchPullRequestStatus,
  fetchPullRequestReviewDecision as defaultFetchPullRequestReviewDecision
} from "@magpie/git";
import type { ReviewDecision } from "@magpie/core";
import type { WatcherApi } from "../http-client.js";

// The two GitHub lookups the runner needs, injected so tests stay offline.
export type FetchPullRequestStatus = typeof defaultFetchPullRequestStatus;
export type FetchPullRequestReviewDecision = typeof defaultFetchPullRequestReviewDecision;

// Polls the open pull requests raised from proposals and reports each one's
// merged/closed state — and, for still-open PRs, its review decision — back to the
// API, which applies the proposal-status transitions and persists the review
// decision. Registered only under the github capability: the watcher holds the
// GitHub token the API no longer does, so PR polling lives here rather than in the
// API's reconciler.
export class RefreshPullRequestsRunner {
  readonly capability: JobCapability = "github";

  constructor(
    private readonly api: WatcherApi,
    private readonly fetchPullRequestStatus: FetchPullRequestStatus = defaultFetchPullRequestStatus,
    private readonly fetchPullRequestReviewDecision: FetchPullRequestReviewDecision = defaultFetchPullRequestReviewDecision
  ) {}

  supports(type: JobType): boolean {
    return type === "refresh_pull_requests";
  }

  async run(_job: JobView, signal: AbortSignal): Promise<unknown> {
    const open = await this.api.listOpenPullRequests(signal);
    console.log(`refresh_pull_requests: checking ${open.length} open pull request(s)`);
    const results: Array<{ proposalId: string; state: "open" | "closed"; merged: boolean; reviewDecision?: ReviewDecision }> = [];
    for (const pr of open) {
      // Honour cancellation/shutdown between host calls so a long list aborts promptly.
      signal.throwIfAborted();
      let status: { merged: boolean; state: "open" | "closed" } | undefined;
      try {
        status = await this.fetchPullRequestStatus(pr.pullRequestUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : "pull request lookup failed";
        console.warn(`refresh_pull_requests: PR status check failed for proposal ${pr.proposalId}: ${message}`);
        continue;
      }
      if (!status) {
        // Not a resolvable PR / no token / gone: leave the proposal untouched this run.
        continue;
      }
      // Only a still-open, un-merged PR can be locked by an approval; a merged/closing
      // PR is transitioning to merged/rejected this run, so skip the extra lookup.
      let reviewDecision: ReviewDecision | undefined;
      if (status.state === "open" && !status.merged) {
        try {
          reviewDecision = await this.fetchPullRequestReviewDecision(pr.pullRequestUrl);
        } catch (error) {
          const message = error instanceof Error ? error.message : "review decision lookup failed";
          console.warn(`refresh_pull_requests: review decision check failed for proposal ${pr.proposalId}: ${message}`);
        }
      }
      results.push({
        proposalId: pr.proposalId,
        state: status.state,
        merged: status.merged,
        ...(reviewDecision ? { reviewDecision } : {})
      });
    }
    console.log(`refresh_pull_requests: resolved ${results.length}/${open.length} pull request(s)`);
    return refreshPullRequestsOutputSchema.parse({ results });
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="RefreshPullRequestsRunner"`
Expected: PASS (all eight cases).

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/runners/refresh-pull-requests.ts apps/watcher/src/runners/refresh-pull-requests.test.ts
git commit -m "feat(watcher): report each open PR's review decision"
```

---

### Task 4: Persist `reviewDecision` on the proposal store (+ migration)

**Files:**
- Modify: `apps/api/src/stores/proposal-store.ts` (interface + `InMemoryProposalStore`)
- Modify: `apps/api/src/stores/postgres-proposal-store.ts` (method + `ProposalRow` + `mapRow`)
- Create: `packages/db/migrations/0028_proposal_review_decision.sql`
- Modify: `apps/api/src/stores/proposal-store.test.ts` (add tests)

**Interfaces:**
- Consumes: `ReviewDecision` and `Proposal.reviewDecision` from `@magpie/core` (Task 1).
- Produces: `ProposalStore.updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined>` on both store implementations.

- [ ] **Step 1: Create the migration**

Create `packages/db/migrations/0028_proposal_review_decision.sql`:

```sql
-- The latest review decision observed on a proposal's pull request, polled by the
-- watcher's refresh_pull_requests job. Nullable: proposals without an open PR (or
-- drafted before this migration) have no review decision. The reconcile gate reads
-- it to keep an approved PR non-touchable, so fold never rewrites an approved PR.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS review_decision text;
```

- [ ] **Step 2: Write the failing store tests**

Append to `apps/api/src/stores/proposal-store.test.ts`:

```ts
test("updateReviewDecision sets and returns the decision", async () => {
  const store = new InMemoryProposalStore();
  const created = await store.create(draft("refunds"));
  assert.equal(created.reviewDecision, undefined);

  const updated = await store.updateReviewDecision(created.id, "approved");
  assert.equal(updated?.reviewDecision, "approved");
  assert.equal((await store.get(created.id))?.reviewDecision, "approved");
});

test("updateReviewDecision returns undefined for an unknown proposal", async () => {
  const store = new InMemoryProposalStore();
  assert.equal(await store.updateReviewDecision("nope", "approved"), undefined);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -w @magpie/api -- --test-name-pattern="updateReviewDecision"`
Expected: FAIL — `updateReviewDecision` does not exist.

- [ ] **Step 4: Add the method to the interface and in-memory store**

In `apps/api/src/stores/proposal-store.ts`:

Extend the `@magpie/core` import (line 2) to include `ReviewDecision`:

```ts
import type { DraftContext, DraftMarkdownProposalJobOutput, Proposal, ReviewDecision } from "@magpie/core";
```

Add to the `ProposalStore` interface, after the `updateMarkdown` line:

```ts
  updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined>;
```

Add to `InMemoryProposalStore`, after the `updateMarkdown` method:

```ts
  async updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: Proposal = { ...existing, reviewDecision };
    this.proposals.set(id, updated);
    return updated;
  }
```

- [ ] **Step 5: Add the method to the postgres store**

In `apps/api/src/stores/postgres-proposal-store.ts`:

Extend the `@magpie/core` import (line 3) to include `ReviewDecision`:

```ts
import type { Citation, DraftContext, Proposal, ReviewDecision } from "@magpie/core";
```

Add the method after `updateMarkdown` (after line 108):

```ts
  async updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET review_decision = $2 WHERE id = $1 RETURNING *",
      [id, reviewDecision]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }
```

Add to the `ProposalRow` interface, after the `publication` line (line 138):

```ts
  review_decision: string | null;
```

Add to `mapRow`, after the `publication` line (line 158):

```ts
    reviewDecision: (row.review_decision as ReviewDecision | null) ?? undefined,
```

- [ ] **Step 6: Run to verify pass**

Run: `npm test -w @magpie/api -- --test-name-pattern="updateReviewDecision"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/stores/proposal-store.ts apps/api/src/stores/postgres-proposal-store.ts packages/db/migrations/0028_proposal_review_decision.sql apps/api/src/stores/proposal-store.test.ts
git commit -m "feat(api): persist a proposal's review decision (+ migration 0028)"
```

---

### Task 5: Completion handler persists the review decision (conservative-update)

**Files:**
- Modify: `apps/api/src/features/jobs/service.ts` (`handleRefreshPullRequestsCompletion`, ~line 239)
- Modify: `apps/api/src/features/jobs/service.test.ts` (add tests)

**Interfaces:**
- Consumes: `ProposalStore.updateReviewDecision` (Task 4); the optional `reviewDecision` on each refresh result (Task 2).
- Produces: nothing new — a side effect inside the existing handler.

- [ ] **Step 1: Write the failing completion tests**

Append to `apps/api/src/features/jobs/service.test.ts` (it already imports `completeJob` and `makeTestContext`):

```ts
test("refresh_pull_requests completion persists a reported review decision", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Refunds",
    targetPath: "kb/refunds.md",
    markdown: "# r",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.recordPublication(proposal.id, {
    provider: "local-git",
    branchName: "b",
    commitSha: "c",
    pullRequestUrl: "https://github.com/o/r/pull/3",
    publishedAt: new Date().toISOString()
  });

  const job = await ctx.jobs.create("refresh_pull_requests", {});
  assert.equal(
    (await completeJob(ctx, job.id, {
      results: [{ proposalId: proposal.id, state: "open" as const, merged: false, reviewDecision: "approved" as const }]
    })).ok,
    true
  );
  assert.equal((await ctx.stores.proposals.get(proposal.id))?.reviewDecision, "approved");
});

test("refresh_pull_requests completion without a reviewDecision leaves a prior one intact", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Credits",
    targetPath: "kb/credits.md",
    markdown: "# c",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.recordPublication(proposal.id, {
    provider: "local-git",
    branchName: "b",
    commitSha: "c",
    pullRequestUrl: "https://github.com/o/r/pull/4",
    publishedAt: new Date().toISOString()
  });
  await ctx.stores.proposals.updateReviewDecision(proposal.id, "approved");

  // A later poll that could not determine the decision (no reviewDecision on the
  // result) must not clobber the stored approval back to touchable.
  const job = await ctx.jobs.create("refresh_pull_requests", {});
  assert.equal(
    (await completeJob(ctx, job.id, {
      results: [{ proposalId: proposal.id, state: "open" as const, merged: false }]
    })).ok,
    true
  );
  assert.equal((await ctx.stores.proposals.get(proposal.id))?.reviewDecision, "approved");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/api -- --test-name-pattern="review decision"`
Expected: FAIL — the handler never persists `reviewDecision`.

- [ ] **Step 3: Implement the persistence**

In `apps/api/src/features/jobs/service.ts`, in `handleRefreshPullRequestsCompletion`, change the results loop (lines 239-241) to:

```ts
  for (const result of parsed.data.results) {
    await applyPullRequestTransition(ctx, result.proposalId, { merged: result.merged, state: result.state });
    // Conservative update: only a genuine fresh reading updates the stored decision.
    // A result with no reviewDecision (an undetermined poll) must never clobber a
    // known "approved" back to a touchable value — that would re-open an approved
    // PR to folding, the exact failure this guard prevents.
    if (result.reviewDecision) {
      await ctx.stores.proposals.updateReviewDecision(result.proposalId, result.reviewDecision);
    }
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/api -- --test-name-pattern="review decision"`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/jobs/service.ts apps/api/src/features/jobs/service.test.ts
git commit -m "feat(api): persist reported review decisions on refresh completion"
```

---

### Task 6: Thread the review decision onto the snapshot

**Files:**
- Modify: `apps/api/src/stores/snapshot-store.ts` (`SnapshotPullRequest`)
- Modify: `apps/api/src/features/snapshots/service.ts` (`PullRequestReading`, `refreshSnapshot`, `recordSnapshotsFromPullRequestResults`)
- Modify: `apps/api/src/features/snapshots/service.test.ts` (extend a test)

**Interfaces:**
- Consumes: `ReviewDecision` from `@magpie/core`; the optional `reviewDecision` on refresh results.
- Produces: `SnapshotPullRequest.reviewDecision?` and `PullRequestReading.reviewDecision?` for the `/snapshots` page.

- [ ] **Step 1: Write the failing snapshot test**

In `apps/api/src/features/snapshots/service.test.ts`, extend the `recordSnapshotsFromPullRequestResults` test (around line 126-134) so the reported result carries a decision and the snapshot exposes it. Replace the `recordSnapshotsFromPullRequestResults(...)` call and the two trailing assertions in that test with:

```ts
    await recordSnapshotsFromPullRequestResults(ctx, [
      { proposalId: proposal.id, merged: false, state: "open", reviewDecision: "approved" }
    ]);

    const views = await listFlowSnapshots(ctx);
    assert.equal(views.length, 2, "both the default and the alpha flow get a snapshot");
    const defaultSnapshot = views.find((v) => v.flowId === undefined);
    assert.equal(defaultSnapshot?.pullRequests[0]?.state, "open");
    assert.equal(defaultSnapshot?.pullRequests[0]?.reviewDecision, "approved", "the review decision reached the snapshot");
```

(Note: `openPrProposal` leaves the proposal in `pr-opened` status, which `refreshSnapshot` requires, so an `open` reading is valid here.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/api -- --test-name-pattern="recordSnapshotsFromPullRequestResults"`
Expected: FAIL — `reviewDecision` is not on the snapshot type or threaded through.

- [ ] **Step 3: Add the field to `SnapshotPullRequest`**

In `apps/api/src/stores/snapshot-store.ts`, extend the `@magpie/core` import (line 3) to include `ReviewDecision`:

```ts
import type { GapCandidate, Proposal, ReviewDecision } from "@magpie/core";
```

Add to the `SnapshotPullRequest` interface, after the `state` line (line 22):

```ts
  // The latest review decision the watcher reported for this PR, when known.
  reviewDecision?: ReviewDecision;
```

- [ ] **Step 4: Thread it through the snapshots service**

In `apps/api/src/features/snapshots/service.ts`:

Extend the `PullRequestReading` type (line 8) to carry the optional decision:

```ts
export type PullRequestReading = { merged: boolean; state: "open" | "closed"; reviewDecision?: ReviewDecision };
```

Ensure `ReviewDecision` is imported from `@magpie/core` (add it to the existing core import in this file).

In `refreshSnapshot`, change the reported-PR push (the line currently at ~121) to carry the decision:

```ts
      pullRequests.push({
        proposalId: proposal.id,
        url,
        merged: reported.merged,
        state: reported.state,
        ...(reported.reviewDecision ? { reviewDecision: reported.reviewDecision } : {}),
        checkedAt: takenAt
      });
```

In `recordSnapshotsFromPullRequestResults`, change the map that builds `statuses` (lines 149-151) to carry the decision:

```ts
  const statuses = new Map<string, PullRequestReading>(
    results.map((result) => [
      result.proposalId,
      { merged: result.merged, state: result.state, ...(result.reviewDecision ? { reviewDecision: result.reviewDecision } : {}) }
    ])
  );
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -w @magpie/api -- --test-name-pattern="recordSnapshotsFromPullRequestResults"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/stores/snapshot-store.ts apps/api/src/features/snapshots/service.ts apps/api/src/features/snapshots/service.test.ts
git commit -m "feat(api): surface the review decision on flow snapshots"
```

---

### Task 7: Gate treats an approved PR as non-touchable

**Files:**
- Modify: `apps/api/src/scheduling/reconcile-gate.ts` (`openPullRequestSummaries`, ~line 92-101)
- Modify: `apps/api/src/scheduling/reconcile-gate.test.ts` (add a test)

**Interfaces:**
- Consumes: `Proposal.reviewDecision` (Task 1).
- Produces: `OpenPullRequestSummary.touchable` now reflects `reviewDecision !== "approved"`. `decideReconciliation` is unchanged.

- [ ] **Step 1: Write the failing gate test**

In `apps/api/src/scheduling/reconcile-gate.test.ts`, the `proposal` fixture helper (lines 87-88) only sets `id`/`status`/`targetPath`. Replace it so it can carry a review decision:

```ts
const proposal = (id: string, status: string, targetPath?: string, reviewDecision?: string): Proposal =>
  ({ id, status, targetPath, reviewDecision }) as unknown as Proposal;
```

Then add this test after the "maps every open status" test:

```ts
test("an approved proposal is non-touchable; every other decision stays touchable", () => {
  const out = openPullRequestSummaries([
    proposal("p1", "pr-opened", "kb/a.md", "approved"),
    proposal("p2", "pr-opened", "kb/b.md", "changes_requested"),
    proposal("p3", "pr-opened", "kb/c.md", "review_required"),
    proposal("p4", "pr-opened", "kb/d.md", "none"),
    proposal("p5", "pr-opened", "kb/e.md")
  ]);
  assert.deepEqual(out, [
    { proposalId: "p1", targets: ["kb/a.md"], touchable: false },
    { proposalId: "p2", targets: ["kb/b.md"], touchable: true },
    { proposalId: "p3", targets: ["kb/c.md"], touchable: true },
    { proposalId: "p4", targets: ["kb/d.md"], touchable: true },
    { proposalId: "p5", targets: ["kb/e.md"], touchable: true }
  ]);
});
```

(The existing "maps every open status" test passes `proposal(id, status, targetPath)` with no fourth arg, so `reviewDecision` is `undefined` → `touchable: true`, and that test still holds.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/api -- --test-name-pattern="non-touchable"`
Expected: FAIL — `touchable` is hard-coded `true`.

- [ ] **Step 3: Implement the touchable computation**

In `apps/api/src/scheduling/reconcile-gate.ts`, update the doc comment on `openPullRequestSummaries` (replace the final sentence "touchable is always true for now — approval state is untracked..." with a description of the real rule) and change the push (line 98) to:

```ts
    out.push({
      proposalId: proposal.id,
      targets: [proposal.targetPath],
      // An approved PR is locked: folding another change into it would invalidate the
      // review. Every other state (and an un-polled proposal) is still touchable.
      touchable: proposal.reviewDecision !== "approved"
    });
```

The replacement comment for the function (lines 89-91) should read:

```ts
// non-optional, so in practice this guards the empty-string case). touchable is
// true unless the proposal's PR is approved — see Proposal.reviewDecision, polled
// by the refresh_pull_requests watcher job.
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcile|touchable|openPullRequestSummaries"`
Expected: PASS (the new test and all existing gate tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/reconcile-gate.ts apps/api/src/scheduling/reconcile-gate.test.ts
git commit -m "feat(reconcile): treat an approved PR as non-touchable in the gate"
```

---

### Task 8: `reconcileDraftedProposal` publishes the rival on a defer verdict

**Files:**
- Modify: `apps/api/src/scheduling/fold.ts` (`reconcileDraftedProposal`, ~line 53-56)
- Modify: `apps/api/src/scheduling/fold.test.ts` (add a test)

**Interfaces:**
- Consumes: `ReconciliationDecision` `defer` kind (already returned by `decideReconciliation` once a touchable overlap is approved); `ctx.stores.gapClusters.enqueuePublicationAction` (used by `enqueueFoldFallback`).
- Produces: a `defer` verdict in the at-draft hook now enqueues the rival's publish.

- [ ] **Step 1: Write the failing fold test**

Append to the `describe("reconcileDraftedProposal", ...)` block in `apps/api/src/scheduling/fold.test.ts` (before the closing `});` of that describe, around line 58):

```ts
  it("publishes the rival as its own PR when it overlaps only an approved PR", async () => {
    const ctx = makeTestContext();
    // Survivor is an open, approved PR on the same file.
    const survivor = await draft(ctx, { targetPath: "kb/refunds.md" });
    await ctx.stores.proposals.recordPublication(survivor.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "c",
      pullRequestUrl: "https://github.com/o/r/pull/5",
      publishedAt: new Date().toISOString()
    });
    await ctx.stores.proposals.updateReviewDecision(survivor.id, "approved");

    const rival = await draft(ctx, { targetPath: "kb/refunds.md" });
    await reconcileDraftedProposal(ctx, rival);

    // No fold job — the approved PR is non-touchable, so the gate defers.
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
    // Instead the rival is enqueued to publish as its own PR.
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === rival.id && a.kind === "publish"));
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @magpie/api -- --test-name-pattern="overlaps only an approved PR"`
Expected: FAIL — `reconcileDraftedProposal` returns on `defer` without enqueuing anything.

- [ ] **Step 3: Implement the defer branch**

In `apps/api/src/scheduling/fold.ts`, replace the early return (lines 53-56):

```ts
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));
  if (decision.kind !== "fold") {
    return;
  }
```

with:

```ts
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));
  // The only overlap is an approved (non-touchable) PR: folding would invalidate the
  // review, so publish the rival as its own PR instead. Nothing auto-publishes a
  // fresh draft otherwise, so this is a deliberate action; the #21 cross-link
  // backstop then flags the overlap to the approved PR's owner.
  if (decision.kind === "defer") {
    await ctx.stores.gapClusters.enqueuePublicationAction(rival.id, "publish");
    console.log(`Defer: rival ${rival.id} overlaps only approved PR(s); enqueued it to publish as its own PR.`);
    return;
  }
  if (decision.kind !== "fold") {
    return;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcileDraftedProposal"`
Expected: PASS (the new defer test and all existing `reconcileDraftedProposal` tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduling/fold.ts apps/api/src/scheduling/fold.test.ts
git commit -m "feat(reconcile): publish the rival when it overlaps only an approved PR"
```

---

## Final verification (before finishing the branch)

- [ ] Root typecheck: `npm run typecheck` — expect clean (this is the real type gate; ignore per-package TS6059 rootDir noise).
- [ ] Root dead-code: `npm run deadcode` — expect clean (no unused exports; `fetchPullRequestReviewDecision` is consumed by the watcher runner).
- [ ] Root tests: `npm test` — ALL workspaces, expect green except the two known Windows-only watcher failures (a `cat`-based stdin test and a path-separator test) which pass on CI Linux.

## Self-review notes

- **Spec coverage:** Leg 1 → Task 1; Leg 2 → Tasks 2-3; Leg 3 → Tasks 4-5; snapshot → Task 6; Leg 4 → Task 7; Leg 5 → Task 8. All spec legs are covered.
- **Type consistency:** `ReviewDecision` is defined in core (Task 1) and consumed by git (Task 1), the schema enum literal (Task 2), the watcher (Task 3), both stores (Task 4), the snapshot store + service (Task 6). `updateReviewDecision(id, reviewDecision)` has the same signature in the interface, in-memory store, and postgres store.
- **Conservative-update rule** appears once, in Task 5, and matches the optional schema field (Task 2) and the optional runner attachment (Task 3).
