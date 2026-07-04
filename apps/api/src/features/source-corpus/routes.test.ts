import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceDataContext } from "@magpie/core";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through. These
// cover the read-only endpoint the watcher GETs to resolve a job's source corpus
// by content hash (#163 Part 2).

const CORPUS: SourceDataContext[] = [
  { sourceId: "s1", sourceName: "Billing", kind: "git", path: "refunds.ts", content: "partial refunds are supported" }
];

test("GET /api/source-corpus/:hash returns a previously stored corpus", async () => {
  const ctx = makeTestContext();
  await ctx.stores.sourceCorpus.save("hash-a", CORPUS);
  const app = buildApp(ctx);

  const res = await app.request("/api/source-corpus/hash-a");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { corpus: CORPUS });
});

test("GET /api/source-corpus/:hash returns 404 for an unknown hash", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/source-corpus/never-stored");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "source_corpus_not_found" });
});
