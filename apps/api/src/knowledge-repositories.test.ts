import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getConfiguredKnowledgeRepositories,
  resolveKnowledgeRepositorySelection
} from "./knowledge-repositories.js";

describe("knowledge repository configuration", () => {
  it("parses multiple configured knowledge repositories from JSON", () => {
    const repositories = getConfiguredKnowledgeRepositories({
      KNOWLEDGE_REPOSITORIES: JSON.stringify([
        { id: "cats", name: "Cats Knowledge Base", path: "knowledge-bases/cats" },
        { id: "docs", name: "Product Docs", path: "../product-docs" }
      ])
    });

    assert.deepEqual(repositories, [
      { id: "cats", name: "Cats Knowledge Base", path: "knowledge-bases/cats" },
      { id: "docs", name: "Product Docs", path: "../product-docs" }
    ]);
  });

  it("uses the legacy single path when no multi-repository config is present", () => {
    const repositories = getConfiguredKnowledgeRepositories({
      KNOWLEDGE_REPO_PATH: "knowledge-bases/cats"
    });

    assert.deepEqual(repositories, [
      { id: "cats", name: "cats", path: "knowledge-bases/cats" }
    ]);
  });

  it("resolves indexing by configured repository id", () => {
    const selection = resolveKnowledgeRepositorySelection(
      { repositoryId: "docs" },
      [
        { id: "cats", name: "Cats Knowledge Base", path: "knowledge-bases/cats" },
        { id: "docs", name: "Product Docs", path: "../product-docs" }
      ]
    );

    assert.deepEqual(selection, {
      localPath: "../product-docs",
      repositoryId: "docs",
      name: "Product Docs"
    });
  });

  it("rejects arbitrary local paths when repositories are configured", () => {
    assert.throws(
      () =>
        resolveKnowledgeRepositorySelection(
          { localPath: "/etc", repositoryId: "cats" },
          [{ id: "cats", name: "Cats Knowledge Base", path: "knowledge-bases/cats" }]
        ),
      /localPath is not accepted/
    );
  });

  it("keeps legacy local path indexing available when no repositories are configured", () => {
    const selection = resolveKnowledgeRepositorySelection(
      { localPath: "knowledge-bases/cats", repositoryId: "cats", name: "Cats Knowledge Base" },
      []
    );

    assert.deepEqual(selection, {
      localPath: "knowledge-bases/cats",
      repositoryId: "cats",
      name: "Cats Knowledge Base"
    });
  });
});
