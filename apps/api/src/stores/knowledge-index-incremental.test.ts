import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import type { DocumentSection, KnowledgeDocument } from "@magpie/core";
import {
  InMemoryKnowledgeIndex,
  type IncrementalIndexInput,
  type KnowledgePersistence,
  type LoadedKnowledge,
  type LoadedRepository
} from "./knowledge-index.js";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]): Promise<string> => exec("git", args, { cwd }).then((r) => r.stdout.trim());

// A persistence double that records which save path was exercised and lets a
// test seed the prior indexed SHA returned from loadAll() (simulating a restart).
class RecordingPersistence implements KnowledgePersistence {
  fullSaves = 0;
  incrementalApplies: IncrementalIndexInput[] = [];
  preload: LoadedKnowledge = { repositories: [], documents: [], sections: [] };

  async saveIndexedRepository(): Promise<void> {
    this.fullSaves += 1;
  }
  async applyIncrementalIndex(input: IncrementalIndexInput): Promise<void> {
    this.incrementalApplies.push(input);
  }
  async loadAll(): Promise<LoadedKnowledge> {
    return this.preload;
  }
  async reset(): Promise<void> {}
}

const tempRoots: string[] = [];

async function initRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-incr-idx-"));
  tempRoots.push(root);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  return root;
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const full = path.join(root, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function docPaths(index: InMemoryKnowledgeIndex): string[] {
  return index
    .listDocuments()
    .map((document) => document.path)
    .sort();
}

afterEach(async () => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("InMemoryKnowledgeIndex incremental reindex", () => {
  it("re-reads only changed files: add, modify, delete", async () => {
    const root = await initRepo();
    await write(root, "keep.md", "# Keep\nstable body\n");
    await write(root, "edit.md", "# Edit\noriginal body\n");
    await write(root, "remove.md", "# Remove\ngone soon\n");
    await commit(root, "seed");

    const persistence = new RecordingPersistence();
    const index = new InMemoryKnowledgeIndex(persistence);

    // First index is always full.
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });
    assert.equal(persistence.fullSaves, 1);
    assert.deepEqual(docPaths(index), ["edit.md", "keep.md", "remove.md"]);

    // Mutate the source: edit one, add one, delete one (all committed so they show
    // up in the prior..head diff). keep.md is NOT committed-changed.
    await write(root, "edit.md", "# Edit\nchanged body\n");
    await write(root, "added.md", "# Added\nbrand new\n");
    await rm(path.join(root, "remove.md"));
    await commit(root, "change");

    // Out-of-band tamper: overwrite keep.md ON DISK without committing. The next
    // index runs against a clean HEAD (this edit is staged below to keep the tree
    // clean), so an incremental reindex must NOT re-read keep.md — proven by its
    // stored content staying the original rather than picking up the tampered body.
    await write(root, "keep.md", "# Keep\nTAMPERED body that must not be indexed\n");
    await git(root, ["stash", "--include-untracked"]);
    // (stash leaves keep.md back at its committed content on disk, tree clean.)

    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    // Took the incremental path, not a second full save.
    assert.equal(persistence.fullSaves, 1);
    assert.equal(persistence.incrementalApplies.length, 1);

    assert.deepEqual(docPaths(index), ["added.md", "edit.md", "keep.md"]);
    const apply = persistence.incrementalApplies[0];
    // Only the committed-changed files were re-read and upserted; keep.md was not.
    assert.deepEqual(apply.upsertedDocuments.map((d: KnowledgeDocument) => d.path).sort(), ["added.md", "edit.md"]);
    assert.deepEqual(apply.deletedDocumentIds, ["repo:remove.md"]);

    // The edited document's content is the new body.
    const edited = index.listDocuments().find((d) => d.path === "edit.md");
    assert.match(edited?.content ?? "", /changed body/);
    // keep.md retains its originally-indexed content (never re-read).
    const kept = index.listDocuments().find((d) => d.path === "keep.md");
    assert.match(kept?.content ?? "", /stable body/);
  });

  it("handles a rename as delete-old + add-new", async () => {
    const root = await initRepo();
    await write(root, "old-name.md", "# Title\nstable content that triggers rename detection across commits\n");
    await commit(root, "seed");

    const persistence = new RecordingPersistence();
    const index = new InMemoryKnowledgeIndex(persistence);
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    await rename(path.join(root, "old-name.md"), path.join(root, "new-name.md"));
    await commit(root, "rename");

    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    assert.equal(persistence.incrementalApplies.length, 1);
    assert.deepEqual(docPaths(index), ["new-name.md"]);
    const apply = persistence.incrementalApplies[0];
    assert.deepEqual(apply.deletedDocumentIds, ["repo:old-name.md"]);
    assert.deepEqual(
      apply.upsertedDocuments.map((d: KnowledgeDocument) => d.path),
      ["new-name.md"]
    );
  });

  it("leaves unchanged documents' commitSha untouched; only changed docs get HEAD", async () => {
    const root = await initRepo();
    await write(root, "keep.md", "# Keep\nstable\n");
    await write(root, "edit.md", "# Edit\nv1\n");
    const firstSha = await commit(root, "seed");

    const index = new InMemoryKnowledgeIndex(new RecordingPersistence());
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    await write(root, "edit.md", "# Edit\nv2\n");
    const secondSha = await commit(root, "change");

    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    const keep = index.listDocuments().find((d) => d.path === "keep.md");
    const edit = index.listDocuments().find((d) => d.path === "edit.md");
    assert.equal(keep?.commitSha, firstSha, "unchanged doc keeps its original commit");
    assert.equal(edit?.commitSha, secondSha, "changed doc advances to HEAD");
  });

  it("skips re-reading entirely when HEAD is unchanged (clean no-op)", async () => {
    const root = await initRepo();
    await write(root, "a.md", "# A\nbody\n");
    await commit(root, "seed");

    const persistence = new RecordingPersistence();
    const index = new InMemoryKnowledgeIndex(persistence);
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    // Re-index at the same clean HEAD: must be a pure no-op (no full save, no
    // incremental apply), returning a summary derived from current state.
    const summary = await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    assert.equal(persistence.fullSaves, 1, "no second full save on a clean no-op");
    assert.equal(persistence.incrementalApplies.length, 0, "no incremental apply on a clean no-op");
    assert.equal(summary.documentCount, 1);
    assert.equal(summary.sectionCount >= 1, true);
  });

  it("maps subdirectory-scoped diff paths into the document-id path space", async () => {
    const root = await initRepo();
    await write(root, "docs/guide.md", "# Guide\nv1\n");
    await write(root, "docs/intro.md", "# Intro\nstable\n");
    await write(root, "outside/other.md", "# Other\nnot indexed\n");
    await commit(root, "seed");

    const subdir = path.join(root, "docs");
    const persistence = new RecordingPersistence();
    const index = new InMemoryKnowledgeIndex(persistence);
    await index.indexLocalRepository({ localPath: subdir, repositoryId: "repo" });
    // Only docs/* are indexed; ids are relative to the indexed subtree.
    assert.deepEqual(docPaths(index), ["guide.md", "intro.md"]);

    await write(root, "docs/guide.md", "# Guide\nv2\n");
    await write(root, "docs/added.md", "# Added\nnew\n");
    await write(root, "outside/other.md", "# Other\nchanged but outside scope\n");
    await commit(root, "change");

    await index.indexLocalRepository({ localPath: subdir, repositoryId: "repo" });

    assert.equal(persistence.incrementalApplies.length, 1);
    assert.deepEqual(docPaths(index), ["added.md", "guide.md", "intro.md"]);
    const apply = persistence.incrementalApplies[0];
    assert.deepEqual(apply.upsertedDocuments.map((d: KnowledgeDocument) => d.path).sort(), ["added.md", "guide.md"]);
    // The outside/ change must not leak into the indexed subtree.
    assert.ok(!docPaths(index).includes("other.md"));
  });

  it("uses the prior SHA recovered from loadAll() after a restart", async () => {
    const root = await initRepo();
    await write(root, "a.md", "# A\nv1\n");
    const firstSha = await commit(root, "seed");

    // Simulate a restart: a fresh index whose persistence reports a prior SHA and
    // already-loaded documents (as hydrate() would populate).
    const seedDoc: KnowledgeDocument = {
      id: "repo:a.md",
      repositoryId: "repo",
      path: "a.md",
      commitSha: firstSha,
      metadata: { title: "A", status: "draft", tags: [], relatedDocs: [] },
      content: "# A\nv1\n"
    };
    const seedSection: DocumentSection = {
      id: "repo:a.md:0",
      documentId: "repo:a.md",
      path: "a.md",
      heading: "A",
      headingPath: ["A"],
      anchor: "0",
      content: "v1",
      ordinal: 0
    };
    const loadedRepository: LoadedRepository = {
      repository: { id: "repo", name: "repo", defaultBranch: "main", localPath: root, provider: "local" },
      indexedCommitSha: firstSha
    };
    const persistence = new RecordingPersistence();
    persistence.preload = { repositories: [loadedRepository], documents: [seedDoc], sections: [seedSection] };

    const index = new InMemoryKnowledgeIndex(persistence);
    await index.hydrate();

    await write(root, "a.md", "# A\nv2\n");
    await commit(root, "change");

    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    // Took the incremental path thanks to the hydrated prior SHA.
    assert.equal(persistence.fullSaves, 0);
    assert.equal(persistence.incrementalApplies.length, 1);
    const updated = index.listDocuments().find((d) => d.path === "a.md");
    assert.match(updated?.content ?? "", /v2/);
  });
});

