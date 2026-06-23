# Fold-at-draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a freshly-drafted proposal overlaps an existing open proposal on the same target document, an LLM folds the two into one document and the rival is superseded — so the duplicate PR never exists.

**Architecture:** A new dispatcher step runs the spine's `decideReconciliation` over a newly-created draft; a `fold` verdict enqueues a `fold_markdown_proposal` AI job. Its completion handler updates the survivor's markdown, absorbs the rival's gap cluster, supersedes the rival, and re-publishes the survivor through the existing publication outbox. A failed fold falls back to publishing the rival as its own PR (the #21 cross-link then catches the overlap).

**Tech Stack:** TypeScript ESM monorepo (npm workspaces), zod schemas, Node built-in test runner (`node --import tsx --test`), pg.

## Global Constraints

- **ESM imports:** local imports use a `.js` suffix; `@magpie/*` package imports do not. Copy verbatim from neighbouring files.
- **Strict knip (`npm run deadcode`):** every new export must be imported somewhere, or knip fails CI. Do NOT relax `knip.json`. If an export is only used in its own file, keep it file-local.
- **The real typecheck gate is the ROOT `npm run typecheck`** (tsconfig.check.json). The per-package `npm run typecheck -w @magpie/api` emits pre-existing TS6059 rootDir errors — ignore those.
- **The job broker stores `inputSchema.safeParse(input).data`** — keys not on the zod schema are silently dropped. Every job-input field MUST be declared on its schema in `packages/jobs/src/schemas.ts` AND the core type it `satisfies` in `packages/core/src/index.ts`.
- **Tests:** run one workspace with `npm test -w @magpie/api -- --test-name-pattern="..."`. There is a watcher test ("rewrites API-host paths…") that fails ONLY on local Windows; it passes in CI — not a regression.
- **In-memory test harness:** `apps/api/src/test-support/context.ts` (`makeTestContext`).

---

### Task 1: Job contracts — `fold_markdown_proposal` + `comment_pull_request`

**Files:**
- Modify: `packages/core/src/index.ts` (after `DraftMarkdownProposalJobOutput`, ~line 385)
- Modify: `packages/jobs/src/types.ts` (the `JOB_TYPES` array)
- Modify: `packages/jobs/src/schemas.ts` (import block + new schemas)
- Modify: `packages/jobs/src/catalog.ts` (`definitions` + `aiJobTypes`)
- Test: `packages/jobs/src/catalog.test.ts`, `packages/jobs/src/schemas.test.ts`

**Interfaces:**
- Produces: core types `FoldMarkdownProposalJobInput`, `FoldMarkdownProposalJobOutput`; schemas `foldMarkdownProposalInputSchema`, `foldMarkdownProposalOutputSchema`, `commentPullRequestInputSchema`, `commentPullRequestOutputSchema`; job types `"fold_markdown_proposal"` (AI/provider) and `"comment_pull_request"` (github). All re-exported via `@magpie/jobs` (the barrel is `export *`).

- [ ] **Step 1: Update the contract tests first (they fail).** In `packages/jobs/src/catalog.test.ts`, add to the `EXPIRATION_SECONDS` map (after the `crosslink_pull_requests` line):

```ts
  fold_markdown_proposal: 15 * 60,
  comment_pull_request: 10 * 60
```

(Add a comma after the existing `crosslink_pull_requests: 10 * 60` line.) Then extend the github-queue assertion to expect the new github queue:

```ts
test("github capability yields only GitHub work queues", () => {
  assert.deepEqual(queueNamesForCapabilities(["github"]), [
    "refresh_pull_requests",
    "publish_proposal",
    "publish_crunch",
    "publish_source_sync",
    "crosslink_pull_requests",
    "comment_pull_request"
  ]);
});
```

Add a registration test at the end of the file:

```ts
test("fold_markdown_proposal is a provider AI job; comment_pull_request is github", () => {
  assert.ok(JOB_TYPES.includes("fold_markdown_proposal"));
  assert.ok(JOB_TYPES.includes("comment_pull_request"));
  assert.equal(jobDefinition("fold_markdown_proposal").requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("fold_markdown_proposal", { provider: "codex" }), "fold_markdown_proposal__codex");
  assert.equal(jobDefinition("comment_pull_request").requiredCapability({}), "github");
});
```

- [ ] **Step 2: Add the schema round-trip tests** to `packages/jobs/src/schemas.test.ts`:

