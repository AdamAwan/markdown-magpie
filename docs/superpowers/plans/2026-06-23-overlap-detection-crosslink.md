# Overlap Detection + PR Cross-linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When two open pull requests in a flow touch the same knowledge-base file, post a reviewer-visible cross-link comment on both PRs (observe-first; no fold/suppression).

**Architecture:** A new `detectOverlaps` pass in the API reconciler finds overlapping open PRs via the spine's `sharedTargets`, records each pair once in a new `pr_crosslinks` store (idempotency), and enqueues a `crosslink_pull_requests` github job. The watcher's `PublicationRunner` runs the job, posting a comment on each PR via a new `@magpie/git` `commentOnPullRequest` helper. Spec: [`docs/superpowers/specs/2026-06-23-overlap-detection-crosslink-design.md`](../specs/2026-06-23-overlap-detection-crosslink-design.md).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node built-in test runner (`node --import tsx --test`), zod for job schemas, `pg` for the postgres store. Workspaces: `@magpie/git`, `@magpie/jobs`, `@magpie/api`, `@magpie/watcher`.

## Global Constraints

- **ESM imports** — local imports use a `.js` suffix; package imports (`@magpie/core`, `@magpie/git`, `@magpie/jobs`) have none.
- **knip runs strict** — `ignoreExportsUsedInFile` is deliberately unset. Only `export` a symbol if another module or test imports it; otherwise keep it file-local. CI's `npm run deadcode` is a blocking gate.
- **The real typecheck gate is the ROOT `npm run typecheck`** (`tsconfig.check.json`), not `-w @magpie/api` (that emits pre-existing TS6059 rootDir errors).
- **Best-effort reconciler** — a detection/enqueue error must be logged and swallowed, never abort `reconcileGaps` (match `refreshOpenPullRequests`).
- **Degrade quietly without a token** — `commentOnPullRequest` returns `undefined` (no throw) when `GITHUB_TOKEN` or the URL is missing, mirroring `raisePullRequest`.
- **Pair normalisation** — a cross-link pair is order-independent: `(a,b) == (b,a)`, enforced by storing `proposal_low`/`proposal_high` and a `UNIQUE` constraint.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/git/src/index.ts` (modify) | add `commentOnPullRequest` + `CommentOnPullRequestRequest` |
| `packages/git/src/comment.test.ts` (create) | git helper tests (token-less, URL parse, POST shape) |
| `packages/jobs/src/types.ts` (modify) | add `crosslink_pull_requests` to `JOB_TYPES` |
| `packages/jobs/src/schemas.ts` (modify) | add input/output schemas |
| `packages/jobs/src/catalog.ts` (modify) | register the job (github capability) |
| `packages/jobs/src/catalog.test.ts` (create or extend) | schema/catalog assertions |
| `apps/api/src/stores/pr-crosslink-store.ts` (create) | interface + `InMemoryPrCrosslinkStore` |
| `apps/api/src/stores/postgres-pr-crosslink-store.ts` (create) | postgres impl |
| `apps/api/src/stores/pr-crosslink-store.test.ts` (create) | in-memory store tests |
| `apps/api/src/platform/stores.ts` (modify) | `createPrCrosslinkStore` factory |
| `apps/api/src/context.ts` (modify) | wire `prCrosslinks` into `AppContext` |
| `apps/api/src/test-support/context.ts` (modify) | wire in-memory store into the harness |
| `packages/db/migrations/0027_pr_crosslinks.sql` (create) | table + unique pair index |
| `apps/watcher/src/runners/publication.ts` (modify) | handle `crosslink_pull_requests`; add dep |
| `apps/watcher/src/runners/publication-crosslink.test.ts` (create) | runner test |
| `apps/api/src/scheduling/gap-reconciler.ts` (modify) | `detectOverlaps` pass + call site |
| `apps/api/src/scheduling/gap-reconciler-overlap.test.ts` (create) | detection pass tests |

---

## Task 1: `commentOnPullRequest` helper in `@magpie/git`

**Files:**
- Modify: `packages/git/src/index.ts`
- Test: `packages/git/src/comment.test.ts`

**Interfaces:**
- Produces:
  - `interface CommentOnPullRequestRequest { pullRequestUrl: string; body: string }`
  - `function commentOnPullRequest(request: CommentOnPullRequestRequest): Promise<string | undefined>` — posts an issue comment to the PR; returns the created comment's `html_url`, or `undefined` when there is no token or the URL is not a GitHub PR URL.

**Context:** `index.ts` already has private `githubFetch(url, init)` and the `raisePullRequest` POST pattern (Bearer token from `process.env.GITHUB_TOKEN`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`). Reuse `githubFetch`. GitHub PR comments use the **issues** endpoint: `POST /repos/{owner}/{repo}/issues/{number}/comments`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/git/src/comment.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/git -- --test-name-pattern="comment"`
Expected: FAIL — `commentOnPullRequest` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/git/src/index.ts`:

