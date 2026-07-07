import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocumentSection, KnowledgeDocument } from "@magpie/core";
import type { AppContext } from "../context.js";
import { splitNeighbours } from "./split-neighbours.js";

function fakeCtx(opts: {
  ranked: Array<{ path: string; relevance: number }>;
  documents: Array<{ path: string; content: string }>;
}): AppContext {
  return {
    stores: {
      knowledgeIndex: {
        search: async () =>
          opts.ranked.map((r) => ({ section: { path: r.path } as DocumentSection, relevance: r.relevance })),
        listDocuments: () => opts.documents.map((d) => ({ path: d.path, content: d.content }) as KnowledgeDocument)
      }
    }
  } as unknown as AppContext;
}

const doc = { path: "kb/a.md", content: "# A" };

test("splitNeighbours keeps related docs above its looser threshold and excludes self", async () => {
  const ctx = fakeCtx({
    ranked: [
      { path: "kb/a.md", relevance: 0.99 },
      { path: "kb/ops.md", relevance: 0.56 },
      { path: "kb/low.md", relevance: 0.54 }
    ],
    documents: [
      { path: "kb/ops.md", content: "# Ops" },
      { path: "kb/low.md", content: "# Low" }
    ]
  });
  const neighbours = await splitNeighbours(ctx, doc, ["docs"]);
  assert.deepEqual(neighbours.map((n) => n.path), ["kb/ops.md"]);
  assert.deepEqual(neighbours, [{ path: "kb/ops.md", content: "# Ops" }]);
});

test("splitNeighbours caps the neighbour set at five documents", async () => {
  const ranked = Array.from({ length: 8 }, (_, i) => ({ path: `kb/n${i}.md`, relevance: 0.9 - i * 0.01 }));
  const ctx = fakeCtx({ ranked, documents: ranked.map((r) => ({ path: r.path, content: r.path })) });
  const neighbours = await splitNeighbours(ctx, doc, undefined);
  assert.equal(neighbours.length, 5);
  assert.deepEqual(neighbours.map((n) => n.path), ["kb/n0.md", "kb/n1.md", "kb/n2.md", "kb/n3.md", "kb/n4.md"]);
});

test("splitNeighbours returns an empty set when nothing clears the bar", async () => {
  const ctx = fakeCtx({
    ranked: [{ path: "kb/b.md", relevance: 0.4 }],
    documents: [{ path: "kb/b.md", content: "# B" }]
  });
  assert.deepEqual(await splitNeighbours(ctx, doc, undefined), []);
});

test("splitNeighbours folds multiple sections of one neighbour to its best score", async () => {
  const ctx = fakeCtx({
    ranked: [
      { path: "kb/b.md", relevance: 0.3 },
      { path: "kb/b.md", relevance: 0.8 }
    ],
    documents: [{ path: "kb/b.md", content: "# B" }]
  });
  assert.deepEqual(await splitNeighbours(ctx, doc, undefined), [{ path: "kb/b.md", content: "# B" }]);
});