```ts
import {
  draftMarkdownProposalInputSchema,
  foldMarkdownProposalInputSchema,
  foldMarkdownProposalOutputSchema,
  commentPullRequestInputSchema
} from "./schemas.js";

test("fold input schema round-trips the survivor/rival fields", () => {
  const parsed = foldMarkdownProposalInputSchema.parse({
    provider: "codex",
    survivorProposalId: "A",
    rivalProposalId: "B",
    targetPath: "kb/refunds.md",
    survivorMarkdown: "# A",
    rivalMarkdown: "# B",
    rivalGapSummaries: ["refund timing"],
    rivalEvidence: [],
    expectedOutput: "folded_markdown"
  });
  assert.equal(parsed.survivorProposalId, "A");
  assert.equal(parsed.rivalProposalId, "B");
});

test("fold output schema requires markdown and rationale", () => {
  assert.ok(foldMarkdownProposalOutputSchema.safeParse({ markdown: "m", rationale: "r" }).success);
  assert.ok(!foldMarkdownProposalOutputSchema.safeParse({ markdown: "m" }).success);
});

test("comment_pull_request input requires url and body", () => {
  assert.ok(commentPullRequestInputSchema.safeParse({ pullRequestUrl: "u", body: "b" }).success);
  assert.ok(!commentPullRequestInputSchema.safeParse({ pullRequestUrl: "u" }).success);
});
```

(Keep the existing import line if it already imports `draftMarkdownProposalInputSchema`; merge the names rather than duplicating the import.)

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `npm test -w @magpie/jobs`
Expected: FAIL — `foldMarkdownProposalInputSchema` undefined / `EXPIRATION_SECONDS[type]` undefined for the new types.

- [ ] **Step 4: Add the core types.** In `packages/core/src/index.ts`, immediately after the `DraftMarkdownProposalJobOutput` interface (~line 385):

```ts
export interface FoldMarkdownProposalJobInput {
  // The open proposal the rival is folded into; its markdown is updated in place.
  survivorProposalId: string;
  // The freshly-drafted proposal being absorbed, then superseded.
  rivalProposalId: string;
  targetPath: string;
  survivorMarkdown: string;
  rivalMarkdown: string;
  rivalGapSummaries: string[];
  rivalEvidence: Citation[];
  expectedOutput: "folded_markdown";
}

export interface FoldMarkdownProposalJobOutput {
  markdown: string;
  rationale: string;
}
```

- [ ] **Step 5: Add the job types.** In `packages/jobs/src/types.ts`, edit the `JOB_TYPES` array: add `"fold_markdown_proposal"` on the line after `"draft_markdown_proposal"`, and `"comment_pull_request"` on the line after `"crosslink_pull_requests"` (the last entry — add a comma to the previous last line):

```ts
  "draft_markdown_proposal",
  "fold_markdown_proposal",
  ...
  "crosslink_pull_requests",
  "comment_pull_request"
```

- [ ] **Step 6: Add the schemas.** In `packages/jobs/src/schemas.ts`, add to the `@magpie/core` import block:

```ts
  FoldMarkdownProposalJobInput as CoreFoldMarkdownProposalJobInput,
  FoldMarkdownProposalJobOutput as CoreFoldMarkdownProposalJobOutput,
```

Then add, after `draftMarkdownProposalOutputSchema` (~line 104):

```ts
export const foldMarkdownProposalInputSchema = z.object({
  provider: providerSchema,
  survivorProposalId: z.string(),
  rivalProposalId: z.string(),
  targetPath: z.string(),
  survivorMarkdown: z.string(),
  rivalMarkdown: z.string(),
  rivalGapSummaries: z.array(z.string()),
  rivalEvidence: z.array(citationSchema),
  expectedOutput: z.literal("folded_markdown")
}) satisfies z.ZodType<ProviderInput<CoreFoldMarkdownProposalJobInput>>;
export const foldMarkdownProposalOutputSchema = z.object({
  markdown: z.string(),
  rationale: z.string()
}) satisfies z.ZodType<CoreFoldMarkdownProposalJobOutput>;

// A single-PR comment as a github job (the API holds no GitHub token, so commenting
// must run in the watcher). crosslink_pull_requests can't serve here — it needs two
// PRs, and a folded-away rival never has one.
export const commentPullRequestInputSchema = z.object({
  pullRequestUrl: z.string(),
  body: z.string()
});
export const commentPullRequestOutputSchema = z.object({
  commentUrl: z.string().optional()
});
```

- [ ] **Step 7: Register the jobs in the catalog.** In `packages/jobs/src/catalog.ts`, add to the `definitions` object — a fold entry after `draft_markdown_proposal` and a comment entry after `crosslink_pull_requests`:

```ts
  fold_markdown_proposal: define("fold_markdown_proposal", "provider", schemas.foldMarkdownProposalInputSchema, schemas.foldMarkdownProposalOutputSchema, 15 * 60),
```
```ts
  comment_pull_request: define("comment_pull_request", "github", schemas.commentPullRequestInputSchema, schemas.commentPullRequestOutputSchema, 10 * 60)
```

(Add a comma after the existing `crosslink_pull_requests: ...` line.) Then add `"fold_markdown_proposal"` to the `aiJobTypes` set (after `"draft_markdown_proposal"`):

