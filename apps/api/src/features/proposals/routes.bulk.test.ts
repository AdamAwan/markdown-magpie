import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { proposalRoutes } from "./routes.js";

const execFileAsync = promisify(execFile);

// POST /proposals/bulk applies one action across many ids with per-id outcomes:
// a bad id (unknown, cross-flow, wrong status, PR-tracked) is reported for that
// id and never fails the rest of the batch. The per-action effects reuse the
// same service functions as the single-item routes, so these tests focus on the
// envelope, the per-id guards, and cascade idempotency.

function principal(roles?: string[]): Principal {
  return { subject: "auth0|tester", scopes: ["read:knowledge", "manage:knowledge"], roles, payload: {} };
}

function appFor(ctx: AppContext, who: Principal = principal()): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", who);
    await next();
  });
  app.route("/proposals", proposalRoutes(ctx));
  app.onError(onError);
  return app;
}

interface BulkResult {
  id: string;
  ok: boolean;
  code?: string;
  proposal?: { id: string; status: string };
  job?: { id: string; type: string };
}

async function postBulk(app: Hono, action: string, ids: string[]): Promise<{ status: number; results: BulkResult[] }> {
  const res = await app.request("/proposals/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ids })
  });
  const body = res.status === 200 ? ((await res.json()) as { results: BulkResult[] }) : { results: [] };
  return { status: res.status, results: body.results };
}

async function seedDraft(ctx: AppContext, title: string, flowId?: string): Promise<string> {
  const created = await ctx.stores.proposals.create({
    title,
    targetPath: `${title.toLowerCase().replace(/ /g, "-")}.md`,
    markdown: `# ${title}\nbody`,
    rationale: "r",
    evidence: [],
    flowId
  });
  return created.id;
}

// A branch-pushed proposal without a pull request URL — the manual "mark
// merged" case. The triggering question gives the merge cascade a gap to
// verify, so cascade idempotency is observable via verify_gap_closure jobs.
async function seedBranchPushedWithGap(ctx: AppContext): Promise<string> {
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const created = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: [log.id]
  });
  await ctx.stores.proposals.recordPublication(created.id, {
    provider: "local-git",
    branchName: "magpie/proposal-configure-x",
    commitSha: "deadbeef",
    publishedAt: new Date().toISOString()
  });
  return created.id;
}

// Mirrors service.test.ts's seedGitRepository: an indexed local repo the
// publish pre-flight validation resolves against, so a bulk publish can
// actually enqueue.
async function seedGitRepository(ctx: AppContext): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-bulk-test-"));
  const remotePath = path.join(root, "remote.git");
  const clonePath = path.join(root, "clone");
  await mkdir(remotePath, { recursive: true });
  const run = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });
  await run(remotePath, ["init", "--bare", "--initial-branch=main"]);
  await execFileAsync("git", ["clone", remotePath, clonePath]);
  await run(clonePath, ["config", "user.name", "Seed"]);
  await run(clonePath, ["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(clonePath, "README.md"), "# seed\n", "utf8");
  await run(clonePath, ["add", "-A"]);
  await run(clonePath, ["commit", "-m", "seed"]);
  await run(clonePath, ["push", "-u", "origin", "main"]);
  await ctx.stores.knowledgeIndex.indexLocalRepository({
    localPath: clonePath,
    repositoryId: "test-repo",
    name: "test-repo"
  });
}

describe("POST /proposals/bulk validation", () => {
  it("400s an empty id list", async () => {
    const { status } = await postBulk(appFor(makeTestContext()), "ready", []);
    assert.equal(status, 400);
  });

  it("400s an unknown action", async () => {
    const ctx = makeTestContext();
    const id = await seedDraft(ctx, "A");
    const { status } = await postBulk(appFor(ctx), "supersede", [id]);
    assert.equal(status, 400);
  });

  it("400s a batch over 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const { status } = await postBulk(appFor(makeTestContext()), "ready", ids);
    assert.equal(status, 400);
  });
});

describe("POST /proposals/bulk action=ready", () => {
  it("marks drafts ready and reports non-drafts per id without failing the batch", async () => {
    const ctx = makeTestContext();
    const draftA = await seedDraft(ctx, "A");
    const draftB = await seedDraft(ctx, "B");
    const alreadyReady = await seedDraft(ctx, "C");
    await ctx.stores.proposals.updateStatus(alreadyReady, "ready");

    const { status, results } = await postBulk(appFor(ctx), "ready", [draftA, "nope", alreadyReady, draftB]);
    assert.equal(status, 200);
    assert.deepEqual(
      results.map((r) => ({ id: r.id, ok: r.ok, code: r.code })),
      [
        { id: draftA, ok: true, code: undefined },
        { id: "nope", ok: false, code: "proposal_not_found" },
        { id: alreadyReady, ok: false, code: "invalid_status" },
        { id: draftB, ok: true, code: undefined }
      ]
    );
    assert.equal((await ctx.stores.proposals.get(draftA))?.status, "ready");
    assert.equal((await ctx.stores.proposals.get(draftB))?.status, "ready");
  });
});

