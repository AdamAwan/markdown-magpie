import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import type { KnowledgeChange } from "@magpie/core";
import { InMemoryKnowledgeIndex } from "./knowledge-index.js";
import { InMemoryKnowledgeChangeStore } from "./knowledge-change-store.js";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]): Promise<string> => exec("git", args, { cwd }).then((r) => r.stdout.trim());

const tempRoots: string[] = [];

async function initRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-change-log-"));
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

// A four-section guide. Section bodies are distinct so a shear would be visible.
function guide(rates: string, extraSectionAtTop = ""): string {
  return [
    "# Billing guide",
    "",
    "Intro paragraph.",
    "",
    extraSectionAtTop,
    "## Rate tiers",
    "",
    rates,
    "",
    "## Limits",
    "",
    "Ten thousand requests a day.",
    "",
    "## Support",
    "",
    "Email support@example.com.",
    ""
  ].join("\n");
}

function describeEntries(entries: KnowledgeChange[]): string[] {
  return entries.map((entry) => `${entry.kind}:${entry.anchor ?? "-"}`).sort();
}

afterEach(async () => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("knowledge change log written by the index-time diff", () => {
  it("records nothing for the first index of a repository (a baseline, not a change)", async () => {
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await commit(root, "seed");

    const changes = new InMemoryKnowledgeChangeStore();
    const index = new InMemoryKnowledgeIndex(undefined, {}, { store: changes });
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    assert.deepEqual(await changes.listRecent(50), []);
  });

  it("records exactly one section_changed against the right anchor when one body is edited", async () => {
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await commit(root, "seed");

    const changes = new InMemoryKnowledgeChangeStore();
    const index = new InMemoryKnowledgeIndex(undefined, {}, { store: changes });
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    await write(root, "guide.md", guide("Tier one costs twelve."));
    const head = await commit(root, "edit rates");
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    const entries = await changes.listRecent(50);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "section_changed");
    assert.equal(entries[0].anchor, "billing-guide-rate-tiers");
    assert.equal(entries[0].heading, "Rate tiers");
    assert.equal(entries[0].documentId, "kb:guide.md");
    assert.equal(entries[0].path, "guide.md");
    assert.equal(entries[0].commitSha, head);
    // No attribution hint was passed, so the change is honestly unattributed.
    assert.equal(entries[0].cause, "external");
  });

  it("records one section_added and no shear when a section is inserted near the top", async () => {
    // The test the whole (documentId, anchor) identity choice exists for: keying
    // on sectionId (= documentId:ordinal) would report every section below the
    // insert as changed, exactly as content_changed_at does.
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await commit(root, "seed");

    const changes = new InMemoryKnowledgeChangeStore();
    const index = new InMemoryKnowledgeIndex(undefined, {}, { store: changes });
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    await write(root, "guide.md", guide("Tier one costs ten.", "## Notice\n\nBilling moves on Monday.\n"));
    await commit(root, "insert notice");
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    const entries = await changes.listRecent(50);
    assert.deepEqual(describeEntries(entries), ["section_added:billing-guide-notice"]);
  });

  it("reads a renamed heading as a removal plus an addition", async () => {
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await commit(root, "seed");

    const changes = new InMemoryKnowledgeChangeStore();
    const index = new InMemoryKnowledgeIndex(undefined, {}, { store: changes });
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    await write(root, "guide.md", guide("Tier one costs ten.").replace("## Rate tiers", "## Pricing tiers"));
    await commit(root, "rename heading");
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    assert.deepEqual(describeEntries(await changes.listRecent(50)), [
      "section_added:billing-guide-pricing-tiers",
      "section_removed:billing-guide-rate-tiers"
    ]);
  });

  it("writes nothing when a re-index finds no content change", async () => {
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await commit(root, "seed");

    const changes = new InMemoryKnowledgeChangeStore();
    const index = new InMemoryKnowledgeIndex(undefined, {}, { store: changes });
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    // A commit that touches a non-markdown file: HEAD moves, so the index runs a
    // real incremental pass, but no indexed content changed.
    await write(root, "notes.txt", "not markdown");
    await commit(root, "unrelated");
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    assert.deepEqual(await changes.listRecent(50), []);
  });

  it("adds no second entry when the same transition is re-indexed at the same commit", async () => {
    // The job-completion replay path deliberately re-runs side effects after a
    // 500, and a merge, a restart and the PR poller can each drive a re-index.
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await commit(root, "seed");

    const changes = new InMemoryKnowledgeChangeStore();
    const index = new InMemoryKnowledgeIndex(undefined, {}, { store: changes });
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    await write(root, "guide.md", guide("Tier one costs twelve."));
    const head = await commit(root, "edit rates");
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });
    const afterFirst = await changes.listRecent(50);
    assert.equal(afterFirst.length, 1);

    // Replaying the cascade re-indexes the same commit...
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });
    assert.deepEqual(await changes.listRecent(50), afterFirst);

    // ...and even an index that lost its prior-SHA tracking (a fresh process
    // that re-observes the transition) is deduped by the store on
    // (documentId, anchor, kind, commitSha).
    const replayed = await changes.record([
      {
        repositoryId: "kb",
        documentId: "kb:guide.md",
        path: "guide.md",
        anchor: "billing-guide-rate-tiers",
        heading: "Rate tiers",
        kind: "section_changed",
        commitSha: head,
        cause: "external"
      }
    ]);
    assert.equal(replayed, 0);
    assert.equal((await changes.listRecent(50)).length, 1);
  });

  it("records a removed document as one document_removed entry", async () => {
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await write(root, "other.md", "# Other\n\nBody.\n");
    await commit(root, "seed");

    const changes = new InMemoryKnowledgeChangeStore();
    const index = new InMemoryKnowledgeIndex(undefined, {}, { store: changes });
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    await rm(path.join(root, "other.md"));
    await commit(root, "drop other");
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    const entries = await changes.listRecent(50);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "document_removed");
    assert.equal(entries[0].documentId, "kb:other.md");
    assert.equal(entries[0].anchor, undefined);
  });

  it("stamps the attribution hint the caller passed", async () => {
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await commit(root, "seed");

    const changes = new InMemoryKnowledgeChangeStore();
    const index = new InMemoryKnowledgeIndex(
      undefined,
      {},
      {
        store: changes,
        resolveFlowId: (repositoryId) => (repositoryId === "kb" ? "billing-flow" : undefined)
      }
    );
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    await write(root, "guide.md", guide("Tier one costs twelve."));
    await commit(root, "edit rates");
    await index.indexLocalRepository({
      localPath: root,
      repositoryId: "kb",
      attribution: {
        cause: "source_sync",
        proposalId: "proposal-1",
        jobId: "job-1",
        sourceId: "product-repo",
        sourceFromSha: "a1b2f3",
        sourceToSha: "c3d4e5",
        summary: "Update billing rates"
      }
    });

    const [entry] = await changes.listRecent(50);
    assert.equal(entry.cause, "source_sync");
    assert.equal(entry.proposalId, "proposal-1");
    assert.equal(entry.jobId, "job-1");
    assert.equal(entry.sourceId, "product-repo");
    assert.equal(entry.sourceFromSha, "a1b2f3");
    assert.equal(entry.sourceToSha, "c3d4e5");
    assert.equal(entry.summary, "Update billing rates");
    assert.equal(entry.flowId, "billing-flow");
  });

  it("never fails an index when the change store throws", async () => {
    const root = await initRepo();
    await write(root, "guide.md", guide("Tier one costs ten."));
    await commit(root, "seed");

    const failing = new InMemoryKnowledgeChangeStore();
    failing.record = async () => {
      throw new Error("change log unavailable");
    };
    const index = new InMemoryKnowledgeIndex(undefined, {}, { store: failing });
    await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    await write(root, "guide.md", guide("Tier one costs twelve."));
    await commit(root, "edit rates");
    const summary = await index.indexLocalRepository({ localPath: root, repositoryId: "kb" });

    assert.equal(summary.documentCount, 1);
  });
});