```ts
  "draft_markdown_proposal",
  "fold_markdown_proposal",
```

- [ ] **Step 8: Run the tests to verify they pass.**

Run: `npm test -w @magpie/jobs`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add packages/core/src/index.ts packages/jobs/src
git commit -m "feat(reconcile): add fold_markdown_proposal and comment_pull_request job contracts"
```

---

### Task 2: Watcher executes `fold_markdown_proposal`

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (new prompt + `promptCatalog` array)
- Modify: `apps/watcher/src/job-prompts.ts` (`buildPrompt` switch + import)
- Modify: `apps/watcher/src/runners/chat.ts` (`CHAT_JOB_TYPES`)
- Modify: `apps/watcher/src/runners/cli.ts` (`CLI_JOB_TYPES`)
- Test: `apps/watcher/src/runners/chat.test.ts`, `apps/watcher/src/runners/cli.test.ts`

**Interfaces:**
- Consumes: the `fold_markdown_proposal` job + `foldMarkdownProposalOutputSchema` from Task 1.
- Produces: `FOLD_MARKDOWN_PROPOSAL` prompt from `@magpie/prompts`. The fold job runs through the existing generic chat/cli path (`chat.complete` → `parseJobOutput`), no new runner method.

- [ ] **Step 1: Add the supports() assertions (they fail).** In `apps/watcher/src/runners/chat.test.ts`, find the test that asserts supported types and add:

```ts
  assert.ok(runner.supports("fold_markdown_proposal"));
```

In `apps/watcher/src/runners/cli.test.ts`, add the same assertion to its supports() test:

```ts
  assert.ok(runner.supports("fold_markdown_proposal"));
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="supports"`
Expected: FAIL — fold not yet supported.

- [ ] **Step 3: Add the prompt.** In `packages/prompts/src/catalog.ts`, add after `DRAFT_MARKDOWN_PROPOSAL`:

```ts
export const FOLD_MARKDOWN_PROPOSAL: PromptDefinition = {
  id: "fold-markdown-proposal",
  title: "Fold a rival proposal into an open one",
  description:
    "Merges a freshly-drafted rival Markdown article into an existing open proposal targeting the same document, producing one coherent article. Used by the watcher's fold_markdown_proposal job.",
  usedBy: ["watcher"],
  outputShape: "{ markdown, rationale }",
  instructions: `You are reconciling two Markdown knowledge-base articles that target the SAME document. "survivorMarkdown" is an article already open as a pull request; "rivalMarkdown" is a newly drafted article covering overlapping or adjacent gaps. Merge them into ONE coherent article that supersedes both.

Rules:
- Return JSON only.
- Produce a single article in "markdown" that preserves every fact from BOTH inputs. Do not lose information.
- Do not duplicate sections or restate the same point twice; integrate the rival's content where it belongs.
- Keep the survivor's overall structure and frontmatter where sensible, and extend it with the rival's material.
- The rival was drafted to address rivalGapSummaries — make sure the merged article answers them.
- In "rationale", briefly state what the rival contributed and how you integrated it.

Return JSON:
{
  "markdown": "string",
  "rationale": "string"
}`
};
```

Add `FOLD_MARKDOWN_PROPOSAL` to the `promptCatalog` array (after `DRAFT_MARKDOWN_PROPOSAL`).

- [ ] **Step 4: Wire buildPrompt.** In `apps/watcher/src/job-prompts.ts`, add `FOLD_MARKDOWN_PROPOSAL` to the `@magpie/prompts` import, and add a switch case (after the `draft_markdown_proposal` case):

```ts
    case "fold_markdown_proposal":
      return `${FOLD_MARKDOWN_PROPOSAL.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
```

- [ ] **Step 5: Add fold to both runner sets.** In `apps/watcher/src/runners/chat.ts`, add `"fold_markdown_proposal",` to `CHAT_JOB_TYPES` (after `"draft_markdown_proposal",`). In `apps/watcher/src/runners/cli.ts`, add the same line to `CLI_JOB_TYPES`.

- [ ] **Step 6: Run to verify pass.**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="supports"`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/prompts/src/catalog.ts apps/watcher/src/job-prompts.ts apps/watcher/src/runners/chat.ts apps/watcher/src/runners/cli.ts apps/watcher/src/runners/chat.test.ts apps/watcher/src/runners/cli.test.ts
git commit -m "feat(reconcile): run fold_markdown_proposal through the watcher chat/cli runners"
```

---

### Task 3: Watcher executes `comment_pull_request`

**Files:**
- Modify: `apps/watcher/src/runners/publication.ts` (`PUBLISH_JOB_TYPES`, imports, `run` switch, new method)
- Test: Create `apps/watcher/src/runners/publication-comment.test.ts`

