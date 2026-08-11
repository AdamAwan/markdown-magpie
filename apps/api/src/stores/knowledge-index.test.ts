import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { EmbeddingProvider } from "@magpie/core";
import { InMemoryKnowledgeIndex, type SectionKeywordSearch, type SectionVectorSearch } from "./knowledge-index.js";

const docs = [
  { path: "rollback.md", content: "# Hotfix Rollback\nRun the rollback workflow and notify the incident lead.\n" },
  { path: "felines.md", content: "# Grooming\nSticky residue is removed with oil before bathing.\n" }
];

async function seed(index: InMemoryKnowledgeIndex) {
  await index.indexMarkdownDocuments({ documents: docs, repositoryId: "repo" });
}

describe("InMemoryKnowledgeIndex.search", () => {
  it("returns keyword-ranked sections with a [0,1] relevance when no embeddings configured", async () => {
    const index = new InMemoryKnowledgeIndex();
    await seed(index);

    const ranked = await index.search("how do I rollback the hotfix", 5);

    assert.ok(ranked.length >= 1);
    assert.match(ranked[0].section.heading, /Rollback/);
    assert.ok(ranked[0].relevance > 0 && ranked[0].relevance <= 1);
  });

  it("surfaces a semantically-matched section that shares no keywords (hybrid)", async () => {
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts) {
        return texts.map(() => [1, 0, 0]);
      }
    };
    const vectorSearch: SectionVectorSearch = {
      async searchByEmbedding() {
        return [{ id: "repo:felines.md:0", similarity: 0.82 }];
      }
    };
    const index = new InMemoryKnowledgeIndex(undefined, { embeddingProvider, vectorSearch });
    await seed(index);

    const ranked = await index.search("what do I do about gum stuck in fur", 5);

    const top = ranked.find((r) => r.section.id === "repo:felines.md:0");
    assert.ok(top, "expected the vector hit to be present");
    assert.ok((top?.relevance ?? 0) >= 0.8);
  });

  it("scopes keyword results to the given repositoryIds", async () => {
    const index = new InMemoryKnowledgeIndex();
    await index.indexMarkdownDocuments({
      documents: [{ path: "rollback.md", content: "# Hotfix Rollback\nRun the rollback workflow.\n" }],
      repositoryId: "repoA"
    });
    await index.indexMarkdownDocuments({
      documents: [{ path: "rollback.md", content: "# Hotfix Rollback\nRun the rollback workflow.\n" }],
      repositoryId: "repoB"
    });

    const unscoped = await index.search("how do I rollback the hotfix", 5);
    assert.ok(unscoped.some((r) => r.section.id.startsWith("repoA:")));
    assert.ok(unscoped.some((r) => r.section.id.startsWith("repoB:")));

    const scoped = await index.search("how do I rollback the hotfix", 5, ["repoA"]);
    assert.ok(scoped.length >= 1);
    assert.ok(scoped.every((r) => r.section.id.startsWith("repoA:")));
  });

  it("scopes hybrid results, ignoring vector hits outside the repositoryIds", async () => {
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts) {
        return texts.map(() => [1, 0, 0]);
      }
    };
    // Stub returns a hit from repoB even though the search is scoped to repoA; the
    // post-fusion filter must drop it.
    const vectorSearch: SectionVectorSearch = {
      async searchByEmbedding() {
        return [{ id: "repoB:rollback.md:0", similarity: 0.95 }];
      }
    };
    const index = new InMemoryKnowledgeIndex(undefined, { embeddingProvider, vectorSearch });
    await index.indexMarkdownDocuments({
      documents: [{ path: "rollback.md", content: "# Hotfix Rollback\nRun the rollback workflow.\n" }],
      repositoryId: "repoA"
    });
    await index.indexMarkdownDocuments({
      documents: [{ path: "rollback.md", content: "# Hotfix Rollback\nRun the rollback workflow.\n" }],
      repositoryId: "repoB"
    });

    const scoped = await index.search("how do I rollback the hotfix", 5, ["repoA"]);
    assert.ok(scoped.every((r) => r.section.id.startsWith("repoA:")));
  });

  it("prunes documents removed from the source set on re-index", async () => {
    const index = new InMemoryKnowledgeIndex();
    await index.indexMarkdownDocuments({
      documents: [
        { path: "keep.md", content: "# Keep\nThis rollback doc survives the re-index.\n" },
        { path: "gone.md", content: "# Gone\nThis rollback doc is removed at the source.\n" }
      ],
      repositoryId: "repo"
    });

    // Re-index with "gone.md" absent from the set.
    await index.indexMarkdownDocuments({
      documents: [{ path: "keep.md", content: "# Keep\nThis rollback doc survives the re-index.\n" }],
      repositoryId: "repo"
    });

    const paths = index.listDocuments().map((document) => document.path);
    assert.deepEqual(paths, ["keep.md"]);

    const ranked = await index.search("rollback", 5);
    assert.ok(ranked.every((result) => !result.section.id.startsWith("repo:gone.md")));
  });

  it("uses the injected keyword search backend when provided", async () => {
    const calls: Array<{ query: string; limit: number; repositoryIds?: string[] }> = [];
    const keywordSearch: SectionKeywordSearch = {
      async searchByKeyword(query, limit, repositoryIds) {
        calls.push({ query, limit, repositoryIds });
        // Return the felines section, which shares no keywords with the question,
        // proving the in-memory scan was bypassed in favour of the backend.
        return [{ id: "repo:felines.md:0", relevance: 0.9 }];
      }
    };
    const index = new InMemoryKnowledgeIndex(undefined, { keywordSearch });
    await seed(index);

    const ranked = await index.search("how do I rollback the hotfix", 5);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].query, "how do I rollback the hotfix");
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].section.id, "repo:felines.md:0");
    assert.equal(ranked[0].relevance, 0.9);
  });

  it("passes the repository scope through to the keyword search backend", async () => {
    let received: string[] | undefined;
    const keywordSearch: SectionKeywordSearch = {
      async searchByKeyword(_query, _limit, repositoryIds) {
        received = repositoryIds;
        return [];
      }
    };
    const index = new InMemoryKnowledgeIndex(undefined, { keywordSearch });
    await seed(index);

    await index.search("rollback", 5, ["repo"]);
    assert.deepEqual(received, ["repo"]);
  });

  it("falls back to the in-memory scan when the keyword search backend throws", async () => {
    const notices: string[] = [];
    const keywordSearch: SectionKeywordSearch = {
      async searchByKeyword() {
        throw new Error("fts backend down");
      }
    };
    const index = new InMemoryKnowledgeIndex(undefined, {
      keywordSearch,
      onNotice: (message) => notices.push(message)
    });
    await seed(index);

    const ranked = await index.search("how do I rollback the hotfix", 5);

    assert.match(ranked[0].section.heading, /Rollback/);
    assert.ok(notices.some((n) => /falling back to in-memory/i.test(n)));
  });

  it("falls back to keyword search when the embedding call fails", async () => {
    const embeddingProvider: EmbeddingProvider = {
      async embed() {
        throw new Error("embeddings endpoint down");
      }
    };
    const vectorSearch: SectionVectorSearch = {
      async searchByEmbedding() {
        return [];
      }
    };
    const notices: string[] = [];
    const index = new InMemoryKnowledgeIndex(undefined, {
      embeddingProvider,
      vectorSearch,
      onNotice: (message) => notices.push(message)
    });
    await seed(index);

    const ranked = await index.search("how do I rollback the hotfix", 5);

    assert.match(ranked[0].section.heading, /Rollback/);
    assert.ok(notices.some((n) => /fall(ing)? back to keyword/i.test(n)));
  });

  it("embeds a repeated query only once, serving the rest from the cache", async () => {
    const embedded: string[][] = [];
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts) {
        embedded.push(texts);
        return texts.map(() => [1, 0, 0]);
      }
    };
    const vectorSearch: SectionVectorSearch = {
      async searchByEmbedding() {
        return [{ id: "repo:felines.md:0", similarity: 0.82 }];
      }
    };
    const index = new InMemoryKnowledgeIndex(undefined, { embeddingProvider, vectorSearch });
    await seed(index);

    await index.search("gum stuck in fur", 5);
    // Byte-identical and whitespace-variant repeats must not re-embed.
    await index.search("gum stuck in fur", 5);
    await index.search("  gum   stuck in fur  ", 5);

    assert.equal(embedded.length, 1, "only the first distinct query hits the provider");
    assert.deepEqual(embedded[0], ["gum stuck in fur"]);
  });

  it("does not cache a failed embedding, retrying the provider on the next search", async () => {
    let calls = 0;
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts) {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient embeddings outage");
        }
        return texts.map(() => [1, 0, 0]);
      }
    };
    const vectorSearch: SectionVectorSearch = {
      async searchByEmbedding() {
        return [{ id: "repo:felines.md:0", similarity: 0.82 }];
      }
    };
    const index = new InMemoryKnowledgeIndex(undefined, { embeddingProvider, vectorSearch });
    await seed(index);

    // First call fails inside embed -> falls back to keyword, nothing cached.
    await index.search("gum stuck in fur", 5);
    // Second call must reach the provider again (a cached failure would skip it).
    const ranked = await index.search("gum stuck in fur", 5);

    assert.equal(calls, 2);
    assert.ok(ranked.some((r) => r.section.id === "repo:felines.md:0"));
  });

  it("in-memory keyword ranking scores heading path and file path", async () => {
    const index = new InMemoryKnowledgeIndex();
    await index.indexMarkdownDocuments({
      repositoryId: "repo",
      documents: [
        { path: "billing/refunds.md", content: "# Billing\n\n## Annual plans\n\nCredit is issued pro rata.\n" },
        { path: "other/notes.md", content: "# Other\n\n## Notes\n\nUnrelated prose about credit.\n" }
      ]
    });

    // "refunds" occurs only in the first document's file path. That document's
    // "# Billing" / "## Annual plans" headings split into two sections (one per
    // heading), and both inherit the same document path, so both score on this
    // path-only term — the assertion is on section count from the *correct*
    // document, not on there being a single matching section.
    const byPath = await index.search("refunds", 5, ["repo"]);
    assert.equal(byPath.length, 2);
    assert.equal(byPath[0].section.path, "billing/refunds.md");

    // "billing" occurs only in the first document's heading path (its own heading,
    // for the "Billing" section, and an ancestor heading, for the "Annual plans"
    // section) — again both of that document's sections score, none of the other.
    const byHeadingPath = await index.search("billing", 5, ["repo"]);
    assert.equal(byHeadingPath.length, 2);
    assert.equal(byHeadingPath[0].section.path, "billing/refunds.md");
  });
});

