import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { diffChangedFiles, getHeadSha } from "@magpie/git";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

test("getHeadSha + diffChangedFiles report what changed between two commits", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    await writeFile(path.join(repo, "rules.md"), "items raised prior to 2024 are OLD\n");
    const first = await commitAll(repo, "initial");

    await writeFile(path.join(repo, "rules.md"), "items raised prior to 2025 are OLD\n");
    await writeFile(path.join(repo, "added.md"), "new file\n");
    const second = await commitAll(repo, "bump cutoff");

    assert.equal(await getHeadSha(repo), second);

    const changes = await diffChangedFiles(repo, first, second);
    const byPath = new Map(changes.map((change) => [change.path, change]));

    assert.equal(byPath.get("rules.md")?.status, "modified");
    assert.match(byPath.get("rules.md")?.diff ?? "", /\+items raised prior to 2025/);
    assert.equal(byPath.get("added.md")?.status, "added");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffChangedFiles scopes to a subpath", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "docs", "a.md"), "a\n");
    await writeFile(path.join(repo, "root.md"), "root\n");
    const first = await commitAll(repo, "initial");

    await writeFile(path.join(repo, "docs", "a.md"), "a changed\n");
    await writeFile(path.join(repo, "root.md"), "root changed\n");
    const second = await commitAll(repo, "change both");

    const scoped = await diffChangedFiles(repo, first, second, { subpath: "docs" });
    assert.deepEqual(
      scoped.map((change) => change.path),
      ["docs/a.md"],
      "only files under the subpath are reported"
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("getHeadSha returns undefined outside a git work tree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "magpie-not-git-"));
  try {
    assert.equal(await getHeadSha(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