**Interfaces:**
- Consumes: `commentPullRequestInputSchema` / `commentPullRequestOutputSchema` from Task 1; the existing `PublicationDeps.commentOnPullRequest`.
- Produces: the `PublicationRunner` now handles `"comment_pull_request"`, returning `{ commentUrl? }`.

- [ ] **Step 1: Write the failing test.** Create `apps/watcher/src/runners/publication-comment.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="comment_pull_request"`
Expected: FAIL — runner does not support the type.

- [ ] **Step 3: Implement.** In `apps/watcher/src/runners/publication.ts`:

Add to the `@magpie/jobs` import block:

```ts
  commentPullRequestInputSchema,
  commentPullRequestOutputSchema
```

Add `"comment_pull_request"` to `PUBLISH_JOB_TYPES`:

```ts
const PUBLISH_JOB_TYPES: ReadonlySet<JobType> = new Set([
  "publish_proposal",
  "publish_crunch",
  "publish_source_sync",
  "crosslink_pull_requests",
  "comment_pull_request"
]);
```

Add a branch in `run` (after the `crosslink_pull_requests` branch):

```ts
    if (job.type === "comment_pull_request") {
      return this.commentPullRequest(job);
    }
```

Add the method (after `crosslinkPullRequests`):

```ts
  private async commentPullRequest(job: JobView): Promise<unknown> {
    const { pullRequestUrl, body } = commentPullRequestInputSchema.parse(job.input);
    const commentUrl = await this.deps.commentOnPullRequest({ pullRequestUrl, body });
    return commentPullRequestOutputSchema.parse(commentUrl ? { commentUrl } : {});
  }
```

- [ ] **Step 4: Run to verify pass.**

Run: `npm test -w @magpie/watcher -- --test-name-pattern="comment_pull_request"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/watcher/src/runners/publication.ts apps/watcher/src/runners/publication-comment.test.ts
git commit -m "feat(reconcile): handle comment_pull_request in the publication runner"
```

---

### Task 4: Proposal store `updateMarkdown`

**Files:**
- Modify: `apps/api/src/stores/proposal-store.ts` (interface + `InMemoryProposalStore`)
- Modify: `apps/api/src/stores/postgres-proposal-store.ts`
- Test: Create or extend `apps/api/src/stores/proposal-store.test.ts`

**Interfaces:**
- Produces: `ProposalStore.updateMarkdown(id: string, markdown: string): Promise<Proposal | undefined>` — updates only the markdown, returns the updated proposal (or `undefined` if not found).

- [ ] **Step 1: Write the failing test.** Create (or append to) `apps/api/src/stores/proposal-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryProposalStore } from "./proposal-store.js";

test("updateMarkdown replaces the markdown and returns the proposal", async () => {
  const store = new InMemoryProposalStore();
  const created = await store.create({
    title: "Refunds",
    targetPath: "kb/refunds.md",
    markdown: "# old",
    rationale: "r",
    evidence: []
  });
  const updated = await store.updateMarkdown(created.id, "# new");
  assert.equal(updated?.markdown, "# new");
  assert.equal((await store.get(created.id))?.markdown, "# new");
});

test("updateMarkdown returns undefined for an unknown proposal", async () => {
  const store = new InMemoryProposalStore();
  assert.equal(await store.updateMarkdown("nope", "x"), undefined);
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm test -w @magpie/api -- --test-name-pattern="updateMarkdown"`
Expected: FAIL — `updateMarkdown` is not a function.

- [ ] **Step 3: Add to the interface and in-memory store.** In `apps/api/src/stores/proposal-store.ts`, add to the `ProposalStore` interface (after `recordPublication`):

```ts
  updateMarkdown(id: string, markdown: string): Promise<Proposal | undefined>;
```

Add the method to `InMemoryProposalStore` (after `recordPublication`):

```ts
  async updateMarkdown(id: string, markdown: string): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: Proposal = { ...existing, markdown };
    this.proposals.set(id, updated);
    return updated;
  }
```

- [ ] **Step 4: Add to the postgres store.** In `apps/api/src/stores/postgres-proposal-store.ts`, add (after `recordPublication`):

```ts
  async updateMarkdown(id: string, markdown: string): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET markdown = $2 WHERE id = $1 RETURNING *",
      [id, markdown]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }
```

- [ ] **Step 5: Run to verify pass.**

