# Local-git Proposal Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the proposal "Mark Merged" button into a real **Merge** for local-git (`file://`) destinations — a synchronous API endpoint that runs `git merge` of the pushed proposal branch into the destination's default branch, then re-indexes.

**Architecture:** A new `@magpie/git` helper performs the merge directly in the destination's own working tree (where the branch was already pushed). A new `POST /api/proposals/:id/merge` API route calls it, then reuses the existing `runMergeCascade` in the background — mirroring the current manual `/:id/status`→merged path. The web console reads a computed `localGitDestination` flag on each proposal to switch the button's label and action; hosted/GitHub destinations are unchanged.

**Tech Stack:** TypeScript (ESM/NodeNext), Node ≥22.13, Hono (API), Next.js (web), `node:test` + `node:assert/strict`, `git` CLI.

## Global Constraints

- **ESM/NodeNext:** every relative import needs an explicit `.js` extension, even from `.ts`.
- **Never cast through `unknown`/`any`** to silence types — fix types properly.
- **No hacky workarounds** — fix the root cause.
- **Validate as you go:** run build/test/typecheck/lint per task, not batched.
- **Commit and push little and often.**
- **Node ≥22.13**, npm workspaces monorepo.
- Merge failure must **never** advance proposal status — git state and magpie state stay consistent.
- Feature is **demo/local only**; document it as not-for-production.

## Preflight (run once)

