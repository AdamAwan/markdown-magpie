import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { InMemoryKnowledgeIndex } from "./knowledge-index.js";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]): Promise<string> => exec("git", args, { cwd }).then((r) => r.stdout.trim());

const tempRoots: string[] = [];

// A local repo whose current branch is `initialBranch` and, crucially, has NO
// fetched origin/HEAD — the exact shape of a freshly-created checkout that made
// detection fall through to the current branch.
async function initRepoOn(initialBranch: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-branch-idx-"));
  tempRoots.push(root);
  await git(root, ["init", `--initial-branch=${initialBranch}`]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(root, "doc.md"), "# Doc\nBody.\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

afterEach(async () => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("indexLocalRepository primary-branch resolution", () => {
  it("uses the configured branch as the repository's default branch", async () => {
    const root = await initRepoOn("master");
    const index = new InMemoryKnowledgeIndex();

    await index.indexLocalRepository({ localPath: root, repositoryId: "repo", configuredBranch: "release" });

    const [repository] = index.listRepositories();
    assert.equal(repository.defaultBranch, "release");
  });

  it("falls back to the detected current branch when no branch is configured", async () => {
    const root = await initRepoOn("master");
    const index = new InMemoryKnowledgeIndex();

    await index.indexLocalRepository({ localPath: root, repositoryId: "repo" });

    const [repository] = index.listRepositories();
    assert.equal(repository.defaultBranch, "master");
  });
});