Run: `npm test -w @magpie/api -- --test-name-pattern="updateMarkdown"`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/stores/proposal-store.ts apps/api/src/stores/postgres-proposal-store.ts apps/api/src/stores/proposal-store.test.ts
git commit -m "feat(reconcile): add proposal-store updateMarkdown"
```

---

### Task 5: Fold orchestration (`scheduling/fold.ts`)

**Files:**
- Create: `apps/api/src/scheduling/fold.ts`
- Test: Create `apps/api/src/scheduling/fold.test.ts`

**Interfaces:**
- Consumes: `decideReconciliation`, `openPullRequestSummaries` (`./reconcile-gate.js`); `ChangeIntent` (`./intent.js`); `splitGapSummaries` (`../features/proposals/service.js`); `foldMarkdownProposalOutputSchema` (`@magpie/jobs`); store methods `proposals.updateMarkdown` (Task 4), `gapClusters.{listMembershipsForCluster,assignGapToCluster,freezeCluster,enqueuePublicationAction,getCluster}`.
- Produces:
  - `reconcileDraftedProposal(ctx: AppContext, rival: Proposal): Promise<void>` — if the rival overlaps a same-flow touchable proposal, enqueue a `fold_markdown_proposal` job.
  - `applyFoldFromCompletedJob(ctx: AppContext, job: JobView | undefined, output: unknown): Promise<void>` — apply a completed fold.
  - `enqueueFoldFallback(ctx: AppContext, job: JobView | undefined): Promise<void>` — on fold failure, enqueue the rival's publish.

- [ ] **Step 1: Write the failing tests.** Create `apps/api/src/scheduling/fold.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileDraftedProposal, applyFoldFromCompletedJob, enqueueFoldFallback } from "./fold.js";
import type { AppContext } from "../context.js";

async function clusterWithGap(ctx: AppContext, flowId: string | undefined, summary: string): Promise<string> {
  const log = await ctx.stores.questionLogs.record({
    question: `${summary}?`,
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, summary);
  const cluster = await ctx.stores.gapClusters.createCluster({ ...(flowId ? { flowId } : {}), title: summary, revision: 1 });
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary(summary);
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);
  return cluster.id;
}

async function draft(ctx: AppContext, opts: { targetPath: string; gapClusterId?: string }) {
  return ctx.stores.proposals.create({
    title: "T",
    targetPath: opts.targetPath,
    markdown: "# body",
    rationale: "r",
    evidence: [],
    ...(opts.gapClusterId ? { gapClusterId: opts.gapClusterId } : {})
  });
}

describe("reconcileDraftedProposal", () => {
  it("enqueues a fold job when a same-flow open proposal overlaps", async () => {
    const ctx = makeTestContext();
    await draft(ctx, { targetPath: "kb/refunds.md" }); // survivor A
    const rival = await draft(ctx, { targetPath: "kb/refunds.md" }); // rival B
    await reconcileDraftedProposal(ctx, rival);
    const jobs = (await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs;
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0].input as { rivalProposalId: string }).rivalProposalId, rival.id);
  });

  it("does not fold when there is no overlap", async () => {
    const ctx = makeTestContext();
    await draft(ctx, { targetPath: "kb/a.md" });
    const rival = await draft(ctx, { targetPath: "kb/b.md" });
    await reconcileDraftedProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
  });

  it("does not fold across flows", async () => {
    const ctx = makeTestContext();
    const cA = await clusterWithGap(ctx, "flow-x", "A");
    const cB = await clusterWithGap(ctx, "flow-y", "B");
    await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cA });
    const rival = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cB });
    await reconcileDraftedProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
  });
});

describe("applyFoldFromCompletedJob", () => {
  it("updates survivor markdown, absorbs the rival cluster, supersedes the rival, and enqueues a publish", async () => {
    const ctx = makeTestContext();
    const cA = await clusterWithGap(ctx, undefined, "survivor");
    const cB = await clusterWithGap(ctx, undefined, "rival");
    const survivor = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cA });
    const rival = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cB });

    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: survivor.id,
      rivalProposalId: rival.id,
      targetPath: "kb/refunds.md",
      survivorMarkdown: "# survivor",
      rivalMarkdown: "# rival",
      rivalGapSummaries: ["rival"],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    const stored = await ctx.jobs.get(job.id);
    await applyFoldFromCompletedJob(ctx, stored, { markdown: "# merged", rationale: "folded" });

    assert.equal((await ctx.stores.proposals.get(survivor.id))?.markdown, "# merged");
    assert.equal((await ctx.stores.proposals.get(rival.id))?.status, "superseded");
    assert.equal((await ctx.stores.gapClusters.getCluster(cB))?.status, "frozen");
    const survivorMembers = await ctx.stores.gapClusters.listMembershipsForCluster(cA);
    assert.equal(survivorMembers.length, 2, "rival's gap moved onto the survivor cluster");
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === survivor.id && a.kind === "publish"));
  });
});