```typescript
export interface CommentOnPullRequestRequest {
  pullRequestUrl: string;
  body: string;
}

// Post a comment on a pull request. GitHub treats PR comments as issue comments,
// so this targets the issues endpoint. Returns the created comment's URL, or
// undefined when there is no token or the URL is not a GitHub PR URL — quiet
// degradation symmetric with raisePullRequest.
export async function commentOnPullRequest(
  request: CommentOnPullRequestRequest
): Promise<string | undefined> {
  const target = parsePullRequestUrl(request.pullRequestUrl);
  if (!target) {
    return undefined;
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return undefined;
  }

  const response = await githubFetch(
    `https://api.github.com/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "markdown-magpie"
      },
      body: JSON.stringify({ body: request.body })
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub PR comment failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const data = (await response.json()) as { html_url?: string };
  return data.html_url;
}

function parsePullRequestUrl(
  url: string
): { owner: string; repo: string; number: number } | undefined {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) {
    return undefined;
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/git -- --test-name-pattern="comment"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/git/src/index.ts packages/git/src/comment.test.ts
git commit -m "feat(git): add commentOnPullRequest helper"
```

---

## Task 2: `crosslink_pull_requests` job type

**Files:**
- Modify: `packages/jobs/src/types.ts`, `packages/jobs/src/schemas.ts`, `packages/jobs/src/catalog.ts`
- Test: `packages/jobs/src/catalog.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `JOB_TYPES` includes `"crosslink_pull_requests"`.
  - `crosslinkPullRequestsInputSchema` — `{ flowId?: string; targets: string[]; pullRequests: [{proposalId, pullRequestUrl}, {proposalId, pullRequestUrl}] }` (exactly 2).
  - `crosslinkPullRequestsOutputSchema` — `{ commented: string[]; linkedAt: string }`.
  - catalog entry: `define("crosslink_pull_requests", "github", …, 10 * 60)`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/jobs/src/catalog.test.ts  (create; if it exists, append the tests)
import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_TYPES, getJobDefinition } from "./catalog.js";
import { crosslinkPullRequestsInputSchema } from "./schemas.js";

test("crosslink_pull_requests is a registered github job", () => {
  assert.ok(JOB_TYPES.includes("crosslink_pull_requests"));
  const def = getJobDefinition("crosslink_pull_requests");
  assert.equal(def.capability, "github");
});

test("crosslink input schema requires exactly two pull requests", () => {
  const ok = crosslinkPullRequestsInputSchema.safeParse({
    targets: ["kb/a.md"],
    pullRequests: [
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ]
  });
  assert.equal(ok.success, true);
  const bad = crosslinkPullRequestsInputSchema.safeParse({
    targets: ["kb/a.md"],
    pullRequests: [{ proposalId: "p1", pullRequestUrl: "u" }]
  });
  assert.equal(bad.success, false);
});
```

> Note: confirm the accessor name (`getJobDefinition`) by reading `catalog.ts`; if the exported accessor differs (e.g. `jobDefinition`/`definitionFor`), use that name in the test and keep the rest identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/jobs -- --test-name-pattern="crosslink"`
Expected: FAIL — type not in `JOB_TYPES` / schema not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/jobs/src/types.ts`, add to the `JOB_TYPES` array (after `"publish_source_sync"`):

```typescript
  "crosslink_pull_requests"
