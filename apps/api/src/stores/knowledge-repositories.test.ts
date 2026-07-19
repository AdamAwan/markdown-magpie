import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getConfiguredKnowledgeFlows,
  getConfiguredKnowledgeDestinations,
  getConfiguredKnowledgeRepositories,
  getConfiguredKnowledgeSources,
  getConfiguredRoleGrants,
  resolveConfiguredRepositorySelection,
  resolveKnowledgeRepositorySelection
} from "./knowledge-repositories.js";

describe("knowledge repository configuration", () => {
  it("parses multiple configured knowledge repositories from JSON", () => {
    const repositories = getConfiguredKnowledgeRepositories({
      KNOWLEDGE_REPOSITORIES: JSON.stringify([
        { id: "product", name: "Product Docs", path: "knowledge-bases/product" },
        { id: "support", name: "Support Docs", path: "../support-docs" }
      ])
    });

    assert.deepEqual(repositories, [
      { id: "product", name: "Product Docs", path: "knowledge-bases/product", kind: "local" },
      { id: "support", name: "Support Docs", path: "../support-docs", kind: "local" }
    ]);
  });

  it("parses git source and destination URLs from dedicated config", () => {
    const sources = getConfiguredKnowledgeSources({
      KNOWLEDGE_SOURCES: "https://github.com/danielearwicker/flowerbi.git"
    });
    const destinations = getConfiguredKnowledgeDestinations({
      KNOWLEDGE_DESTINATIONS: JSON.stringify([
        { id: "flowerbi-docs", url: "https://github.com/AdamAwan/flowerbi-doc-test.git", subpath: "docs" }
      ])
    });

    assert.deepEqual(sources, [
      {
        id: "flowerbi",
        name: "flowerbi",
        url: "https://github.com/danielearwicker/flowerbi.git",
        kind: "git"
      }
    ]);
    assert.deepEqual(destinations, [
      {
        id: "flowerbi-docs",
        name: "flowerbi-docs",
        url: "https://github.com/AdamAwan/flowerbi-doc-test.git",
        subpath: "docs",
        kind: "git"
      }
    ]);
  });

  it("parses a per-repository tokenEnv override on git repositories", () => {
    const sources = getConfiguredKnowledgeSources({
      KNOWLEDGE_SOURCES: JSON.stringify([
        { id: "acme", url: "https://github.com/acme/private.git", tokenEnv: "ACME_GITHUB_PAT" },
        // The tokenEnvVar alias is accepted too.
        { id: "beta", url: "https://github.com/beta/private.git", tokenEnvVar: "BETA_PAT" },
        // A plain source carries no tokenEnv.
        { id: "public", url: "https://github.com/public/repo.git" }
      ])
    });

    assert.deepEqual(sources, [
      {
        id: "acme",
        name: "acme",
        url: "https://github.com/acme/private.git",
        kind: "git",
        tokenEnv: "ACME_GITHUB_PAT"
      },
      { id: "beta", name: "beta", url: "https://github.com/beta/private.git", kind: "git", tokenEnv: "BETA_PAT" },
      { id: "public", name: "public", url: "https://github.com/public/repo.git", kind: "git" }
    ]);
  });

  it("ignores tokenEnv on non-git (local) repositories", () => {
    const sources = getConfiguredKnowledgeSources({
      KNOWLEDGE_SOURCES: JSON.stringify([{ id: "docs", path: "knowledge-bases/docs", tokenEnv: "IGNORED" }])
    });
    assert.deepEqual(sources, [{ id: "docs", name: "docs", path: "knowledge-bases/docs", kind: "local" }]);
  });

  it("allows multiple source kinds including agent knowledge and git subpaths", () => {
    const sources = getConfiguredKnowledgeSources({
      KNOWLEDGE_SOURCES: JSON.stringify([
        { id: "agent", kind: "agent" },
        { id: "code", url: "https://github.com/example/app.git", subpath: "src" },
        "internet"
      ])
    });

    assert.deepEqual(sources, [
      { id: "agent", name: "Agent Knowledge", kind: "agent" },
      {
        id: "code",
        name: "code",
        url: "https://github.com/example/app.git",
        subpath: "src",
        kind: "git"
      },
      { id: "internet", name: "internet", kind: "internet" }
    ]);
  });

  it("parses an internet source's fetch allowlist, normalizing and dropping junk (#242)", () => {
    const sources = getConfiguredKnowledgeSources({
      KNOWLEDGE_SOURCES: JSON.stringify([
        {
          id: "docs",
          kind: "internet",
          url: "https://docs.x.example/start",
          allowedHosts: ["Docs.X.Example.", " ", 7, "docs.x.example"]
        },
        { id: "ref", kind: "internet", url: "https://ref.example", allowedHosts: [] },
        { id: "plain", kind: "internet", url: "https://plain.example", allowedHosts: "docs.x.example" }
      ])
    });

    assert.deepEqual(sources, [
      {
        id: "docs",
        name: "docs",
        kind: "internet",
        url: "https://docs.x.example/start",
        allowedHosts: ["docs.x.example"]
      },
      // An empty list and a non-array both mean "not configured" — the source
      // stays a reference-only prompt note.
      { id: "ref", name: "ref", kind: "internet", url: "https://ref.example" },
      { id: "plain", name: "plain", kind: "internet", url: "https://plain.example" }
    ]);
  });

  it("parses flows linking source ids to destination ids", () => {
    const sources = getConfiguredKnowledgeSources({
      KNOWLEDGE_SOURCES: JSON.stringify([
        { id: "flowerbi", url: "https://github.com/example/source.git" },
        { id: "agent", kind: "agent" }
      ])
    });
    const destinations = getConfiguredKnowledgeDestinations({
      KNOWLEDGE_DESTINATIONS: JSON.stringify([{ id: "flowerbi-docs", url: "https://github.com/example/docs.git" }])
    });
    const flows = getConfiguredKnowledgeFlows(
      {
        KNOWLEDGE_FLOWS: JSON.stringify([
          {
            id: "flowerbi-flow",
            name: "FlowerBI Docs",
            sourceIds: ["flowerbi", "agent"],
            destinationId: "flowerbi-docs"
          }
        ])
      },
      sources,
      destinations
    );

    assert.deepEqual(flows, [
      {
        id: "flowerbi-flow",
        name: "FlowerBI Docs",
        sourceIds: ["flowerbi", "agent"],
        destinationId: "flowerbi-docs"
      }
    ]);
  });

  it("parses a flow persona from the persona or description field", () => {
    const sources = [{ id: "agent", name: "Agent Knowledge", kind: "agent" as const }];
    const destinations = [
      { id: "sec", name: "Security KB", url: "https://github.com/example/sec.git", kind: "git" as const },
      { id: "dev", name: "Dev KB", url: "https://github.com/example/dev.git", kind: "git" as const }
    ];
    const flows = getConfiguredKnowledgeFlows(
      {
        KNOWLEDGE_FLOWS: JSON.stringify([
          { id: "sec-flow", sourceIds: ["agent"], destinationId: "sec", persona: "Formal, high-level." },
          { id: "dev-flow", sourceIds: ["agent"], destinationId: "dev", description: "Factual, with code." }
        ])
      },
      sources,
      destinations
    );

    assert.equal(flows.find((flow) => flow.id === "sec-flow")?.persona, "Formal, high-level.");
    assert.equal(flows.find((flow) => flow.id === "dev-flow")?.persona, "Factual, with code.");
  });

  it("parses a flow routing summary from the routingSummary or summary field, separately from persona", () => {
    const sources = [{ id: "agent", name: "Agent Knowledge", kind: "agent" as const }];
    const destinations = [
      { id: "sec", name: "Security KB", url: "https://github.com/example/sec.git", kind: "git" as const },
      { id: "dev", name: "Dev KB", url: "https://github.com/example/dev.git", kind: "git" as const }
    ];
    const flows = getConfiguredKnowledgeFlows(
      {
        KNOWLEDGE_FLOWS: JSON.stringify([
          {
            id: "sec-flow",
            sourceIds: ["agent"],
            destinationId: "sec",
            persona: "Formal, high-level.",
            routingSummary: "Security, compliance, and access control."
          },
          { id: "dev-flow", sourceIds: ["agent"], destinationId: "dev", summary: "Deployments, CI, and rollbacks." }
        ])
      },
      sources,
      destinations
    );

    const sec = flows.find((flow) => flow.id === "sec-flow");
    assert.equal(sec?.routingSummary, "Security, compliance, and access control.");
    assert.equal(sec?.persona, "Formal, high-level.", "routing summary does not overwrite persona");
    assert.equal(flows.find((flow) => flow.id === "dev-flow")?.routingSummary, "Deployments, CI, and rollbacks.");
  });

  it("parses a flow charter, separately from persona and routing summary", () => {
    const sources = [{ id: "agent", name: "Agent Knowledge", kind: "agent" as const }];
    const destinations = [
      { id: "sec", name: "Security KB", url: "https://github.com/example/sec.git", kind: "git" as const },
      { id: "dev", name: "Dev KB", url: "https://github.com/example/dev.git", kind: "git" as const }
    ];
    const flows = getConfiguredKnowledgeFlows(
      {
        KNOWLEDGE_FLOWS: JSON.stringify([
          {
            id: "sec-flow",
            sourceIds: ["agent"],
            destinationId: "sec",
            persona: "Formal, high-level.",
            charter: "Cover everything an operator needs to run the service."
          },
          { id: "dev-flow", sourceIds: ["agent"], destinationId: "dev" }
        ])
      },
      sources,
      destinations
    );

    const sec = flows.find((flow) => flow.id === "sec-flow");
    assert.equal(sec?.charter, "Cover everything an operator needs to run the service.");
    assert.equal(sec?.persona, "Formal, high-level.", "charter does not overwrite persona");
    const dev = flows.find((flow) => flow.id === "dev-flow");
    assert.ok(dev && !("charter" in dev), "absent charter yields no key");
  });

  it("infers one flow per destination when flows are not configured", () => {
    const flows = getConfiguredKnowledgeFlows(
      {},
      [{ id: "agent", name: "Agent Knowledge", kind: "agent" }],
      [{ id: "docs", name: "Docs KB", url: "https://github.com/example/docs.git", kind: "git" }]
    );

    assert.deepEqual(flows, [
      {
        id: "docs",
        name: "Docs KB",
        sourceIds: ["agent"],
        destinationId: "docs"
      }
    ]);
  });

  it("accepts plain source and destination aliases", () => {
    assert.deepEqual(getConfiguredKnowledgeSources({ SOURCE: "agent" }), [
      { id: "agent", name: "Agent Knowledge", kind: "agent" }
    ]);
    assert.deepEqual(getConfiguredKnowledgeDestinations({ DESTINATION: "https://github.com/example/docs.git" }), [
      {
        id: "docs",
        name: "docs",
        url: "https://github.com/example/docs.git",
        kind: "git"
      }
    ]);
  });

  it("falls back to legacy repositories for both sources and destinations", () => {
    const env = {
      KNOWLEDGE_REPOSITORIES: JSON.stringify([{ id: "docs", name: "Product Docs", path: "knowledge-bases/product" }])
    };

    assert.deepEqual(getConfiguredKnowledgeSources(env), [
      { id: "docs", name: "Product Docs", path: "knowledge-bases/product", kind: "local" }
    ]);
    assert.deepEqual(getConfiguredKnowledgeDestinations(env), [
      { id: "docs", name: "Product Docs", path: "knowledge-bases/product", kind: "local" }
    ]);
  });

  it("uses the legacy single path when no multi-repository config is present", () => {
    const repositories = getConfiguredKnowledgeRepositories({
      KNOWLEDGE_REPO_PATH: "knowledge-bases/product"
    });

    assert.deepEqual(repositories, [
      { id: "product", name: "product", path: "knowledge-bases/product", kind: "local" }
    ]);
  });

  it("resolves indexing by configured repository id", () => {
    const selection = resolveKnowledgeRepositorySelection({ repositoryId: "docs" }, [
      { id: "product", name: "Product Docs", path: "knowledge-bases/product", kind: "local" },
      { id: "docs", name: "Reference Docs", path: "../product-docs", kind: "local" }
    ]);

    assert.deepEqual(selection, {
      localPath: "../product-docs",
      repositoryId: "docs",
      name: "Reference Docs"
    });
  });

  it("rejects arbitrary local paths when repositories are configured", () => {
    assert.throws(
      () =>
        resolveKnowledgeRepositorySelection({ localPath: "/etc", repositoryId: "product" }, [
          { id: "product", name: "Product Docs", path: "knowledge-bases/product", kind: "local" }
        ]),
      /localPath is not accepted/
    );
  });

  it("resolves configured git repositories by id without requiring a local path yet", () => {
    const selection = resolveConfiguredRepositorySelection({ repositoryId: "source" }, [
      { id: "source", name: "Source Repo", url: "https://github.com/example/source.git", kind: "git" }
    ]);

    assert.deepEqual(selection.repository, {
      id: "source",
      name: "Source Repo",
      url: "https://github.com/example/source.git",
      kind: "git"
    });
  });

  it("keeps legacy local path indexing available when no repositories are configured", () => {
    const selection = resolveKnowledgeRepositorySelection(
      { localPath: "knowledge-bases/product", repositoryId: "docs", name: "Product Docs" },
      []
    );

    assert.deepEqual(selection, {
      localPath: "knowledge-bases/product",
      repositoryId: "docs",
      name: "Product Docs"
    });
  });

  describe("getConfiguredRoleGrants", () => {
    it("returns an empty map when unset or blank (flow-scoping stays inactive)", () => {
      assert.deepEqual(getConfiguredRoleGrants({}), {});
      assert.deepEqual(getConfiguredRoleGrants({ KNOWLEDGE_ROLE_GRANTS: "   " }), {});
    });

    it("parses a role -> flow -> capabilities map", () => {
      const grants = getConfiguredRoleGrants({
        KNOWLEDGE_ROLE_GRANTS: JSON.stringify({
          "kb-hr-curators": { hr: ["read", "manage"] },
          "kb-askers-all": { "*": ["ask"] }
        })
      });
      assert.deepEqual(grants, {
        "kb-hr-curators": { hr: ["read", "manage"] },
        "kb-askers-all": { "*": ["ask"] }
      });
    });

    it("drops unknown capabilities, de-duplicates, and prunes empty entries", () => {
      const grants = getConfiguredRoleGrants({
        KNOWLEDGE_ROLE_GRANTS: JSON.stringify({
          "kb-hr": { hr: ["read", "read", "bogus", "manage"] },
          "kb-empty": { hr: ["nope"] },
          "kb-nonarray": { hr: "read" }
        })
      });
      assert.deepEqual(grants, { "kb-hr": { hr: ["read", "manage"] } });
    });

    it("returns an empty map for malformed JSON rather than throwing", () => {
      assert.deepEqual(getConfiguredRoleGrants({ KNOWLEDGE_ROLE_GRANTS: "{not json" }), {});
      assert.deepEqual(getConfiguredRoleGrants({ KNOWLEDGE_ROLE_GRANTS: "[1,2,3]" }), {});
    });
  });

  describe("file:// local-git destinations", () => {
    // A file:// destination is a LOCAL GIT repo (clone + push branches), so it must
    // normalize to kind "git" with a `url` no matter which field carries it — that
    // `url` is what the whole local-git flow mode keys off (isFileUrl).
    it("recognizes a file:// URL given in the url field", () => {
      const [destination] = getConfiguredKnowledgeDestinations({
        KNOWLEDGE_DESTINATIONS: JSON.stringify([{ id: "demo", name: "Demo", url: "file:///tmp/demo-repo" }])
      });
      assert.equal(destination.kind, "git");
      assert.equal(destination.url, "file:///tmp/demo-repo");
    });

    it("promotes a file:// value in the path field to a git url", () => {
      const [destination] = getConfiguredKnowledgeDestinations({
        KNOWLEDGE_DESTINATIONS: JSON.stringify([{ id: "demo", name: "Demo", path: "file:///tmp/demo-repo" }])
      });
      assert.equal(destination.kind, "git");
      assert.equal(destination.url, "file:///tmp/demo-repo");
      assert.equal(destination.path, undefined);
    });

    it("recognizes a bare file:// string destination", () => {
      const [destination] = getConfiguredKnowledgeDestinations({
        KNOWLEDGE_DESTINATIONS: JSON.stringify(["file:///tmp/demo-repo"])
      });
      assert.equal(destination.kind, "git");
      assert.equal(destination.url, "file:///tmp/demo-repo");
    });

    it("leaves a plain directory path as a non-git local destination", () => {
      const [destination] = getConfiguredKnowledgeDestinations({
        KNOWLEDGE_DESTINATIONS: JSON.stringify([{ id: "docs", name: "Docs", path: "knowledge-bases/product" }])
      });
      assert.equal(destination.kind, "local");
      assert.equal(destination.url, undefined);
      assert.equal(destination.path, "knowledge-bases/product");
    });
  });
});
