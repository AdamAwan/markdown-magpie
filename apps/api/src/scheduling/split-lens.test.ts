import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocumentSection, KnowledgeDocument, SplitDocumentJobInput } from "@magpie/core";
import type { AppContext } from "../context.js";
import { qualifiesForSplitScan, runSplitLens } from "./split-lens.js";

function fakeCtx(): AppContext {
  return {
    stores: {
      knowledgeIndex: {
        search: async () => [{ section: { path: "kb/ops.md" } as DocumentSection, relevance: 0.8 }],
        listDocuments: () => [{ path: "kb/ops.md", content: "# Ops" } as KnowledgeDocument]
      }
    }
  } as unknown as AppContext;
}

const broadContent = "# Broad\n\n" + ["A", "B", "C", "D", "E", "F"].map((h) => `## ${h}\nBody`).join("\n");

test("qualifiesForSplitScan requires a high size or section-breadth bar", () => {
  assert.equal(qualifiesForSplitScan("# Small\n\n## One\nFocused."), false);
  assert.equal(qualifiesForSplitScan(broadContent), true);
  assert.equal(qualifiesForSplitScan("# Long\n" + "x".repeat(15_001)), true);
});

test("runSplitLens enqueues split_document only for structurally broad documents", async () => {
  const calls: SplitDocumentJobInput[] = [];
  const enqueued = await runSplitLens(fakeCtx(), {
    flowId: "billing",
    documents: [
      { path: "kb/small.md", content: "# Small\n\n## One\nFocused.", repositoryId: "docs" },
      { path: "kb/broad.md", content: broadContent, repositoryId: "docs" }
    ],
    repositoryIds: ["docs"],
    splitDocument: async (_ctx, input) => calls.push(input)
  });
  assert.equal(enqueued, 1);
  assert.equal(calls[0].path, "kb/broad.md");
  assert.equal(calls[0].flowId, "billing");
  assert.equal(calls[0].destinationId, "docs");
  assert.deepEqual(calls[0].neighbours, [{ path: "kb/ops.md", content: "# Ops" }]);
});

test("runSplitLens keeps scanning when one enqueue fails", async () => {
  const calls: string[] = [];
  const enqueued = await runSplitLens(fakeCtx(), {
    flowId: undefined,
    documents: [
      { path: "kb/first.md", content: broadContent, repositoryId: "docs" },
      { path: "kb/second.md", content: broadContent, repositoryId: "docs" }
    ],
    repositoryIds: undefined,
    splitDocument: async (_ctx, input) => {
      if (input.path === "kb/first.md") throw new Error("enqueue boom");
      calls.push(input.path);
    }
  });
  assert.equal(enqueued, 1);
  assert.deepEqual(calls, ["kb/second.md"]);
});