// The in-memory keyword leg is the documented fallback for no-persistence mode
// AND for a Postgres keyword-search error (see keywordRank), but the golden eval
// only ever exercises the SQL leg — it boots a real pgvector container. These
// tests pin the in-memory relevances either side of the retrieval floor
// (MIN_RELEVANCE = 0.4 in features/retrieve/service.ts) so the two legs'
// disagreement is visible in code and any change to KEYWORD_RELEVANCE_SCALE or
// to the field weights breaks a test instead of silently moving the cut line.
//
// The scoring function is: per unique query term (lowercased, /[a-z0-9]{3,}/,
// stopwords dropped), add 10 if it occurs in the heading, 6 in the heading path,
// 6 in the flattened file path, 3 in the content; relevance =
// min(1, score / KEYWORD_RELEVANCE_SCALE) with KEYWORD_RELEVANCE_SCALE = 26.
// Note the markdown parser keeps the heading line inside the section's content
// and puts the section's own heading in its heading path, so a heading term
// scores on all three of heading + heading path + content.
describe("InMemoryKnowledgeIndex in-memory keyword relevance vs the retrieval floor", () => {
  const floorDoc = {
    path: "notes.md",
    content: "# Overview\n\nCanary rollout stages proceed gradual by design.\n"
  };

  async function relevanceFor(question: string): Promise<number> {
    const index = new InMemoryKnowledgeIndex();
    await index.indexMarkdownDocuments({ documents: [floorDoc], repositoryId: "repo" });
    const ranked = await index.search(question, 5, ["repo"]);
    assert.equal(ranked.length, 1, "expected exactly the one indexed section to match");
    return ranked[0].relevance;
  }

  it("scores three body-only terms below the 0.4 floor — where the SQL leg keeps them", async () => {
    // "canary", "rollout", "stages" occur only in the body (the heading is
    // "Overview" and the path flattens to "notes md"), so the score is
    // 3 terms x CONTENT_WEIGHT 3 = 9, and 9 / 26 = 0.34615384615384615.
    const relevance = await relevanceFor("canary rollout stages");
    assert.equal(relevance, 9 / 26);
    assert.ok(relevance < 0.4, `expected ${relevance} to be dropped by the 0.4 floor`);
    // The same three body-only lexemes on the SQL leg score raw 3 x 0.3 = 0.9,
    // which ts_rank_cd(..., 32) normalises to 0.9 / 1.9 ~= 0.474 — above the
    // floor. The floor was derived against the SQL leg only; this is the known
    // divergence, recorded rather than fixed (fixing it needs measurement).
    assert.ok(0.9 / 1.9 > 0.4);
  });

  it("scores four body-only terms above the floor", async () => {
    // "canary", "rollout", "stages", "gradual": 4 x 3 = 12, and
    // 12 / 26 = 0.46153846153846156.
    const relevance = await relevanceFor("canary rollout stages gradual");
    assert.equal(relevance, 12 / 26);
    assert.ok(relevance >= 0.4);
  });

  it("scores a single heading term well above the floor", async () => {
    // "overview" is the section's heading, is therefore also in its heading path,
    // and the parser keeps the "# Overview" line in the section content:
    // 10 + 6 + 3 = 19, and 19 / 26 = 0.7307692307692307.
    const relevance = await relevanceFor("overview");
    assert.equal(relevance, 19 / 26);
    assert.ok(relevance >= 0.4);
  });

  it("scores a single body-only term far below the floor", async () => {
    // One body term: 1 x 3 = 3, and 3 / 26 = 0.11538461538461539.
    const relevance = await relevanceFor("canary");
    assert.equal(relevance, 3 / 26);
    assert.ok(relevance < 0.4);
  });
});