```

In `packages/jobs/src/schemas.ts`, append:

```typescript
export const crosslinkPullRequestsInputSchema = z.object({
  flowId: z.string().optional(),
  targets: z.array(z.string()),
  pullRequests: z
    .array(z.object({ proposalId: z.string(), pullRequestUrl: z.string() }))
    .length(2)
});
export const crosslinkPullRequestsOutputSchema = z.object({
  commented: z.array(z.string()),
  linkedAt: z.string()
});
```

In `packages/jobs/src/catalog.ts`, add to the `definitions` object (after `publish_source_sync`):

```typescript
  crosslink_pull_requests: define(
    "crosslink_pull_requests",
    "github",
    schemas.crosslinkPullRequestsInputSchema,
    schemas.crosslinkPullRequestsOutputSchema,
    10 * 60
  ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/jobs -- --test-name-pattern="crosslink"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jobs/src/types.ts packages/jobs/src/schemas.ts packages/jobs/src/catalog.ts packages/jobs/src/catalog.test.ts
git commit -m "feat(jobs): add crosslink_pull_requests job type"
```

---

## Task 3: `pr_crosslinks` store + migration

**Files:**
- Create: `apps/api/src/stores/pr-crosslink-store.ts`, `apps/api/src/stores/postgres-pr-crosslink-store.ts`, `apps/api/src/stores/pr-crosslink-store.test.ts`, `packages/db/migrations/0027_pr_crosslinks.sql`
- Modify: `apps/api/src/platform/stores.ts`, `apps/api/src/context.ts`, `apps/api/src/test-support/context.ts`

**Interfaces:**
- Produces:
  - `interface PrCrosslinkRecord { id: string; flowId?: string; proposalLow: string; proposalHigh: string; targets: string[]; linkedAt: string }`
  - `interface NewPrCrosslink { flowId?: string; proposalA: string; proposalB: string; targets: string[] }`
  - `interface PrCrosslinkStore { has(a: string, b: string): Promise<boolean>; record(input: NewPrCrosslink): Promise<PrCrosslinkRecord>; list(limit: number): Promise<PrCrosslinkRecord[]>; reset(): Promise<void> }`
  - `class InMemoryPrCrosslinkStore`, `class PostgresPrCrosslinkStore`
  - `function createPrCrosslinkStore()` in `platform/stores.ts`
  - `ctx.stores.prCrosslinks` on `AppContext`
- Consumes (Task 5): `ctx.stores.prCrosslinks.has(...)` / `.record(...)`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/stores/pr-crosslink-store.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryPrCrosslinkStore } from "./pr-crosslink-store.js";

test("a recorded pair is found regardless of order", async () => {
  const store = new InMemoryPrCrosslinkStore();
  assert.equal(await store.has("p1", "p2"), false);
  await store.record({ proposalA: "p2", proposalB: "p1", targets: ["kb/a.md"] });
  assert.equal(await store.has("p1", "p2"), true);
  assert.equal(await store.has("p2", "p1"), true);
});

test("recording the same pair twice does not duplicate", async () => {
  const store = new InMemoryPrCrosslinkStore();
  await store.record({ proposalA: "p1", proposalB: "p2", targets: ["kb/a.md"] });
  await store.record({ proposalA: "p2", proposalB: "p1", targets: ["kb/a.md"] });
  assert.equal((await store.list(10)).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="recorded pair|same pair twice"`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the in-memory store + interface**

```typescript
// apps/api/src/stores/pr-crosslink-store.ts

export interface PrCrosslinkRecord {
  id: string;
  flowId?: string;
  proposalLow: string;
  proposalHigh: string;
  targets: string[];
  linkedAt: string;
}

export interface NewPrCrosslink {
  flowId?: string;
  proposalA: string;
  proposalB: string;
  targets: string[];
}

// Records that two open PRs were cross-linked once, so the reconciler does not
// re-comment them every tick. The pair is order-independent.
export interface PrCrosslinkStore {
  has(a: string, b: string): Promise<boolean>;
  record(input: NewPrCrosslink): Promise<PrCrosslinkRecord>;
  list(limit: number): Promise<PrCrosslinkRecord[]>;
  reset(): Promise<void>;
}

// Normalise a pair so (a,b) and (b,a) key identically.
export function normalisePair(a: string, b: string): { low: string; high: string } {
  return a <= b ? { low: a, high: b } : { low: b, high: a };
}

export class InMemoryPrCrosslinkStore implements PrCrosslinkStore {
  private readonly links: PrCrosslinkRecord[] = [];
  private seq = 0;

  async has(a: string, b: string): Promise<boolean> {
    const { low, high } = normalisePair(a, b);
    return this.links.some((l) => l.proposalLow === low && l.proposalHigh === high);
  }

  async record(input: NewPrCrosslink): Promise<PrCrosslinkRecord> {
    const { low, high } = normalisePair(input.proposalA, input.proposalB);
    const existing = this.links.find((l) => l.proposalLow === low && l.proposalHigh === high);
    if (existing) {
      return existing;
    }
    this.seq += 1;
    const record: PrCrosslinkRecord = {
      id: `crosslink-${this.seq}`,
      flowId: input.flowId,
      proposalLow: low,
      proposalHigh: high,
      targets: input.targets,
      linkedAt: new Date().toISOString()
    };
    this.links.push(record);
    return record;
  }

  async list(limit: number): Promise<PrCrosslinkRecord[]> {
    return [...this.links].reverse().slice(0, limit);
  }

  async reset(): Promise<void> {
    this.links.length = 0;
    this.seq = 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="recorded pair|same pair twice"`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the postgres store + migration + wiring**

`apps/api/src/stores/postgres-pr-crosslink-store.ts`:

```typescript
import pg from "pg";
import {
  normalisePair,
  type NewPrCrosslink,
  type PrCrosslinkRecord,
  type PrCrosslinkStore
} from "./pr-crosslink-store.js";

const { Pool } = pg;

export class PostgresPrCrosslinkStore implements PrCrosslinkStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async has(a: string, b: string): Promise<boolean> {
    const { low, high } = normalisePair(a, b);
    const result = await this.pool.query(
      "SELECT 1 FROM pr_crosslinks WHERE proposal_low = $1 AND proposal_high = $2 LIMIT 1",
      [low, high]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async record(input: NewPrCrosslink): Promise<PrCrosslinkRecord> {
    const { low, high } = normalisePair(input.proposalA, input.proposalB);
    const result = await this.pool.query<CrosslinkRow>(
      `
        INSERT INTO pr_crosslinks (flow_id, proposal_low, proposal_high, targets)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (proposal_low, proposal_high)
          DO UPDATE SET targets = EXCLUDED.targets
        RETURNING *
      `,
      [input.flowId ?? null, low, high, input.targets]
    );
    return mapRow(result.rows[0]);
  }

  async list(limit: number): Promise<PrCrosslinkRecord[]> {
    const result = await this.pool.query<CrosslinkRow>(
      "SELECT * FROM pr_crosslinks ORDER BY linked_at DESC, id DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRow);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM pr_crosslinks");
  }
}

interface CrosslinkRow {
  id: string;
  flow_id: string | null;
  proposal_low: string;
  proposal_high: string;
  targets: string[];
  linked_at: Date;
}

function mapRow(row: CrosslinkRow): PrCrosslinkRecord {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    proposalLow: row.proposal_low,
    proposalHigh: row.proposal_high,
    targets: row.targets,
    linkedAt: row.linked_at.toISOString()
  };
}
```

`packages/db/migrations/0027_pr_crosslinks.sql`:

```sql
-- Records that two open pull requests in a flow were detected to overlap on the
-- same knowledge-base file and cross-linked once, so the reconciler does not
-- re-comment them every tick. The pair is normalised (low/high) so (a,b)==(b,a).
CREATE TABLE IF NOT EXISTS pr_crosslinks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id text,
  proposal_low text NOT NULL,
  proposal_high text NOT NULL,
  targets text[] NOT NULL DEFAULT '{}',
  linked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_low, proposal_high)
);
```

In `apps/api/src/platform/stores.ts`, add (mirroring `createReconciliationDecisionStore`, and add the matching imports for `InMemoryPrCrosslinkStore`/`PostgresPrCrosslinkStore`):

```typescript
export function createPrCrosslinkStore(): InMemoryPrCrosslinkStore | PostgresPrCrosslinkStore {
  return createStore<InMemoryPrCrosslinkStore | PostgresPrCrosslinkStore>(
    "PR_CROSSLINK_STORE",
    (databaseUrl) => new PostgresPrCrosslinkStore(databaseUrl),
    () => new InMemoryPrCrosslinkStore()
  );
}
```

In `apps/api/src/context.ts`: import `createPrCrosslinkStore`, add `prCrosslinks: ReturnType<typeof createPrCrosslinkStore>;` to the `AppContext.stores` interface (after `reconciliations`), and `prCrosslinks: createPrCrosslinkStore(),` to the `stores` object in `createAppContext`.

In `apps/api/src/test-support/context.ts`: import `InMemoryPrCrosslinkStore` from `../stores/pr-crosslink-store.js` and add `prCrosslinks: new InMemoryPrCrosslinkStore(),` to the `stores` block (after `reconciliations`).

> Note on `StoreEnvName`: `createStore`'s first arg is typed `StoreEnvName` in `platform/stores.ts`. If that is a closed union type, add `"PR_CROSSLINK_STORE"` to it; if it is `string`, no change needed. Read the type before writing.

- [ ] **Step 6: Verify build wiring**

Run: `npm run typecheck && npm test -w @magpie/api -- --test-name-pattern="recorded pair|same pair twice"`
Expected: typecheck clean (proves `AppContext`/harness wiring compiles); store tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/stores/pr-crosslink-store.ts apps/api/src/stores/postgres-pr-crosslink-store.ts apps/api/src/stores/pr-crosslink-store.test.ts apps/api/src/platform/stores.ts apps/api/src/context.ts apps/api/src/test-support/context.ts packages/db/migrations/0027_pr_crosslinks.sql
git commit -m "feat(api): add pr_crosslinks store + migration"
```

---

## Task 4: Watcher handles `crosslink_pull_requests`

**Files:**
- Modify: `apps/watcher/src/runners/publication.ts`
- Test: `apps/watcher/src/runners/publication-crosslink.test.ts`

**Interfaces:**
- Consumes: `crosslinkPullRequestsInputSchema`/`crosslinkPullRequestsOutputSchema` (Task 2); `commentOnPullRequest` (Task 1).
- Produces: `PublicationDeps.commentOnPullRequest`; `PublicationRunner` handling of the new job (a comment on each PR referencing the other + the shared files).

**Context:** `PublicationRunner` (constructor `(api, deps)`) dispatches github jobs in `run()` and gates them with `PUBLISH_JOB_TYPES`. The crosslink job needs only `deps` (everything is in the job input), not `api`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/watcher/src/runners/publication-crosslink.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="comments on both PRs|token-less comment"`
Expected: FAIL — `commentOnPullRequest` not on `PublicationDeps`; `run` throws for the type.

- [ ] **Step 3: Implement**

In `apps/watcher/src/runners/publication.ts`:

1. Extend the schema import to add `crosslinkPullRequestsInputSchema, crosslinkPullRequestsOutputSchema`.
2. Add `commentOnPullRequest` to the `@magpie/git` import and to `createGitPublicationDeps`'s returned object (`commentOnPullRequest`).
3. Add to the `PublicationDeps` interface:

```typescript
  commentOnPullRequest(request: { pullRequestUrl: string; body: string }): Promise<string | undefined>;
```

4. Add the type to `PUBLISH_JOB_TYPES`:

```typescript
  "crosslink_pull_requests"
```

5. In `run()`, add the dispatch branch (before the final throw):

```typescript
    if (job.type === "crosslink_pull_requests") {
      return this.crosslinkPullRequests(job);
    }
```

6. Add the private method:

```typescript
  private async crosslinkPullRequests(job: JobView): Promise<unknown> {
    const { targets, pullRequests } = crosslinkPullRequestsInputSchema.parse(job.input);
    const [a, b] = pullRequests;
    const files = targets.map((t) => `\`${t}\``).join(", ");
    const commented: string[] = [];
    for (const [self, other] of [
      [a, b],
      [b, a]
    ] as const) {
      const body =
        `🔗 **Magpie:** this PR overlaps ${other.pullRequestUrl} — both edit ${files}. ` +
        "They may be consolidated. _(automated overlap detection)_";
      const url = await this.deps.commentOnPullRequest({ pullRequestUrl: self.pullRequestUrl, body });
      if (url) {
        commented.push(url);
      }
    }
    return crosslinkPullRequestsOutputSchema.parse({ commented, linkedAt: new Date().toISOString() });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="comments on both PRs|token-less comment"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/runners/publication.ts apps/watcher/src/runners/publication-crosslink.test.ts