describe("POST /proposals/bulk action=publish", () => {
  it("enqueues a publish job per ready proposal and skips drafts", async () => {
    const ctx = makeTestContext();
    await seedGitRepository(ctx);
    const ready = await seedDraft(ctx, "Ready one");
    await ctx.stores.proposals.updateStatus(ready, "ready");
    const draft = await seedDraft(ctx, "Still draft");

    const { status, results } = await postBulk(appFor(ctx), "publish", [ready, draft]);
    assert.equal(status, 200);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].job?.type, "publish_proposal");
    assert.deepEqual(results[1], { id: draft, ok: false, code: "invalid_status" });

    const { jobs } = await ctx.jobs.list({ type: "publish_proposal" });
    assert.equal(jobs.length, 1, "exactly one publish job for the one ready proposal");
  });
});

describe("POST /proposals/bulk action=merge", () => {
  it("merges branch-pushed no-PR proposals, skips PR-tracked ones, and never re-runs the cascade", async () => {
    const ctx = makeTestContext();
    const manual = await seedBranchPushedWithGap(ctx);
    const prTracked = await seedDraft(ctx, "PR tracked");
    await ctx.stores.proposals.recordPublication(prTracked, {
      provider: "local-git",
      branchName: "magpie/proposal-pr",
      commitSha: "cafef00d",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date().toISOString()
    });
    const app = appFor(ctx);

    const first = await postBulk(app, "merge", [manual, prTracked]);
    assert.equal(first.status, 200);
    assert.deepEqual(
      first.results.map((r) => ({ id: r.id, ok: r.ok, code: r.code })),
      [
        { id: manual, ok: true, code: undefined },
        { id: prTracked, ok: false, code: "proposal_merge_tracked_by_pull_request" }
      ]
    );
    assert.equal((await ctx.stores.proposals.get(manual))?.status, "merged");
    await ctx.background.whenIdle();
    const afterFirst = await ctx.jobs.list({ type: "verify_gap_closure" });
    assert.equal(afterFirst.jobs.length, 1, "the merge enqueues exactly one verification job");

    // A retried bulk merge of the (now merged) id reports invalid_status and
    // must not schedule the cascade — and so verify_gap_closure — again.
    const second = await postBulk(app, "merge", [manual]);
    assert.deepEqual(second.results, [{ id: manual, ok: false, code: "invalid_status" }]);
    await ctx.background.whenIdle();
    const afterSecond = await ctx.jobs.list({ type: "verify_gap_closure" });
    assert.equal(afterSecond.jobs.length, 1, "the re-run does not enqueue a second verification job");
  });
});

describe("POST /proposals/bulk action=reject", () => {
  it("rejects drafts and reports branch-pushed hosted proposals as invalid", async () => {
    const ctx = makeTestContext();
    const draft = await seedDraft(ctx, "Reject me");
    const pushed = await seedBranchPushedWithGap(ctx);

    const { results } = await postBulk(appFor(ctx), "reject", [draft, pushed]);
    assert.deepEqual(
      results.map((r) => ({ id: r.id, ok: r.ok, code: r.code })),
      [
        { id: draft, ok: true, code: undefined },
        // No destinations configured, so this is the hosted (GitHub) path where
        // only drafts are rejectable — bin is the local-git counterpart.
        { id: pushed, ok: false, code: "invalid_status" }
      ]
    );
    assert.equal((await ctx.stores.proposals.get(draft))?.status, "rejected");
    assert.equal((await ctx.stores.proposals.get(pushed))?.status, "branch-pushed");
  });
});

describe("POST /proposals/bulk flow scoping", () => {
  it("masks unreadable cross-flow ids as not-found and manage-denied ids as forbidden", async () => {
    const ctx = makeTestContext();
    ctx.knowledgeConfig.roleGrants = {
      "kb-hr-curators": { hr: ["read", "manage"], eng: ["read"] }
    };
    const hr = await seedDraft(ctx, "HR draft", "hr");
    const eng = await seedDraft(ctx, "Eng draft", "eng");
    const finance = await seedDraft(ctx, "Finance draft", "finance");

    const { results } = await postBulk(appFor(ctx, principal(["kb-hr-curators"])), "ready", [hr, eng, finance]);
    assert.deepEqual(
      results.map((r) => ({ id: r.id, ok: r.ok, code: r.code })),
      [
        { id: hr, ok: true, code: undefined },
        { id: eng, ok: false, code: "forbidden" },
        { id: finance, ok: false, code: "proposal_not_found" }
      ]
    );
    assert.equal((await ctx.stores.proposals.get(hr))?.status, "ready");
    assert.equal((await ctx.stores.proposals.get(eng))?.status, "draft");
  });
});
