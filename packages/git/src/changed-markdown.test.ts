import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { isAncestor, listChangedMarkdown } from "./index.js";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]): Promise<string> => exec("git", args, { cwd }).then((r) => r.stdout.trim());

async function initRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-changed-md-"));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const full = path.join(root, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("listChangedMarkdown", () => {
  it("reports added, modified, and deleted markdown between two commits", async () => {
    const root = await initRepo();
    try {
      await write(root, "keep.md", "# keep\n");
      await write(root, "remove.md", "# remove\n");
      await write(root, "ignore.txt", "not markdown\n");
      const from = await commit(root, "seed");

      await write(root, "keep.md", "# keep\nmore\n");
      await write(root, "new.md", "# new\n");
      await rm(path.join(root, "remove.md"));
      await write(root, "ignore.txt", "still not markdown, changed\n");
      const to = await commit(root, "edit");

      const changes = await listChangedMarkdown(root, from, to);
      const byPath = new Map(changes.map((c) => [c.path, c.status]));

      assert.equal(byPath.get("keep.md"), "modified");
      assert.equal(byPath.get("new.md"), "added");
      assert.equal(byPath.get("remove.md"), "deleted");
      // Non-markdown changes are excluded by the *.md pathspec.
      assert.equal(byPath.has("ignore.txt"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a rename with both old and new paths", async () => {
    const root = await initRepo();
    try {
      await write(root, "old-name.md", "# stable content that triggers rename detection\nbody body body\n");
      const from = await commit(root, "seed");

      await rename(path.join(root, "old-name.md"), path.join(root, "new-name.md"));
      const to = await commit(root, "rename");

      const changes = await listChangedMarkdown(root, from, to);
      const rename_ = changes.find((c) => c.status === "renamed");
      assert.ok(rename_, "expected a renamed entry");
      assert.equal(rename_?.oldPath, "old-name.md");
      assert.equal(rename_?.path, "new-name.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scopes the diff to a subtree pathspec", async () => {
    const root = await initRepo();
    try {
      await write(root, "docs/inside.md", "# inside\n");
      await write(root, "outside.md", "# outside\n");
      const from = await commit(root, "seed");

      await write(root, "docs/inside.md", "# inside\nchanged\n");
      await write(root, "outside.md", "# outside\nchanged\n");
      await write(root, "docs/added.md", "# added inside\n");
      const to = await commit(root, "edit");

      const changes = await listChangedMarkdown(root, from, to, { pathspec: "docs" });
      const paths = changes.map((c) => c.path).sort();
      assert.deepEqual(paths, ["docs/added.md", "docs/inside.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scopes correctly when the subtree name contains glob metacharacters", async () => {
    const root = await initRepo();
    try {
      // Directory name with characters that would be glob-interpreted ([ ] ).
      await write(root, "docs[v1]/inside.md", "# inside\n");
      await write(root, "other.md", "# other\n");
      const from = await commit(root, "seed");

      await write(root, "docs[v1]/inside.md", "# inside\nchanged\n");
      await write(root, "docs[v1]/added.md", "# added\n");
      await write(root, "other.md", "# other\nchanged\n");
      const to = await commit(root, "edit");

      const changes = await listChangedMarkdown(root, from, to, { pathspec: "docs[v1]" });
      const paths = changes.map((c) => c.path).sort();
      assert.deepEqual(paths, ["docs[v1]/added.md", "docs[v1]/inside.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a bogus ref instead of throwing", async () => {
    const root = await initRepo();
    try {
      await write(root, "a.md", "# a\n");
      await commit(root, "seed");
      const changes = await listChangedMarkdown(root, "deadbeef", "HEAD");
      assert.deepEqual(changes, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("isAncestor", () => {
  it("is true for an earlier commit on a linear history and false for the reverse", async () => {
    const root = await initRepo();
    try {
      await write(root, "a.md", "# a\n");
      const first = await commit(root, "first");
      await write(root, "b.md", "# b\n");
      const second = await commit(root, "second");

      assert.equal(await isAncestor(root, first, second), true);
      assert.equal(await isAncestor(root, second, first), false);
      // A commit is its own ancestor.
      assert.equal(await isAncestor(root, first, first), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is false when history was rewritten so the prior commit is unreachable", async () => {
    const root = await initRepo();
    try {
      await write(root, "a.md", "# a\n");
      const original = await commit(root, "original");

      // Rewrite history: reset to the root's parent state and build a new commit
      // that does not descend from `original` (simulates a force-push/rebase).
      await git(root, ["checkout", "--orphan", "rewritten"]);
      await write(root, "a.md", "# a rewritten\n");
      const rewritten = await commit(root, "rewritten");

      assert.notEqual(original, rewritten);
      assert.equal(await isAncestor(root, original, rewritten), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