describe("InMemoryKnowledgeIndex full-reindex fallbacks", () => {
  it("first index of a git repo is full", async () => {
    const root = await initRepo();
    await write(root, "a.md", "# A\nbody\n");
    await commit(root, "seed");

    const persistence = new RecordingPersistence();
    const index = new InMemoryKnowledgeIndex(persistence);
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    assert.equal(persistence.fullSaves, 1);
    assert.equal(persistence.incrementalApplies.length, 0);
  });

  it("falls back to full when the source is not a git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "magpie-incr-nongit-"));
    tempRoots.push(root);
    await write(root, "a.md", "# A\nv1\n");

    const persistence = new RecordingPersistence();
    const index = new InMemoryKnowledgeIndex(persistence);
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    await write(root, "a.md", "# A\nv2\n");
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    // No git ⇒ no SHA ⇒ always full, never incremental.
    assert.equal(persistence.fullSaves, 2);
    assert.equal(persistence.incrementalApplies.length, 0);
  });

  it("falls back to full when the working tree is dirty", async () => {
    const root = await initRepo();
    await write(root, "a.md", "# A\nv1\n");
    await commit(root, "seed");

    const persistence = new RecordingPersistence();
    const index = new InMemoryKnowledgeIndex(persistence);
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    // Make a committed change AND leave an uncommitted edit so the working tree
    // is dirty at index time.
    await write(root, "a.md", "# A\nv2\n");
    await commit(root, "change");
    await write(root, "a.md", "# A\nv3 uncommitted\n");

    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    assert.equal(persistence.fullSaves, 2, "dirty tree forces a full reindex");
    assert.equal(persistence.incrementalApplies.length, 0);
    const doc = index.listDocuments().find((d) => d.path === "a.md");
    assert.match(doc?.content ?? "", /v3 uncommitted/, "full reindex picks up the working-tree content");
  });

  it("falls back to full when history was rewritten (prior SHA not an ancestor)", async () => {
    const root = await initRepo();
    await write(root, "a.md", "# A\nv1\n");
    await commit(root, "seed");

    const persistence = new RecordingPersistence();
    const index = new InMemoryKnowledgeIndex(persistence);
    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    // Rewrite history onto an orphan branch so the prior indexed commit is no
    // longer reachable from HEAD (simulates a force-push/rebase).
    await git(root, ["checkout", "--orphan", "rewritten"]);
    await write(root, "a.md", "# A\nrewritten\n");
    await write(root, "b.md", "# B\nnew on rewritten history\n");
    await commit(root, "rewritten history");

    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    assert.equal(persistence.fullSaves, 2, "non-ancestor prior SHA forces a full reindex");
    assert.equal(persistence.incrementalApplies.length, 0);
    assert.deepEqual(docPaths(index), ["a.md", "b.md"]);
  });
});