describe("enqueueFoldFallback", () => {
  it("enqueues the rival's publish so the gap is not lost", async () => {
    const ctx = makeTestContext();
    const rival = await draft(ctx, { targetPath: "kb/refunds.md" });
    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: "missing",
      rivalProposalId: rival.id,
      targetPath: "kb/refunds.md",
      survivorMarkdown: "x",
      rivalMarkdown: "y",
      rivalGapSummaries: [],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    await enqueueFoldFallback(ctx, await ctx.jobs.get(job.id));
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === rival.id && a.kind === "publish"));
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcileDraftedProposal|applyFoldFromCompletedJob|enqueueFoldFallback"`
Expected: FAIL — `./fold.js` does not exist.

- [ ] **Step 3: Implement `apps/api/src/scheduling/fold.ts`:**

```ts
import type { Proposal } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { foldMarkdownProposalOutputSchema } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import { splitGapSummaries } from "../features/proposals/service.js";
import type { ChangeIntent } from "./intent.js";
import { decideReconciliation, openPullRequestSummaries } from "./reconcile-gate.js";

function sameFlow(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

// A proposal's owning flow is its cluster's flow; a cluster-less proposal belongs
// to the un-routed/default flow.
async function proposalFlowId(ctx: AppContext, proposal: Proposal): Promise<string | undefined> {
  if (!proposal.gapClusterId) {
    return undefined;
  }
  const cluster = await ctx.stores.gapClusters.getCluster(proposal.gapClusterId);
  return cluster?.flowId;
}

// At-draft fold: when a freshly-created draft proposal overlaps a touchable open
// proposal in the SAME flow, enqueue a fold_markdown_proposal job to merge them.
// Best-effort and only acts on the `fold` verdict; open-new/defer leave the draft
// untouched. The caller (completeJob) guards against this throwing.
export async function reconcileDraftedProposal(ctx: AppContext, rival: Proposal): Promise<void> {
  // Only intercept a still-draft rival; an already-published proposal is out of
  // scope for the at-draft hook.
  if (rival.status !== "draft" || !rival.targetPath) {
    return;
  }

  const flowId = await proposalFlowId(ctx, rival);
  const candidates: Proposal[] = [];
  for (const proposal of await ctx.stores.proposals.list(200)) {
    if (proposal.id === rival.id) {
      continue;
    }
    if (!sameFlow(await proposalFlowId(ctx, proposal), flowId)) {
      continue;
    }
    candidates.push(proposal);
  }

  const intent: ChangeIntent = {
    lens: "gap",
    flowId,
    targets: [rival.targetPath],
    evidence: rival.evidence.map((citation) => citation.path),
    rationale: rival.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));
  if (decision.kind !== "fold") {
    return;
  }

  const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
  if (!survivor) {
    return;
  }

  await ctx.jobs.create("fold_markdown_proposal", {
    provider: ctx.config.get().aiProvider,
    survivorProposalId: survivor.id,
    rivalProposalId: rival.id,
    targetPath: rival.targetPath,
    survivorMarkdown: survivor.markdown,
    rivalMarkdown: rival.markdown,
    rivalGapSummaries: splitGapSummaries(rival.gapSummary),
    rivalEvidence: rival.evidence,
    expectedOutput: "folded_markdown"
  });
  console.log(
    `Fold: enqueued fold_markdown_proposal to merge rival ${rival.id} into ${survivor.id} on ${rival.targetPath}.`
  );
}

// Applies a completed fold: update the survivor's markdown, absorb the rival's gap
// cluster into the survivor's (so the rival's gaps resolve when the survivor merges),
// supersede the rival, and re-publish the survivor through the outbox. Idempotent on
// a rival that is already superseded.
export async function applyFoldFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "fold_markdown_proposal") {
    return;
  }
  const parsed = foldMarkdownProposalOutputSchema.safeParse(output);
  if (!parsed.success) {
    return;
  }
  const input = job.input as { survivorProposalId?: string; rivalProposalId?: string };
  if (!input.survivorProposalId || !input.rivalProposalId) {
    return;
  }
  const survivor = await ctx.stores.proposals.get(input.survivorProposalId);
  const rival = await ctx.stores.proposals.get(input.rivalProposalId);
  if (!survivor || !rival || rival.status === "superseded") {
    return;
  }

  await ctx.stores.proposals.updateMarkdown(survivor.id, parsed.data.markdown);

  if (survivor.gapClusterId && rival.gapClusterId && survivor.gapClusterId !== rival.gapClusterId) {
    const members = await ctx.stores.gapClusters.listMembershipsForCluster(rival.gapClusterId);
    for (const member of members) {
      await ctx.stores.gapClusters.assignGapToCluster(survivor.gapClusterId, member.gapId, "folded");
    }
    await ctx.stores.gapClusters.freezeCluster(rival.gapClusterId);
  }

  await ctx.stores.proposals.updateStatus(rival.id, "superseded");
  await ctx.stores.gapClusters.enqueuePublicationAction(survivor.id, "publish");

  const pullRequestUrl = survivor.publication?.pullRequestUrl;
  if (pullRequestUrl) {
    await ctx.jobs.create("comment_pull_request", {
      pullRequestUrl,
      body:
        `🪶 **Magpie:** folded "${rival.title}" into this PR — it covered overlapping gaps on ` +
        `\`${survivor.targetPath}\`. This PR has been updated to include that material. ` +
        "_(automated fold-on-overlap)_"
    });
  }
  console.log(`Fold: merged rival ${rival.id} into survivor ${survivor.id}; survivor re-publish enqueued.`);
}

