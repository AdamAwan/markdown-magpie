import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DocumentSection, KnowledgeDocument } from "@magpie/core";
import {
  InMemoryKnowledgeIndex,
  type IncrementalIndexInput,
  type IndexedRepositorySummary,
  type KnowledgePersistence,
  type LoadedKnowledge
} from "./knowledge-index.js";
import { KeyedMutex } from "./keyed-mutex.js";

// Re-index consistency (docs/ingestion.md IN26–IN28): persist before swapping
// memory, one re-index per repository at a time, and a hydrate that is retried
// rather than left empty.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const emptyKnowledge: LoadedKnowledge = { repositories: [], documents: [], sections: [] };

// A scriptable persistence: every hook defaults to a no-op success.
class FakePersistence implements KnowledgePersistence {
  saves: IndexedRepositorySummary[] = [];
  onSave: (summary: IndexedRepositorySummary) => Promise<void> = async () => undefined;
  onLoad: () => Promise<LoadedKnowledge> = async () => emptyKnowledge;

  async saveIndexedRepository(
    summary: IndexedRepositorySummary,
    _documents: KnowledgeDocument[],
    _sections: DocumentSection[]
  ): Promise<void> {
    await this.onSave(summary);
    this.saves.push(summary);
  }
  async applyIncrementalIndex(_input: IncrementalIndexInput): Promise<void> {}
  async loadAll(): Promise<LoadedKnowledge> {
    return this.onLoad();
  }
  async reset(): Promise<void> {}
}