git commit -m "feat(watcher): run crosslink_pull_requests job"
```

---

## Task 5: `detectOverlaps` reconciler pass

**Files:**
- Modify: `apps/api/src/scheduling/gap-reconciler.ts`
- Test: `apps/api/src/scheduling/gap-reconciler-overlap.test.ts`

**Interfaces:**
- Consumes: `sharedTargets` (`./reconcile-gate.js`); `ctx.stores.prCrosslinks` (Task 3); `ctx.jobs.create("crosslink_pull_requests", …)` (Task 2); existing `sameFlow`/`proposalFlowId`/`ClusterFlowCache`.
- Produces: a `detectOverlaps(ctx, flowId, cache)` pass called from `reconcileGaps` right after `refreshOpenPullRequests`.

**Behaviour:** over this flow's `pr-opened` proposals that have both a `pullRequestUrl` and a `targetPath`, enqueue one `crosslink_pull_requests` job (and record the pair) for each overlapping pair not already in `prCrosslinks`. Best-effort: per-pair errors are logged and swallowed.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/scheduling/gap-reconciler-overlap.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";
import type { AppContext } from "../context.js";

async function openPr(ctx: AppContext, title: string, targetPath: string, prUrl: string): Promise<string> {
  const proposal = await ctx.stores.proposals.create({
    title,
    targetPath,
    markdown: "#",
    rationale: "r",
    evidence: [],
    triggeringQuestionIds: []
  });
  await ctx.stores.proposals.recordPublication(proposal.id, {
    provider: "local-git",
    branchName: `b-${title}`,
    commitSha: "sha",
    pullRequestUrl: prUrl,
    publishedAt: new Date().toISOString()
  });
  return proposal.id;
}

const keepOpen = { fetchPullRequestStatus: async () => ({ merged: false, state: "open" as const }) };

describe("detectOverlaps", () => {
  it("cross-links two open PRs that touch the same file", async () => {
    const ctx = makeTestContext();
    const a = await openPr(ctx, "A", "kb/same.md", "https://github.com/o/r/pull/1");
    const b = await openPr(ctx, "B", "kb/same.md", "https://github.com/o/r/pull/2");

    await reconcileGaps(ctx, undefined, keepOpen);

    const jobs = (await ctx.jobs.list({ type: "crosslink_pull_requests" })).jobs;
    assert.equal(jobs.length, 1, "one crosslink job for the overlapping pair");
    assert.equal(await ctx.stores.prCrosslinks.has(a, b), true);
  });

  it("does not cross-link PRs on different files", async () => {
    const ctx = makeTestContext();
    await openPr(ctx, "A", "kb/one.md", "https://github.com/o/r/pull/1");
    await openPr(ctx, "B", "kb/two.md", "https://github.com/o/r/pull/2");
    await reconcileGaps(ctx, undefined, keepOpen);
    assert.equal((await ctx.jobs.list({ type: "crosslink_pull_requests" })).jobs.length, 0);
  });

  it("is idempotent — a second run enqueues no new job", async () => {
    const ctx = makeTestContext();
    await openPr(ctx, "A", "kb/same.md", "https://github.com/o/r/pull/1");
    await openPr(ctx, "B", "kb/same.md", "https://github.com/o/r/pull/2");
    await reconcileGaps(ctx, undefined, keepOpen);
    await reconcileGaps(ctx, undefined, keepOpen);
    assert.equal((await ctx.jobs.list({ type: "crosslink_pull_requests" })).jobs.length, 1);
  });

  it("skips branch-only proposals with no pull request url", async () => {
    const ctx = makeTestContext();
    const proposal = await ctx.stores.proposals.create({
      title: "A",
      targetPath: "kb/same.md",
      markdown: "#",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: []
    });
    await ctx.stores.proposals.recordPublication(proposal.id, {
      provider: "local-git",
      branchName: "b",
      commitSha: "sha",
      publishedAt: new Date().toISOString()
    });
    await openPr(ctx, "B", "kb/same.md", "https://github.com/o/r/pull/2");
    await reconcileGaps(ctx, undefined, keepOpen);
    assert.equal((await ctx.jobs.list({ type: "crosslink_pull_requests" })).jobs.length, 0);
  });
});
```