- [ ] **Install deps in this worktree** (fresh worktrees have no `node_modules`, and the build gate otherwise resolves `@magpie/*` to main's stale `dist`):

Run: `npm install`
Expected: completes; `node_modules` present at the worktree root.

- [ ] **Baseline build** so `@magpie/*` dist exists for downstream packages:

Run: `npm run build`
Expected: all workspaces build.

---

### Task 1: `mergeLocalProposalBranch` git helper (`@magpie/git`)

**Files:**
- Modify: `packages/git/src/index.ts` (add the export near `LocalGitProposalPublisher`)
- Test: `packages/git/src/proposal-merge.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface MergeLocalProposalBranchRequest { repoPath: string; branchName: string; defaultBranch: string }`
  - `interface MergeLocalProposalBranchResult { mergeCommitSha: string }`
  - `mergeLocalProposalBranch(request: MergeLocalProposalBranchRequest): Promise<MergeLocalProposalBranchResult>`
- Consumes (already in `index.ts`): internal `git`, `tryGit`, `resolveCommitterIdentity`, and `withCheckoutLock` (imported from `./checkout-lock.js`).

- [ ] **Step 1: Write the failing test**

Create `packages/git/src/proposal-merge.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mergeLocalProposalBranch } from "./index.js";

const execFileAsync = promisify(execFile);

// The helper commits a merge, so it needs a committer identity in the env.
process.env.MAGPIE_GIT_AUTHOR_NAME = "Magpie";
process.env.MAGPIE_GIT_AUTHOR_EMAIL = "magpie@example.com";

const BRANCH = "magpie/proposal-abc";

// A non-bare repo on `main` with a `magpie/proposal-abc` branch that adds one
// file — the state a local-git destination is in after the publisher pushes.
async function initRepoWithProposalBranch(): Promise<string> {
  const repoPath = path.join(await mkdtemp(path.join(tmpdir(), "magpie-merge-")), "repo");
  await mkdir(repoPath, { recursive: true });
  const run = (args: string[]) => execFileAsync("git", args, { cwd: repoPath });
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Seed"]);
  await run(["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(repoPath, "README.md"), "# seed\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "seed"]);
  await run(["checkout", "-b", BRANCH]);
  await writeFile(path.join(repoPath, "new-doc.md"), "# New\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "add new doc"]);
  await run(["checkout", "main"]);
  return repoPath;
}

test("mergeLocalProposalBranch merges the branch into main and deletes it", async () => {
  const repoPath = await initRepoWithProposalBranch();

  const result = await mergeLocalProposalBranch({ repoPath, branchName: BRANCH, defaultBranch: "main" });

  assert.match(result.mergeCommitSha, /^[0-9a-f]{7,40}$/);
  const content = await readFile(path.join(repoPath, "new-doc.md"), "utf8");
  assert.match(content, /# New/);
  const branches = await execFileAsync("git", ["branch", "--list", BRANCH], { cwd: repoPath });
  assert.equal(branches.stdout.trim(), "", "merged proposal branch is deleted");
});

test("mergeLocalProposalBranch aborts and throws on conflict, leaving main untouched", async () => {
  const repoPath = path.join(await mkdtemp(path.join(tmpdir(), "magpie-merge-")), "repo");
  await mkdir(repoPath, { recursive: true });
  const run = (args: string[]) => execFileAsync("git", args, { cwd: repoPath });
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Seed"]);
  await run(["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(repoPath, "doc.md"), "A\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "seed"]);
  await run(["checkout", "-b", BRANCH]);
  await writeFile(path.join(repoPath, "doc.md"), "B\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "branch change"]);
  await run(["checkout", "main"]);
  await writeFile(path.join(repoPath, "doc.md"), "C\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "main change"]);

  await assert.rejects(
    () => mergeLocalProposalBranch({ repoPath, branchName: BRANCH, defaultBranch: "main" }),
    /Could not merge/
  );

  // main's working tree is restored (abort succeeded) and the branch survives.
  const content = await readFile(path.join(repoPath, "doc.md"), "utf8");
  assert.equal(content, "C\n");
  const branches = await execFileAsync("git", ["branch", "--list", BRANCH], { cwd: repoPath });
  assert.equal(branches.stdout.trim().replace(/^\*?\s*/, ""), BRANCH);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w packages/git`
Expected: FAIL — `mergeLocalProposalBranch` is not exported (import error / undefined).

- [ ] **Step 3: Implement the helper**

In `packages/git/src/index.ts`, add near `LocalGitProposalPublisher` (it can use the module-local `git`, `tryGit`, `resolveCommitterIdentity`, and the imported `withCheckoutLock`):

```ts
export interface MergeLocalProposalBranchRequest {
  // The destination repo's own working tree (the folder the user browses).
  // The proposal branch was already pushed here, so it exists as a local ref.
  repoPath: string;
  branchName: string;
  defaultBranch: string;
}

export interface MergeLocalProposalBranchResult {
  mergeCommitSha: string;
}

// Merges an already-pushed proposal branch into the destination's default branch,
// directly in the destination working tree, then deletes the branch. Always makes
// a merge commit (`--no-ff`) so the merge is explicit and needs the configured
// committer identity. On ANY failure (conflict, dirty tree, missing branch) it
// runs `git merge --abort` and throws, leaving the default branch exactly as it
// was — the caller must not advance the proposal on a throw.
export async function mergeLocalProposalBranch(
  request: MergeLocalProposalBranchRequest
): Promise<MergeLocalProposalBranchResult> {
  const { repoPath, branchName, defaultBranch } = request;
  return withCheckoutLock(repoPath, async () => {
    await git(repoPath, ["checkout", defaultBranch]);

    const { name, email } = resolveCommitterIdentity();
    try {
      await git(repoPath, [
        "-c",
        `user.name=${name}`,
        "-c",
        `user.email=${email}`,
        "merge",
        "--no-ff",
        "--no-edit",
        branchName
      ]);
    } catch (error) {
      // Undo a half-applied/conflicted merge so the working tree returns to the
      // default branch tip; best-effort so the original cause still surfaces.
      await tryGit(repoPath, ["merge", "--abort"]);
      const message = error instanceof Error ? error.message : "git merge failed";
      throw new Error(`Could not merge ${branchName} into ${defaultBranch}: ${message}`, { cause: error });
    }

    const mergeCommitSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    // The branch is fully merged now; delete it so the demo repo stays tidy.
    // A failed delete must not fail the merge.
    await tryGit(repoPath, ["branch", "-D", branchName]);
    return { mergeCommitSha };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w packages/git`
Expected: PASS (both new tests, plus the package's existing tests).

- [ ] **Step 5: Build + typecheck the package**

Run: `npm run build -w packages/git && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/git/src/index.ts packages/git/src/proposal-merge.test.ts
git commit -m "feat(git): add mergeLocalProposalBranch for local-git destinations"
```

---

### Task 2: `localGitDestination` flag + `mergeLocalProposal` service (`apps/api`)

**Files:**
- Modify: `packages/core/src/index.ts` (add optional `localGitDestination` to `Proposal`)
- Modify: `apps/api/src/features/proposals/service.ts`
- Test: `apps/api/src/features/proposals/service.test.ts` (add tests)

**Interfaces:**
- Consumes: `mergeLocalProposalBranch` (Task 1); `selectDestinationForProposal` (from `../../platform/repositories.js`); `ctx.stores.proposals.updateStatus`, `ctx.repositoryDeps()`, `ctx.knowledgeConfig`.
- Produces:
  - `Proposal.localGitDestination?: boolean` (computed, non-persisted).
  - `isLocalGitDestination(ctx: AppContext, proposal: Proposal): boolean`
  - `mergeLocalProposal(ctx, proposal, merge?): Promise<MergeLocalProposalResult>` where
    `type MergeLocalProposalResult = { ok: true; proposal: Proposal } | { ok: false; code: "proposal_not_mergeable" | "not_local_git_destination" | "merge_conflict"; message: string }`
  - `list`/`get` now return proposals carrying `localGitDestination`.

- [ ] **Step 1: Add the computed field to the core `Proposal` type**

In `packages/core/src/index.ts`, inside `interface Proposal`, add after `mergedAt?: string;`:

```ts
  // Computed by the API when serving proposals to the console (NOT persisted):
  // true when this proposal's destination is a local-git (file://) repository, so
  // the UI offers a real "Merge" instead of the hosted "Mark Merged".
  localGitDestination?: boolean;
```

- [ ] **Step 2: Write the failing tests**

In `apps/api/src/features/proposals/service.test.ts`, add at the end (the file already imports `test`, `assert`, `makeTestContext`, and `* as proposals`; add `fileURLToPath` locally):

```ts
// --- local-git merge -------------------------------------------------------
import { fileURLToPath } from "node:url";

function ctxWithDestination(url: string): ReturnType<typeof makeTestContext> {
  return makeTestContext({
    knowledgeConfig: {
      sources: [],
      destinations: [{ id: "demo", name: "Demo", url, kind: "git" }],
      flows: [],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

async function branchPushedProposal(
  ctx: ReturnType<typeof makeTestContext>,
  remoteUrl: string
): Promise<string> {
  const created = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\n",
    rationale: "r",
    evidence: [],
    destinationId: "demo"
  });
  await ctx.stores.proposals.recordPublication(created.id, {
    provider: "local-git",
    branchName: "magpie/proposal-abc",
    commitSha: "deadbeef",
    remoteUrl,
    publishedAt: new Date().toISOString()
  });
  return created.id;
}

test("isLocalGitDestination is true only for file:// destinations", async () => {
  const proposal = { targetPath: "configure-x.md", destinationId: "demo" } as never;
  assert.equal(proposals.isLocalGitDestination(ctxWithDestination("file:///tmp/demo"), proposal), true);
  assert.equal(proposals.isLocalGitDestination(ctxWithDestination("https://github.com/o/r.git"), proposal), false);
  assert.equal(proposals.isLocalGitDestination(makeTestContext(), proposal), false);
});

test("mergeLocalProposal merges, marks merged, and targets the destination repo", async () => {
  const url = "file:///tmp/demo-kb";
  const ctx = ctxWithDestination(url);
  const id = await branchPushedProposal(ctx, url);
  const proposal = await ctx.stores.proposals.get(id);
  assert.ok(proposal);

  const calls: Array<{ repoPath: string; branchName: string; defaultBranch: string }> = [];
  const fakeMerge = async (req: { repoPath: string; branchName: string; defaultBranch: string }) => {
    calls.push(req);
    return { mergeCommitSha: "merge-sha" };
  };

  const result = await proposals.mergeLocalProposal(ctx, proposal, fakeMerge);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repoPath, fileURLToPath(url));
  assert.equal(calls[0].branchName, "magpie/proposal-abc");
  assert.equal(calls[0].defaultBranch, "main");
  assert.equal((await ctx.stores.proposals.get(id))?.status, "merged");
});

test("mergeLocalProposal rejects a hosted destination", async () => {
  const ctx = ctxWithDestination("https://github.com/o/r.git");
  const id = await branchPushedProposal(ctx, "https://github.com/o/r.git");
  const proposal = await ctx.stores.proposals.get(id);
  assert.ok(proposal);
  const result = await proposals.mergeLocalProposal(ctx, proposal, async () => ({ mergeCommitSha: "x" }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "not_local_git_destination");
});

test("mergeLocalProposal rejects a proposal that is not branch-pushed", async () => {
  const url = "file:///tmp/demo-kb";
  const ctx = ctxWithDestination(url);
  const created = await ctx.stores.proposals.create({
    title: "Draft", targetPath: "d.md", markdown: "# d\n", rationale: "r", evidence: [], destinationId: "demo"
  });
  const proposal = await ctx.stores.proposals.get(created.id);
  assert.ok(proposal);
  const result = await proposals.mergeLocalProposal(ctx, proposal, async () => ({ mergeCommitSha: "x" }));
  assert.equal(result.ok === false && result.code, "proposal_not_mergeable");
});

test("mergeLocalProposal keeps status on a merge conflict", async () => {
  const url = "file:///tmp/demo-kb";
  const ctx = ctxWithDestination(url);
  const id = await branchPushedProposal(ctx, url);
  const proposal = await ctx.stores.proposals.get(id);
  assert.ok(proposal);
  const result = await proposals.mergeLocalProposal(ctx, proposal, async () => {
    throw new Error("Could not merge magpie/proposal-abc into main: CONFLICT");
  });
  assert.equal(result.ok === false && result.code, "merge_conflict");
  assert.equal((await ctx.stores.proposals.get(id))?.status, "branch-pushed");
});

test("list attaches localGitDestination", async () => {
  const url = "file:///tmp/demo-kb";
  const ctx = ctxWithDestination(url);
  await branchPushedProposal(ctx, url);
  const [listed] = await proposals.list(ctx, 10);
  assert.equal(listed.localGitDestination, true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w apps/api`
Expected: FAIL — `proposals.isLocalGitDestination` / `proposals.mergeLocalProposal` are not defined; `list` result lacks `localGitDestination`.

- [ ] **Step 4: Implement the service additions**

In `apps/api/src/features/proposals/service.ts`:

Add imports at the top (with the other imports):

```ts
import { fileURLToPath } from "node:url";
import { mergeLocalProposalBranch } from "@magpie/git";
```

Ensure `selectDestinationForProposal` is in the existing import from `../../platform/repositories.js` (it already is).

Add the helpers and merge function (e.g. below `runMergeCascade`):

```ts
function isFileUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

// True when the proposal's configured destination is a local-git (file://)
// repository — the case where the console offers a real Merge instead of the
// hosted "Mark Merged". Config-only (no git/network), cheap enough per list item.
export function isLocalGitDestination(ctx: AppContext, proposal: Proposal): boolean {
  if (ctx.knowledgeConfig.destinations.length === 0) {
    return false;
  }
  const destination = selectDestinationForProposal(ctx.repositoryDeps(), proposal);
  return isFileUrl(destination?.url);
}

export type MergeLocalProposalResult =
  | { ok: true; proposal: Proposal }
  | {
      ok: false;
      code: "proposal_not_mergeable" | "not_local_git_destination" | "merge_conflict";
      message: string;
    };

// Merges a branch-pushed local-git proposal into its destination's default
// branch, then marks it merged. The git merge is injected so tests exercise the
// orchestration without shelling out. On merge failure the proposal is left at
// branch-pushed so git state and magpie state never disagree; the caller runs
// the (slow) re-index cascade after this returns ok.
export async function mergeLocalProposal(
  ctx: AppContext,
  proposal: Proposal,
  merge: typeof mergeLocalProposalBranch = mergeLocalProposalBranch
): Promise<MergeLocalProposalResult> {
  if (proposal.status !== "branch-pushed" || !proposal.publication?.branchName) {
    return {
      ok: false,
      code: "proposal_not_mergeable",
      message: "Only a branch-pushed proposal with a published branch can be merged locally."
    };
  }

  const destination = selectDestinationForProposal(ctx.repositoryDeps(), proposal);
  if (!isFileUrl(destination?.url)) {
    return {
      ok: false,
      code: "not_local_git_destination",
      message: "This proposal's destination is not a local-git (file://) repository."
    };
  }

  const repoPath = fileURLToPath(destination.url as string);
  const defaultBranch = destination.branch?.trim() || "main";

  try {
    await merge({ repoPath, branchName: proposal.publication.branchName, defaultBranch });
  } catch (error) {
    return {
      ok: false,
      code: "merge_conflict",
      message: error instanceof Error ? error.message : "git merge failed"
    };
  }

  const merged = await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  if (!merged) {
    return { ok: false, code: "proposal_not_mergeable", message: "Proposal not found." };
  }
  return { ok: true, proposal: merged };
}
```

Then augment `list` and `get` so responses carry the flag. Replace the existing `list`/`get`:

```ts
export async function list(ctx: AppContext, limit: number, options?: ProposalListOptions): Promise<Proposal[]> {
  const proposals = await ctx.stores.proposals.list(limit, options);
  return proposals.map((proposal) => ({ ...proposal, localGitDestination: isLocalGitDestination(ctx, proposal) }));
}

export async function get(ctx: AppContext, id: string): Promise<Proposal | undefined> {
  const proposal = await ctx.stores.proposals.get(id);
  return proposal ? { ...proposal, localGitDestination: isLocalGitDestination(ctx, proposal) } : undefined;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w apps/api`
Expected: PASS (new tests + existing proposals tests).

- [ ] **Step 6: Build + typecheck**

Run: `npm run build -w packages/core && npm run build -w apps/api && npm run typecheck`
Expected: no errors. (core builds first so the new field is visible downstream.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts apps/api/src/features/proposals/service.ts apps/api/src/features/proposals/service.test.ts
git commit -m "feat(api): add mergeLocalProposal service + localGitDestination flag"
```

---

### Task 3: `POST /api/proposals/:id/merge` route + docs

**Files:**
- Modify: `apps/api/src/features/proposals/routes.ts`
- Test: `apps/api/src/features/proposals/routes.merge.test.ts` (create)
- Modify: `docs/api.md`

**Interfaces:**
- Consumes: `proposalsService.get`, `proposalsService.mergeLocalProposal`, `proposalsService.runMergeCascade`; `can`, `assertCan`, `HttpError`, `ctx.background.run` (all already imported/available in this module).
- Produces: `POST /proposals/:id/merge` → `200 { proposal, cascadeScheduled: true }`, or `404 proposal_not_found`, or `409` (`proposal_not_mergeable` | `not_local_git_destination` | `merge_conflict`).

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/features/proposals/routes.merge.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { proposalRoutes } from "./routes.js";

function principal(): Principal {
  return { subject: "auth0|tester", scopes: ["read:knowledge", "manage:knowledge"], roles: undefined, payload: {} };
}

function appFor(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", principal());
    await next();
  });
  app.route("/proposals", proposalRoutes(ctx));
  app.onError(onError);
  return app;
}

function ctxWithLocalGit(): AppContext {
  return makeTestContext({
    knowledgeConfig: {
      sources: [],
      destinations: [{ id: "demo", name: "Demo", url: "file:///tmp/demo-kb", kind: "git" }],
      flows: [],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

async function seedBranchPushed(ctx: AppContext): Promise<string> {
  const created = await ctx.stores.proposals.create({
    title: "Configure X", targetPath: "configure-x.md", markdown: "# X\n", rationale: "r", evidence: [], destinationId: "demo"
  });
  await ctx.stores.proposals.recordPublication(created.id, {
    provider: "local-git", branchName: "magpie/proposal-abc", commitSha: "deadbeef",
    remoteUrl: "file:///tmp/demo-kb", publishedAt: new Date().toISOString()
  });
  return created.id;
}

describe("POST /proposals/:id/merge", () => {
  it("404s for an unknown proposal", async () => {
    const res = await appFor(ctxWithLocalGit()).request("/proposals/nope/merge", { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("409s a hosted destination", async () => {
    const ctx = makeTestContext({
      knowledgeConfig: {
        sources: [], destinations: [{ id: "demo", name: "Demo", url: "https://github.com/o/r.git", kind: "git" }],
        flows: [], repositories: [], roleGrants: {}, checkoutRoot: ".magpie/checkouts"
      }
    });
    const id = await seedBranchPushed(ctx);
    const res = await appFor(ctx).request(`/proposals/${id}/merge`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "not_local_git_destination");
  });
});
```

Note: the happy path (real git merge) is covered at the service level in Task 2 with an injected merge; the route test deliberately avoids shelling out to git and asserts the guard behavior only.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w apps/api`
Expected: FAIL — no `/merge` route (404 for both, so the hosted-destination assertion fails on `error === "not_local_git_destination"`).

- [ ] **Step 3: Add the route**

In `apps/api/src/features/proposals/routes.ts`, add after the `/:id/status` handler (before `/:id/publish`):

```ts
  app.post("/:id/merge", requireScopes("manage:knowledge"), async (c) => {
    const id = c.req.param("id");
    const existing = await proposalsService.get(ctx, id);
    if (!existing || !can(ctx, c, "read", existing.flowId)) {
      throw new HttpError(404, "proposal_not_found");
    }
    assertCan(ctx, c, "manage", existing.flowId);

    const outcome = await proposalsService.mergeLocalProposal(ctx, existing);
    if (!outcome.ok) {
      // All three failures are client/state errors (bad status, wrong destination
      // type, or an unresolvable merge) — 409 Conflict with the specific code.
      throw new HttpError(409, outcome.code, outcome.message);
    }

    // Merge is recorded synchronously; the slow cascade (resolve gaps + re-index,
    // which fetches/fast-forwards the checkout) runs off the request thread,
    // mirroring the /:id/status merged path.
    const proposal = outcome.proposal;
    ctx.background.run(`merge-cascade ${proposal.id}`, async () => {
      await proposalsService.runMergeCascade(ctx, proposal);
    });
    return c.json({ proposal, cascadeScheduled: true });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w apps/api`
Expected: PASS.

- [ ] **Step 5: Document the endpoint**

In `docs/api.md`, add an entry near the other `/proposals` routes:

```markdown
### `POST /api/proposals/:id/merge`

**Demo/local only.** Merges a `branch-pushed` proposal whose destination is a
local-git (`file://`) repository: runs `git merge` of the pushed
`magpie/proposal-…` branch into the destination's default branch, marks the
proposal `merged`, and schedules the re-index cascade in the background.

- Request body: none.
- `200 { proposal, cascadeScheduled: true }`
- `404 proposal_not_found`
- `409 proposal_not_mergeable` — not branch-pushed / no published branch.
- `409 not_local_git_destination` — destination is hosted (use the PR, not this).
- `409 merge_conflict` — the merge could not be applied; the proposal stays
  `branch-pushed` and the git message is returned.
```

- [ ] **Step 6: Typecheck + lint + commit**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

```bash
git add apps/api/src/features/proposals/routes.ts apps/api/src/features/proposals/routes.merge.test.ts docs/api.md
git commit -m "feat(api): POST /proposals/:id/merge for local-git destinations"
```

---

### Task 4: Web console — Merge button + `mergeProposal` action

**Files:**
- Modify: `apps/web/src/components/ProposalsPanel.tsx`
- Modify: `apps/web/src/components/ConsoleProvider.tsx`
- Modify: `apps/web/src/app/proposals/page.tsx`

**Interfaces:**
- Consumes: `Proposal.localGitDestination` (Task 2); `apiPost`, `errorMessage` (already imported in `ConsoleProvider`).
- Produces: `mergeProposal(proposalId: string): Promise<void>` on the console context; a `mergeProposal` prop on `ProposalPanel`.

- [ ] **Step 1: Add `mergeProposal` to the console controller**

In `apps/web/src/components/ConsoleProvider.tsx`, add after `updateProposalStatus` (mirroring its shape):

```ts
  async function mergeProposal(proposalId: string) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ proposal: Proposal; cascadeScheduled?: boolean }>(
        `/proposals/${proposalId}/merge`,
        {}
      );
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      showMessage("Proposal merged into the local repository — resolving gaps and re-indexing in the background.", "success");
      // Merged proposals drop out of the active list; pull fresh proposal/gap state.
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }
```

Add `mergeProposal` to the returned object (next to `updateProposalStatus`):

```ts
    updateProposalStatus,
    mergeProposal,
    publishProposal,
```

- [ ] **Step 2: Thread the prop through the page**

In `apps/web/src/app/proposals/page.tsx`, pull `mergeProposal` from `useConsole()` and pass it:

```tsx
export default function ProposalsPage() {
  const {
    loading,
    publishProposal,
    proposals,
    selectedProposal,
    setSelectedProposalId,
    updateProposalStatus,
    mergeProposal
  } = useConsole();

  return (
    <section className="fullWorkbench">
      <ProposalPanel
        loading={loading}
        publishProposal={publishProposal}
        proposals={proposals}
        selectedProposal={selectedProposal}
        setSelectedProposalId={setSelectedProposalId}
        updateProposalStatus={updateProposalStatus}
        mergeProposal={mergeProposal}
      />
    </section>
  );
}
```

- [ ] **Step 3: Switch the button in `ProposalsPanel`**

In `apps/web/src/components/ProposalsPanel.tsx`, add `mergeProposal` to the props type and destructuring:

```tsx
export function ProposalPanel({
  loading,
  publishProposal,
  proposals,
  selectedProposal,
  setSelectedProposalId,
  updateProposalStatus,
  mergeProposal
}: {
  loading: boolean;
  publishProposal: (proposalId: string) => Promise<void>;
  proposals: Proposal[];
  selectedProposal?: Proposal;
  setSelectedProposalId: (id: string) => void;
  updateProposalStatus: (proposalId: string, status: Proposal["status"]) => Promise<void>;
  mergeProposal: (proposalId: string) => Promise<void>;
}) {
```

Replace the existing "Mark Merged" `<button>` block with a local-git-aware split:

```tsx
                  {selectedProposal.localGitDestination ? (
                    <button
                      className="chip selected"
                      disabled={loading || selectedProposal.status !== "branch-pushed"}
                      onClick={() => void mergeProposal(selectedProposal.id)}
                      title="Merge this proposal's branch into the local repository's default branch, then resolve its gaps and re-index"
                      type="button"
                    >
                      Merge
                    </button>
                  ) : (
                    <button
                      className="chip selected"
                      disabled={loading || (selectedProposal.status !== "branch-pushed" && selectedProposal.status !== "pr-opened")}
                      onClick={() => void updateProposalStatus(selectedProposal.id, "merged")}
                      title="Mark the published PR as merged: resolves its gaps and re-indexes the knowledge base"
                      type="button"
                    >
                      Mark Merged
                    </button>
                  )}
```

- [ ] **Step 4: Typecheck, lint, build the web app**

Run: `npm run typecheck && npm run lint && npm run build -w apps/web`
Expected: no errors; web build succeeds (Turbopack bundles `@magpie/*` from source, so core's new field must be present — it is, from Task 2).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ProposalsPanel.tsx apps/web/src/components/ConsoleProvider.tsx apps/web/src/app/proposals/page.tsx
git commit -m "feat(web): Merge button for local-git proposals"
```

---

### Task 5: Full validation + PR

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: all workspaces build.

- [ ] **Step 2: Full test + typecheck + lint + deadcode**

Run: `npm test && npm run typecheck && npm run lint && npm run deadcode`
Expected: all pass. (`deadcode`/knip runs in STRICT mode — every new export must be used. `isLocalGitDestination`, `mergeLocalProposal`, `mergeLocalProposalBranch`, and `mergeProposal` are all consumed by routes/UI/tests, so none should trip knip; if one does, it means a wiring step was missed — fix the wiring, do not relax knip.)

- [ ] **Step 3: Push the branch**

```bash
git push -u origin claude/focused-wright-27f8e3
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --base main --title "Local-git proposal merge" --body "<summary + test evidence>"
```

The body should summarise the feature, link the spec and this plan, and note it is demo/local only.

---

## Self-Review

**Spec coverage:**
- Detection (`localGitDestination`) → Task 2 (core field + `isLocalGitDestination` + list/get). ✓
- Trigger / button hijack → Task 4. ✓
- `POST /:id/merge`, synchronous git merge, background cascade → Task 3 (+ service in Task 2). ✓
- Merge runs in the destination working tree (Option A) → Task 1 (`repoPath` = destination `file://` path). ✓
- Fail-safe on conflict (abort, keep status) → Task 1 (abort/throw) + Task 2 (`merge_conflict`, status unchanged). ✓
- Concurrency lock on the repo path → Task 1 (`withCheckoutLock`). ✓
- Scope boundaries (no new page/job/bulk; hosted untouched) → respected across tasks. ✓
- Docs (endpoint + demo note) → Task 3 (`docs/api.md`). The `run-magpie` demo-setup note is optional and can ride in the PR description; not a separate task.
- Testing (git happy/conflict; service happy/guards; detection) → Tasks 1–3. ✓

**Placeholder scan:** none — every code step shows full code; every command lists expected output.

**Type consistency:** `mergeLocalProposalBranch` request/result shapes match between Task 1 (definition), Task 2 (injected `merge` default + `fakeMerge` signature), and the git test. `MergeLocalProposalResult` codes (`proposal_not_mergeable` | `not_local_git_destination` | `merge_conflict`) match between Task 2 (service), Task 3 (route/docs), and the tests. `localGitDestination` is defined in Task 2 core and read in Task 4 UI.