describe("InMemoryKnowledgeIndex.getSection", () => {
  it("returns an indexed section by id and undefined for unknown ids", async () => {
    const index = new InMemoryKnowledgeIndex();
    await seed(index);

    const [ranked] = await index.search("rollback the hotfix", 1);
    assert.ok(ranked, "expected the indexed section to be searchable");

    const section = index.getSection(ranked.section.id);
    assert.deepEqual(section, ranked.section);
    assert.equal(index.getSection("nope"), undefined);
  });
});

describe("InMemoryKnowledgeIndex.indexLocalRepository", () => {
  it("indexes many files concurrently while keeping document order deterministic", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magpie-knowledge-index-"));
    try {
      // More files than the internal read concurrency pool, so this exercises
      // multiple chunks of the bounded-concurrency read loop.
      const fileCount = 30;
      const expectedPaths: string[] = [];
      for (let i = 0; i < fileCount; i += 1) {
        const name = `doc-${String(i).padStart(2, "0")}.md`;
        await writeFile(path.join(dir, name), `# Doc ${i}\nContent for document ${i}.\n`);
        expectedPaths.push(name);
      }

      const index = new InMemoryKnowledgeIndex();
      const summary = await index.indexLocalRepository({ localPath: dir, repositoryId: "many-files" });

      assert.equal(summary.documentCount, fileCount);
      const paths = index.listDocuments().map((document) => document.path);
      assert.deepEqual([...paths].sort(), expectedPaths);

      // listDocuments() sorts by path itself; check insertion produced exactly
      // one document per file with no duplication/loss from the concurrent reads.
      assert.equal(new Set(paths).size, fileCount);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a markdown file that exceeds the max indexing size", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magpie-knowledge-index-"));
    try {
      await writeFile(path.join(dir, "normal.md"), "# Normal\nThis file is indexed.\n");
      // 6 MB of content, above the 5 MB guard.
      const oversizedContent = `# Huge\n${"x".repeat(6 * 1024 * 1024)}\n`;
      await writeFile(path.join(dir, "huge.md"), oversizedContent);

      const index = new InMemoryKnowledgeIndex();
      const summary = await index.indexLocalRepository({ localPath: dir, repositoryId: "with-huge-file" });

      assert.equal(summary.documentCount, 1);
      const paths = index.listDocuments().map((document) => document.path);
      assert.deepEqual(paths, ["normal.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
