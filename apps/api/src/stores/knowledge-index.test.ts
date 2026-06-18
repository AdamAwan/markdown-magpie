import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingProvider } from "@magpie/core";
import { InMemoryKnowledgeIndex, type SectionVectorSearch } from "./knowledge-index.js";

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
});