// Fold failed terminally: publish the rival as its own PR so its gap is never lost.
// The #21 cross-link backstop then catches the A/B overlap. Only acts on a rival
// still in draft (nothing was applied).
export async function enqueueFoldFallback(ctx: AppContext, job: JobView | undefined): Promise<void> {
  if (!job || job.type !== "fold_markdown_proposal") {
    return;
  }
  const input = job.input as { rivalProposalId?: string };
  if (!input.rivalProposalId) {
    return;
  }
  const rival = await ctx.stores.proposals.get(input.rivalProposalId);
  if (!rival || rival.status !== "draft") {
    return;
  }
  await ctx.stores.gapClusters.enqueuePublicationAction(rival.id, "publish");
  console.log(`Fold fallback: fold job ${job.id} failed; enqueued rival ${rival.id} to publish as its own PR.`);
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `npm test -w @magpie/api -- --test-name-pattern="reconcileDraftedProposal|applyFoldFromCompletedJob|enqueueFoldFallback"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/scheduling/fold.ts apps/api/src/scheduling/fold.test.ts
git commit -m "feat(reconcile): fold orchestration (decide, apply, fallback)"
```

---

### Task 6: Wire fold into the completion dispatcher and failure path

**Files:**
- Modify: `apps/api/src/features/jobs/service.ts` (`completeJob`, `failJob`)
- Test: Create `apps/api/src/features/jobs/fold-dispatch.test.ts`

**Interfaces:**
- Consumes: `reconcileDraftedProposal`, `applyFoldFromCompletedJob`, `enqueueFoldFallback` from Task 5.
- Produces: `completeJob` enqueues a fold when a draft overlaps an open proposal; applies a completed fold; `failJob` and the `invalid_output` branch enqueue the fold fallback.

- [ ] **Step 1: Write the failing integration tests.** Create `apps/api/src/features/jobs/fold-dispatch.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestContext } from "../../test-support/context.js";
import { completeJob, failJob } from "./service.js";
import type { AppContext } from "../../context.js";

const draftInput = {
  provider: "codex" as const,
  gapSummaries: ["g"],
  triggeringQuestions: ["q"],
  evidence: [],
  expectedOutput: "markdown_proposal" as const
};
const draftOutput = (title: string) => ({ title, targetPath: "ignored", markdown: "# body", rationale: "r" });

async function completeDraft(ctx: AppContext, title: string): Promise<void> {
  const job = await ctx.jobs.create("draft_markdown_proposal", draftInput);
  const result = await completeJob(ctx, job.id, draftOutput(title));
  assert.ok(result.ok, "draft completion should succeed");
}

test("a second draft on the same target enqueues a fold instead of a rival", async () => {
  const ctx = makeTestContext();
  // Two drafts with the same title resolve to the same targetPath, so the second
  // overlaps the first.
  await completeDraft(ctx, "Refund policy");
  assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0, "first draft: no fold");

  await completeDraft(ctx, "Refund policy");
  const folds = (await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs;
  assert.equal(folds.length, 1, "second draft on the same path enqueues exactly one fold");
});

test("completing a fold job applies it (rival superseded, survivor markdown updated)", async () => {
  const ctx = makeTestContext();
  const survivor = await ctx.stores.proposals.create({
    title: "A", targetPath: "kb/refunds.md", markdown: "# survivor", rationale: "r", evidence: []
  });
  const rival = await ctx.stores.proposals.create({
    title: "B", targetPath: "kb/refunds.md", markdown: "# rival", rationale: "r", evidence: []
  });
  const job = await ctx.jobs.create("fold_markdown_proposal", {
    provider: "codex",
    survivorProposalId: survivor.id,
    rivalProposalId: rival.id,
    targetPath: "kb/refunds.md",
    survivorMarkdown: "# survivor",
    rivalMarkdown: "# rival",
    rivalGapSummaries: [],
    rivalEvidence: [],
    expectedOutput: "folded_markdown"
  });
  const result = await completeJob(ctx, job.id, { markdown: "# merged", rationale: "folded" });
  assert.ok(result.ok);
  assert.equal((await ctx.stores.proposals.get(survivor.id))?.markdown, "# merged");
  assert.equal((await ctx.stores.proposals.get(rival.id))?.status, "superseded");
});

test("a failed fold job enqueues the rival's publish fallback", async () => {
  const ctx = makeTestContext();
  const rival = await ctx.stores.proposals.create({
    title: "B", targetPath: "kb/refunds.md", markdown: "# rival", rationale: "r", evidence: []
  });
  const job = await ctx.jobs.create("fold_markdown_proposal", {
    provider: "codex",
    survivorProposalId: "missing",
    rivalProposalId: rival.id,
    targetPath: "kb/refunds.md",
    survivorMarkdown: "x",
    rivalMarkdown: "y",
    rivalGapSummaries: [],
    rivalEvidence: [],
    expectedOutput: "folded_markdown"
  });
  await failJob(ctx, job.id, { code: "boom", message: "provider error", category: "provider", executor: "watcher" });
  const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.ok(pending.some((a) => a.proposalId === rival.id && a.kind === "publish"));
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm test -w @magpie/api -- --test-name-pattern="fold"`
Expected: FAIL — no fold job enqueued / not applied / no fallback.

- [ ] **Step 3: Wire `completeJob`.** In `apps/api/src/features/jobs/service.ts`, add the import near the top (with the other scheduling import):

```ts
import * as foldService from "../../scheduling/fold.js";
```

In `completeJob`, replace the line

```ts
    await proposalsService.createProposalFromCompletedJob(ctx, existingJob, parsed.data);
```

with:

```ts
    const draftedProposal = await proposalsService.createProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (draftedProposal) {
      // At-draft fold: best-effort, must never fail the draft completion itself.
      try {
        await foldService.reconcileDraftedProposal(ctx, draftedProposal);
      } catch (error) {
        console.warn(`Fold check for proposal ${draftedProposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await foldService.applyFoldFromCompletedJob(ctx, existingJob, parsed.data);
```

- [ ] **Step 4: Wire the `invalid_output` fallback.** In `completeJob`, in the `if (!parsed.success)` block, after the `await ctx.jobs.fail(...)` call and before `return { ok: false, code: "invalid_output" }`, add:

```ts
    if (existingJob.type === "fold_markdown_proposal") {
      await foldService.enqueueFoldFallback(ctx, existingJob);
    }
```

- [ ] **Step 5: Wire `failJob`.** In `failJob`, after the `sync_source_changes_generate_plan` block and before `return failedJob;`, add:

```ts
  if (failingJob?.type === "fold_markdown_proposal" && failedJob.state === "failed") {
    await foldService.enqueueFoldFallback(ctx, failingJob);
  }
```

- [ ] **Step 6: Run to verify pass.**

Run: `npm test -w @magpie/api -- --test-name-pattern="fold"`
Expected: PASS.

- [ ] **Step 7: Run the full gates.**

Run: `npm test -w @magpie/api && npm test -w @magpie/jobs && npm test -w @magpie/watcher && npm run typecheck && npm run deadcode`
Expected: PASS (ignore the Windows-only watcher path test if running locally). If `npm run deadcode` flags a new export as unused, make it file-local rather than relaxing knip.

- [ ] **Step 8: Commit.**

```bash
git add apps/api/src/features/jobs/service.ts apps/api/src/features/jobs/fold-dispatch.test.ts
git commit -m "feat(reconcile): fold a drafted proposal into an overlapping open PR at completion"
```

---

## Self-Review

**Spec coverage:**
- At-draft hook in the completion dispatcher → Task 6 (`reconcileDraftedProposal` wired into `completeJob`).
- Same-flow filter + exclude-self → Task 5 `reconcileDraftedProposal`.
- `fold_markdown_proposal` AI job (contract / prompt / runner) → Tasks 1, 2.
- Apply fold: update markdown, absorb cluster, supersede, re-publish via outbox, comment when A has a PR → Task 5 `applyFoldFromCompletedJob` + Task 4 `updateMarkdown` + Task 3 `comment_pull_request`.
- Fallback on failure (failJob + invalid_output) → Task 6.
- `comment_pull_request` github job → Tasks 1, 3.
- Tests enumerated in the spec → covered across Tasks 1–6.

**Placeholder scan:** none — every code step shows full code.

**Type consistency:** `reconcileDraftedProposal` / `applyFoldFromCompletedJob` / `enqueueFoldFallback` names match across Tasks 5 and 6; `updateMarkdown(id, markdown)` matches Tasks 4 and 5; fold job input field names (`survivorProposalId`, `rivalProposalId`, `survivorMarkdown`, `rivalMarkdown`, `rivalGapSummaries`, `rivalEvidence`, `expectedOutput: "folded_markdown"`) are identical across the core type (Task 1), schema (Task 1), enqueue (Task 5), and tests (Tasks 5, 6).

**Notes for the implementer:**
- `ctx.config.get().aiProvider` is the configured provider (same call `gap-reconciler.ts` uses for `reconcile_gap_clusters`).
- The fake broker strips undeclared input keys, so the Task 5/6 tests that create a `fold_markdown_proposal` job and read it back also prove the Task 1 schema is complete.
- Two drafts with the same title resolve to the same `targetPath` (the path is derived from the title in `createProposalFromCompletedJob`), which is how Task 6's headline test forces an overlap without hard-coding the path formula.
