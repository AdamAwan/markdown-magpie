import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import * as patrol from "./service.js";

async function indexDocs(ctx: ReturnType<typeof makeTestContext>, paths: string[]): Promise<void> {
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: paths.map((path) => ({ path, content: `# ${path}` }))
  });
}

test("runFixPatrol checks a batch, stamps the cursor, and records a run", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md", "c.md"]);

  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.run.universeCount, 3);
  assert.equal(outcome.run.selectedCount, outcome.run.selected.length);
  assert.ok(outcome.run.selectedCount > 0 && outcome.run.selectedCount <= 3);

  // The selected docs are now stamped in the cursor.
  const cursor = await ctx.stores.patrol.listCursor(undefined);
  assert.deepEqual(cursor.map((e) => e.docPath).sort(), [...outcome.run.selected].sort());

  // It is the most recent run, fetchable by id.
  assert.equal((await patrol.listRuns(ctx, 10))[0].id, outcome.run.id);
  assert.equal((await patrol.getRun(ctx, outcome.run.id))?.id, outcome.run.id);
});

test("with a universe no larger than a batch, the cursor covers every document after one tick", async () => {
  const ctx = makeTestContext();
  await indexDocs(ctx, ["a.md", "b.md", "c.md", "d.md", "e.md"]);

  const first = await patrol.runFixPatrol(ctx, { trigger: "scheduled" });
  assert.ok(first.ok);
  assert.equal((await ctx.stores.patrol.listCursor(undefined)).length, 5);
});

test("an unknown flow is rejected without recording a run", async () => {
  const ctx = makeTestContext();
  const outcome = await patrol.runFixPatrol(ctx, { flowId: "ghost", trigger: "scheduled" });
  assert.deepEqual(outcome, { ok: false, code: "unknown_flow" });
  assert.deepEqual(await patrol.listRuns(ctx, 10), []);
});

test("an empty universe records a zero-selected run", async () => {
  const ctx = makeTestContext();
  const outcome = await patrol.runFixPatrol(ctx, { trigger: "scheduled" });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.run.universeCount, 0);
  assert.equal(outcome.run.selectedCount, 0);
});
