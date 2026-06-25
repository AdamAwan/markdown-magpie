import { test } from "node:test";
import assert from "node:assert/strict";
import type { DedupeDocumentsJobInput, DocumentSection, KnowledgeDocument } from "@magpie/core";
import type { AppContext } from "../context.js";
import { runDedupeLens } from "./dedupe-lens.js";

// Fake index: search() returns a neighbour only for the document whose content names
// it, so one doc has a neighbour and another is isolated. listDocuments() supplies the
// neighbour's full content.
function fakeCtx(): AppContext {
  return {
    stores: {
      knowledgeIndex: {
        search: async (query: string) =>
          query.includes("has-neighbour")
            ? [{ section: { path: "kb/b.md" } as DocumentSection, relevance: 0.9 }]
            : [],
        listDocuments: () => [{ path: "kb/b.md", content: "# B" } as KnowledgeDocument]
      }
    }
  } as unknown as AppContext;
}

test("enqueues a dedupe job per doc with neighbours, skips isolated docs", async () => {
  const ctx = fakeCtx();
  const calls: DedupeDocumentsJobInput[] = [];
  const dedupeDocument = async (_ctx: AppContext, input: DedupeDocumentsJobInput) => {
    calls.push(input);
  };

  const enqueued = await runDedupeLens(ctx, {
    flowId: "billing",
    documents: [
      { path: "kb/a.md", content: "# A has-neighbour", repositoryId: "docs" },
      { path: "kb/iso.md", content: "# isolated", repositoryId: "docs" }
    ],
    repositoryIds: ["docs"],
    dedupeDocument
  });

  assert.equal(enqueued, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "kb/a.md");
  assert.deepEqual(calls[0].neighbours, [{ path: "kb/b.md", content: "# B" }]);
  assert.equal(calls[0].destinationId, "docs");
  assert.equal(calls[0].flowId, "billing");
});

test("a failing enqueue for one doc does not abort the tick", async () => {
  const ctx = fakeCtx();
  let secondTried = false;
  const dedupeDocument = async (_ctx: AppContext, input: DedupeDocumentsJobInput) => {
    if (input.path === "kb/a.md") throw new Error("enqueue boom");
    secondTried = true;
  };

  const enqueued = await runDedupeLens(ctx, {
    flowId: undefined,
    documents: [
      { path: "kb/a.md", content: "# A has-neighbour", repositoryId: "docs" },
      { path: "kb/c.md", content: "# C has-neighbour", repositoryId: "docs" }
    ],
    repositoryIds: ["docs"],
    dedupeDocument
  });

  // a.md threw; c.md still ran. Only the successful enqueue is counted.
  assert.equal(secondTried, true);
  assert.equal(enqueued, 1);
});
