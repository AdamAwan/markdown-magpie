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

    const { changes } = await diffChangedFiles(repo, first, second);
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

    const { changes: scoped } = await diffChangedFiles(repo, first, second, { subpath: "docs" });
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

test("diffChangedFiles reports a rename's diff under the new path", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    await writeFile(path.join(repo, "old.md"), "line one\nline two\nline three\n");
    const first = await commitAll(repo, "initial");

    await git(repo, ["mv", "old.md", "new.md"]);
    await writeFile(path.join(repo, "new.md"), "line one\nline two\nline three\nline four\n");
    const second = await commitAll(repo, "rename and edit");

    const { changes } = await diffChangedFiles(repo, first, second);
    const byPath = new Map(changes.map((change) => [change.path, change]));

    assert.equal(byPath.get("new.md")?.status, "renamed");
    assert.match(byPath.get("new.md")?.diff ?? "", /rename from old\.md/);
    assert.match(byPath.get("new.md")?.diff ?? "", /\+line four/);
    assert.equal(byPath.get("old.md"), undefined, "the stale path is not reported separately");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffChangedFiles reports a deleted file's diff under its path", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    await writeFile(path.join(repo, "gone.md"), "content to remove\n");
    await writeFile(path.join(repo, "stays.md"), "untouched\n");
    const first = await commitAll(repo, "initial");

    await git(repo, ["rm", "gone.md"]);
    const second = await commitAll(repo, "delete a file");

    const { changes } = await diffChangedFiles(repo, first, second);
    const byPath = new Map(changes.map((change) => [change.path, change]));

    assert.equal(byPath.get("gone.md")?.status, "deleted");
    assert.match(byPath.get("gone.md")?.diff ?? "", /-content to remove/);
    assert.equal(byPath.size, 1, "only the changed file is reported");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffChangedFiles handles many changed files in a single commit", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    const fileCount = 25;
    for (let i = 0; i < fileCount; i += 1) {
      await writeFile(path.join(repo, `file-${i}.md`), `original ${i}\n`);
    }
    const first = await commitAll(repo, "initial");

    for (let i = 0; i < fileCount; i += 1) {
      await writeFile(path.join(repo, `file-${i}.md`), `changed ${i}\n`);
    }
    const second = await commitAll(repo, "change all");

    const { changes } = await diffChangedFiles(repo, first, second);
    assert.equal(changes.length, fileCount);
    for (let i = 0; i < fileCount; i += 1) {
      const change = changes.find((c) => c.path === `file-${i}.md`);
      assert.ok(change, `expected a change entry for file-${i}.md`);
      assert.equal(change?.status, "modified");
      assert.match(change?.diff ?? "", new RegExp(`\\+changed ${i}`));
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffChangedFiles truncates an individual file's diff to maxDiffChars", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    await writeFile(path.join(repo, "small.md"), "x\n");
    await writeFile(path.join(repo, "big.md"), "x\n");
    const first = await commitAll(repo, "initial");

    await writeFile(path.join(repo, "small.md"), "x changed\n");
    const bigLines = Array.from({ length: 500 }, (_, i) => `line ${i} with some extra padding text`).join("\n");
    await writeFile(path.join(repo, "big.md"), `${bigLines}\n`);
    const second = await commitAll(repo, "change both, one big one small");

    const { changes } = await diffChangedFiles(repo, first, second, { maxDiffChars: 200 });
    const byPath = new Map(changes.map((change) => [change.path, change]));

    const bigDiff = byPath.get("big.md")?.diff ?? "";
    assert.ok(bigDiff.length <= 200 + "\n… (diff truncated)".length);
    assert.match(bigDiff, /diff truncated/);

    const smallDiff = byPath.get("small.md")?.diff ?? "";
    assert.doesNotMatch(smallDiff, /diff truncated/);
    assert.match(smallDiff, /\+x changed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffChangedFiles returns [] when nothing changed between two equal shas", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    await writeFile(path.join(repo, "a.md"), "a\n");
    const sha = await commitAll(repo, "initial");

    const { changes } = await diffChangedFiles(repo, sha, sha);
    assert.deepEqual(changes, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffChangedFiles caps materialized files at maxFiles but reports the true total", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    const fileCount = 12;
    for (let i = 0; i < fileCount; i += 1) {
      // Zero-pad so name-status order is deterministic and predictable.
      await writeFile(path.join(repo, `file-${String(i).padStart(2, "0")}.md`), `original ${i}\n`);
    }
    const first = await commitAll(repo, "initial");
    for (let i = 0; i < fileCount; i += 1) {
      await writeFile(path.join(repo, `file-${String(i).padStart(2, "0")}.md`), `changed ${i}\n`);
    }
    const second = await commitAll(repo, "change all");

    const { changes, totalCount } = await diffChangedFiles(repo, first, second, { maxFiles: 5 });

    // Only the first N files are materialized, in deterministic name-status order...
    assert.equal(changes.length, 5, "only maxFiles entries are materialized");
    assert.deepEqual(
      changes.map((change) => change.path),
      ["file-00.md", "file-01.md", "file-02.md", "file-03.md", "file-04.md"],
      "the first N files in name-status order"
    );
    // ...each with a real patch built (not an empty placeholder)...
    assert.match(changes[0].diff, /\+changed 0/);
    // ...and the TRUE total still reflects every changed file.
    assert.equal(totalCount, fileCount, "totalCount is the true number of changed files");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffChangedFiles materializes everything and totalCount equals changes.length when under maxFiles", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "magpie-source-sync-"));
  try {
    await git(repo, ["init", "-q"]);
    await writeFile(path.join(repo, "a.md"), "a\n");
    await writeFile(path.join(repo, "b.md"), "b\n");
    const first = await commitAll(repo, "initial");
    await writeFile(path.join(repo, "a.md"), "a changed\n");
    await writeFile(path.join(repo, "b.md"), "b changed\n");
    const second = await commitAll(repo, "change both");

    const { changes, totalCount } = await diffChangedFiles(repo, first, second, { maxFiles: 1000 });
    assert.equal(totalCount, 2);
    assert.equal(changes.length, 2, "a commit under the cap is unaffected");
    assert.match(changes.find((c) => c.path === "a.md")?.diff ?? "", /\+a changed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