async function withRepository(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "magpie-index-consistency-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content);
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("InMemoryKnowledgeIndex re-index consistency", () => {
  it("keeps serving the prior corpus when persisting a re-index fails", async () => {
    await withRepository({ "a.md": "# Alpha\nOriginal alpha.\n" }, async (dir) => {
      const persistence = new FakePersistence();
      const index = new InMemoryKnowledgeIndex(persistence);
      await index.indexLocalRepository({ localPath: dir, repositoryId: "repo" });

      await writeFile(path.join(dir, "a.md"), "# Alpha\nRewritten alpha.\n");
      await writeFile(path.join(dir, "b.md"), "# Beta\nNew beta.\n");
      persistence.onSave = async () => {
        throw new Error("connection terminated");
      };
      await assert.rejects(index.indexLocalRepository({ localPath: dir, repositoryId: "repo" }), /terminated/);

      // Memory still matches what the database holds: the uncommitted re-index
      // never reached the in-memory index.
      assert.deepEqual(
        index.listDocuments().map((document) => document.path),
        ["a.md"]
      );
      assert.match(index.getDocument("repo:a.md")?.content ?? "", /Original alpha/);
    });
  });

  it("never interleaves two re-indexes of the same repository", async () => {
    await withRepository({ "a.md": "# Alpha\nAlpha.\n" }, async (dir) => {
      const persistence = new FakePersistence();
      const gate = deferred();
      let active = 0;
      let maxActive = 0;
      persistence.onSave = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
      };
      const index = new InMemoryKnowledgeIndex(persistence);

      const first = index.indexLocalRepository({ localPath: dir, repositoryId: "repo" });
      const second = index.indexLocalRepository({ localPath: dir, repositoryId: "repo" });
      // Give the second call every chance to start its save early.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(active, 1, "the second re-index waits for the first to finish");
      gate.resolve();
      await Promise.all([first, second]);
      assert.equal(maxActive, 1);
      assert.equal(persistence.saves.length, 2);
    });
  });

  it("re-indexes different repositories in parallel", async () => {
    await withRepository({ "a.md": "# Alpha\nAlpha.\n" }, async (dir) => {
      const persistence = new FakePersistence();
      const gate = deferred();
      let active = 0;
      let maxActive = 0;
      persistence.onSave = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
      };
      const index = new InMemoryKnowledgeIndex(persistence);
      const one = index.indexLocalRepository({ localPath: dir, repositoryId: "one" });
      const two = index.indexLocalRepository({ localPath: dir, repositoryId: "two" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(active, 2);
      gate.resolve();
      await Promise.all([one, two]);
      assert.equal(maxActive, 2);
    });
  });

  it("drops a document's trailing sections when it now splits into fewer", async () => {
    const index = new InMemoryKnowledgeIndex();
    await index.indexMarkdownDocuments({
      repositoryId: "uploads",
      documents: [{ path: "guide.md", content: "# One\nfirst\n\n# Two\nsecond\n\n# Three\nthird\n" }]
    });
    const before = index.getStats().sectionCount;
    await index.indexMarkdownDocuments({
      repositoryId: "uploads",
      documents: [{ path: "guide.md", content: "# One\nfirst\n" }]
    });
    assert.ok(before > index.getStats().sectionCount, "the shrunken document keeps no stale sections");
    assert.deepEqual(
      index.listSections().map((section) => section.heading),
      ["One"]
    );
  });
});

describe("InMemoryKnowledgeIndex hydration", () => {
  it("is hydrated from the start without persistence", () => {
    assert.equal(new InMemoryKnowledgeIndex().isHydrated(), true);
  });

  it("stays un-hydrated after a failed load, then retries with backoff until one succeeds", async () => {
    const persistence = new FakePersistence();
    let attempts = 0;
    const loaded = deferred();
    persistence.onLoad = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("ECONNREFUSED");
      }
      loaded.resolve();
      return emptyKnowledge;
    };
    const index = new InMemoryKnowledgeIndex(persistence);
    assert.equal(index.isHydrated(), false);

    const errors: number[] = [];
    const first = await index.startHydration({
      initialDelayMs: 5,
      maxDelayMs: 20,
      onError: (_error, attempt) => errors.push(attempt)
    });
    assert.equal(first, false);
    assert.equal(index.isHydrated(), false, "a failed hydrate must not read as ready");

    // The retry timers are unref'd (they must never hold a shutting-down API
    // open), so poll on a ref'd timer to keep this test's event loop alive.
    for (let tick = 0; tick < 200 && !index.isHydrated(); tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await loaded.promise;
    assert.equal(index.isHydrated(), true);
    assert.equal(attempts, 3);
    assert.deepEqual(errors, [1, 2]);
    index.stopHydration();
  });

  it("does not overwrite a repository that was re-indexed while the load was in flight", async () => {
    await withRepository({ "fresh.md": "# Fresh\nCommitted by the re-index.\n" }, async (dir) => {
      const persistence = new FakePersistence();
      const loadStarted = deferred();
      const releaseLoad = deferred();
      // The load's snapshot predates the re-index: it still has the old document.
      persistence.onLoad = async () => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return {
          repositories: [
            {
              repository: { id: "repo", name: "repo", defaultBranch: "main", localPath: dir, provider: "local" }
            }
          ],
          documents: [
            {
              id: "repo:stale.md",
              repositoryId: "repo",
              path: "stale.md",
              metadata: { title: "Stale", status: "active", tags: [], relatedDocs: [] },
              content: "# Stale"
            }
          ],
          sections: []
        };
      };
      const index = new InMemoryKnowledgeIndex(persistence);
      const hydrating = index.hydrate();
      await loadStarted.promise;
      await index.indexLocalRepository({ localPath: dir, repositoryId: "repo" });
      releaseLoad.resolve();
      await hydrating;

      assert.equal(index.isHydrated(), true);
      assert.deepEqual(
        index.listDocuments().map((document) => document.path),
        ["fresh.md"],
        "the older snapshot must not resurrect the stale document"
      );
    });
  });
});

describe("KeyedMutex", () => {
  it("runs same-key work in order, survives a failure, and forgets drained keys", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = mutex.run("k", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow");
      throw new Error("boom");
    });
    const next = mutex.run("k", async () => {
      order.push("next");
      return 7;
    });
    await assert.rejects(slow, /boom/);
    assert.equal(await next, 7);
    assert.deepEqual(order, ["slow", "next"]);
    // A fresh run on a drained key starts immediately.
    assert.equal(await mutex.run("k", async () => 1), 1);
  });
});
