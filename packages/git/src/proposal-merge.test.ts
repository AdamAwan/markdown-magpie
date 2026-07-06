import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deleteLocalProposalBranch, mergeLocalProposalBranch } from "./index.js";

const execFileAsync = promisify(execFile);

// The helper commits a merge, so it needs a committer identity in the env.
process.env.MAGPIE_GIT_AUTHOR_NAME = "Magpie";
process.env.MAGPIE_GIT_AUTHOR_EMAIL = "magpie@example.com";

const BRANCH = "magpie/proposal-abc";

// A non-bare repo on `main` with a `magpie/proposal-abc` branch that adds one
// file — the state a local-git destination is in after the publisher pushes.
async function initRepoWithProposalBranch(): Promise<string> {
  const repoPath = path.join(await mkdtemp(path.join(tmpdir(), "magpie-merge-")), "repo");
  await mkdir(repoPath, { recursive: true });
  const run = (args: string[]) => execFileAsync("git", args, { cwd: repoPath });
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Seed"]);
  await run(["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(repoPath, "README.md"), "# seed\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "seed"]);
  await run(["checkout", "-b", BRANCH]);
  await writeFile(path.join(repoPath, "new-doc.md"), "# New\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "add new doc"]);
  await run(["checkout", "main"]);
  return repoPath;
}

test("mergeLocalProposalBranch merges the branch into main and deletes it", async () => {
  const repoPath = await initRepoWithProposalBranch();

  const result = await mergeLocalProposalBranch({ repoPath, branchName: BRANCH, defaultBranch: "main" });

  assert.match(result.mergeCommitSha, /^[0-9a-f]{7,40}$/);
  const content = await readFile(path.join(repoPath, "new-doc.md"), "utf8");
  assert.match(content, /# New/);
  const branches = await execFileAsync("git", ["branch", "--list", BRANCH], { cwd: repoPath });
  assert.equal(branches.stdout.trim(), "", "merged proposal branch is deleted");
});

test("mergeLocalProposalBranch fails clearly when the target branch does not exist", async () => {
  const repoPath = await initRepoWithProposalBranch();

  // The repo only has `main` (+ the proposal branch); a misconfigured default of
  // `master` must produce a named error, not git's opaque "pathspec did not match".
  await assert.rejects(
    () => mergeLocalProposalBranch({ repoPath, branchName: BRANCH, defaultBranch: "master" }),
    /branch "master".*does not exist/
  );
});

test("mergeLocalProposalBranch aborts and throws on conflict, leaving main untouched", async () => {
  const repoPath = path.join(await mkdtemp(path.join(tmpdir(), "magpie-merge-")), "repo");
  await mkdir(repoPath, { recursive: true });
  const run = (args: string[]) => execFileAsync("git", args, { cwd: repoPath });
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Seed"]);
  await run(["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(repoPath, "doc.md"), "A\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "seed"]);
  await run(["checkout", "-b", BRANCH]);
  await writeFile(path.join(repoPath, "doc.md"), "B\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "branch change"]);
  await run(["checkout", "main"]);
  await writeFile(path.join(repoPath, "doc.md"), "C\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "main change"]);

  await assert.rejects(
    () => mergeLocalProposalBranch({ repoPath, branchName: BRANCH, defaultBranch: "main" }),
    /Could not merge/
  );

  // main's working tree is restored (abort succeeded) and the branch survives.
  // Trim to stay tolerant of the platform's checkout line endings (CRLF on Windows).
  const content = await readFile(path.join(repoPath, "doc.md"), "utf8");
  assert.equal(content.trim(), "C");
  const branches = await execFileAsync("git", ["branch", "--list", BRANCH], { cwd: repoPath });
  assert.equal(branches.stdout.trim().replace(/^\*?\s*/, ""), BRANCH);
});

test("deleteLocalProposalBranch removes the review branch without merging it", async () => {
  const repoPath = await initRepoWithProposalBranch();

  await deleteLocalProposalBranch({ repoPath, branchName: BRANCH, defaultBranch: "main" });

  // The branch is gone and its unmerged change never landed on main.
  const branches = await execFileAsync("git", ["branch", "--list", BRANCH], { cwd: repoPath });
  assert.equal(branches.stdout.trim(), "", "binned proposal branch is deleted");
  const onMain = await execFileAsync("git", ["ls-files", "new-doc.md"], { cwd: repoPath });
  assert.equal(onMain.stdout.trim(), "", "the branch's change did not merge into main");
});

test("deleteLocalProposalBranch is a no-op when the branch is already gone", async () => {
  const repoPath = await initRepoWithProposalBranch();
  await execFileAsync("git", ["branch", "-D", BRANCH], { cwd: repoPath });

  // A missing branch is not an error — the desired end state already holds.
  await deleteLocalProposalBranch({ repoPath, branchName: BRANCH, defaultBranch: "main" });
});
