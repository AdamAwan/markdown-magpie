import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocumentSection, KnowledgeDocument } from "@magpie/core";
import type { AppContext } from "../context.js";
import { dedupeNeighbours } from "./dedupe-neighbours.js";

// A ctx exposing only what dedupeNeighbours touches: the index's search() (ranked
// sections) and listDocuments() (path → full content). search() ignores the query;
// the test controls the ranked set directly so the threshold/cap can be asserted.
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

test("returns above-threshold neighbours with their content, excluding the doc itself", async () => {
  const ctx = fakeCtx({
    ranked: [
      { path: "kb/a.md", relevance: 0.99 }, // self — excluded
      { path: "kb/b.md", relevance: 0.9 },
      { path: "kb/c.md", relevance: 0.8 }
    ],
    documents: [
      { path: "kb/b.md", content: "# B" },
      { path: "kb/c.md", content: "# C" }
    ]
  });
  const neighbours = await dedupeNeighbours(ctx, doc, ["docs"]);
  assert.deepEqual(neighbours, [
    { path: "kb/b.md", content: "# B" },
    { path: "kb/c.md", content: "# C" }
  ]);
});

test("drops neighbours below the similarity threshold", async () => {
  const ctx = fakeCtx({
    ranked: [
      { path: "kb/b.md", relevance: 0.76 },
      { path: "kb/d.md", relevance: 0.5 }
    ],
    documents: [
      { path: "kb/b.md", content: "# B" },
      { path: "kb/d.md", content: "# D" }
    ]
  });
  const neighbours = await dedupeNeighbours(ctx, doc, undefined);
  assert.deepEqual(neighbours, [{ path: "kb/b.md", content: "# B" }]);
});

test("caps the neighbour set at the hard ceiling", async () => {
  const ranked = Array.from({ length: 8 }, (_, i) => ({ path: `kb/n${i}.md`, relevance: 0.95 - i * 0.01 }));
  const ctx = fakeCtx({
    ranked,
    documents: ranked.map((r) => ({ path: r.path, content: r.path }))
  });
  const neighbours = await dedupeNeighbours(ctx, doc, undefined);
  assert.equal(neighbours.length, 5);
  assert.deepEqual(
    neighbours.map((n) => n.path),
    ["kb/n0.md", "kb/n1.md", "kb/n2.md", "kb/n3.md", "kb/n4.md"]
  );
});

test("returns an empty set when nothing clears the bar", async () => {
  const ctx = fakeCtx({
    ranked: [{ path: "kb/b.md", relevance: 0.4 }],
    documents: [{ path: "kb/b.md", content: "# B" }]
  });
  assert.deepEqual(await dedupeNeighbours(ctx, doc, undefined), []);
});

test("folds multiple sections of one neighbour to its best score", async () => {
  const ctx = fakeCtx({
    ranked: [
      { path: "kb/b.md", relevance: 0.6 },
      { path: "kb/b.md", relevance: 0.9 }
    ],
    documents: [{ path: "kb/b.md", content: "# B" }]
  });
  const neighbours = await dedupeNeighbours(ctx, doc, undefined);
  assert.deepEqual(neighbours, [{ path: "kb/b.md", content: "# B" }]);
});