> Note: confirm the `ctx.jobs.list` shape from `gap-reconciler.test.ts` (it uses `(await ctx.jobs.list({ type: "reconcile_gap_clusters" })).jobs.length`). Use the same accessor. If `recordPublication` does not set status to `pr-opened` on its own, set it explicitly with `await ctx.stores.proposals.updateStatus(id, "pr-opened")` inside `openPr` — verify against the existing reconciler test which relies on `recordPublication` leaving the proposal `pr-opened`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="detectOverlaps"`
Expected: FAIL — no job enqueued (`detectOverlaps` not wired).

- [ ] **Step 3: Implement**

In `apps/api/src/scheduling/gap-reconciler.ts`:

1. Add the import: `import { sharedTargets } from "./reconcile-gate.js";`
2. Call it in `reconcileGaps`, immediately after the `refreshOpenPullRequests` call (currently line 57):

```typescript
  await detectOverlaps(ctx, flowId, clusterFlowCache);
```

3. Add the function:

```typescript
// Observe-first overlap detection: when two of this flow's open PRs touch the
// same file, cross-link them once. Uses the spine's sharedTargets; records each
// pair in prCrosslinks so a pair is linked once, not every tick. Best-effort —
// a per-pair failure is logged and never aborts reconcileGaps.
async function detectOverlaps(
  ctx: AppContext,
  flowId: string | undefined,
  cache: ClusterFlowCache
): Promise<void> {
  const open = await ctx.stores.proposals.list(200, { status: "pr-opened" });
  const candidates: Array<{ id: string; targetPath: string; pullRequestUrl: string }> = [];
  for (const proposal of open) {
    if (!sameFlow(await proposalFlowId(ctx, proposal, cache), flowId)) {
      continue;
    }
    const pullRequestUrl = proposal.publication?.pullRequestUrl;
    if (!pullRequestUrl || !proposal.targetPath) {
      continue;
    }
    candidates.push({ id: proposal.id, targetPath: proposal.targetPath, pullRequestUrl });
  }

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      const targets = sharedTargets([a.targetPath], [b.targetPath]);
      if (targets.length === 0) {
        continue;
      }
      try {
        if (await ctx.stores.prCrosslinks.has(a.id, b.id)) {
          continue;
        }
        await ctx.stores.prCrosslinks.record({ flowId, proposalA: a.id, proposalB: b.id, targets });
        await ctx.jobs.create("crosslink_pull_requests", {
          ...(flowId ? { flowId } : {}),
          targets,
          pullRequests: [
            { proposalId: a.id, pullRequestUrl: a.pullRequestUrl },
            { proposalId: b.id, pullRequestUrl: b.pullRequestUrl }
          ]
        });
        console.log(
          `Gap reconciler [${flowId ?? "default"}]: cross-linked overlapping PRs for proposals ${a.id} and ${b.id} on ${targets.join(", ")}.`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "overlap cross-link failed";
        console.warn(`Overlap cross-link for proposals ${a.id} and ${b.id} failed: ${message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @magpie/api -- --test-name-pattern="detectOverlaps"`
Expected: PASS (4 tests).

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm run deadcode && npm test -w @magpie/api -- --test-name-pattern="detectOverlaps|recorded pair|same pair twice"`
Expected: typecheck clean; knip strict clean; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/scheduling/gap-reconciler.ts apps/api/src/scheduling/gap-reconciler-overlap.test.ts
git commit -m "feat(api): detect overlapping open PRs and cross-link them"
```

---

## Self-Review

- **Spec coverage:** `detectOverlaps` pass = Task 5; `crosslink_pull_requests` job = Task 2; PublicationRunner handling + `commentOnPullRequest` = Tasks 4 + 1; `pr_crosslinks` store + migration (idempotency) = Task 3. Best-effort posture, branch-only skip, cross-flow skip, pair normalisation, and token-less degradation are all covered by tests. `decideReconciliation` is intentionally NOT consumed here (spec: deferred to the fold increment).
- **Placeholder scan:** none — every step has complete code. Three `> Note:` callouts flag exact names to confirm against existing files (`getJobDefinition` accessor, `StoreEnvName` type, `recordPublication`→`pr-opened` status); these are verification-then-use, not placeholders.
- **Type consistency:** `PrCrosslinkStore` / `NewPrCrosslink` / `normalisePair`, the `crosslink_pull_requests` schemas (`targets`, `pullRequests[].pullRequestUrl`), `PublicationDeps.commentOnPullRequest`, and `ctx.stores.prCrosslinks` are used identically across Tasks 1–5 and their tests.
- **Dependency order:** 1 (git) → 2 (job) → 3 (store) → 4 (watcher, needs 1+2) → 5 (API, needs 2+3). Each task ends with an independently testable deliverable.
