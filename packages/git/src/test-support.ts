import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RepositoryRef } from "@magpie/core";

const execFileAsync = promisify(execFile);

async function run(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

export interface TempRemoteRepo {
  repository: RepositoryRef;
  remotePath: string;
  clonePath: string;
}

// Builds a bare "remote" plus a working clone with one seed commit on `main` and
// an origin/main remote-tracking ref — the minimum the publisher's create and
// update paths exercise. Everything lives under a fresh tmpdir; nothing here is
// cleaned up automatically (tests are short-lived and the OS reclaims tmp).
export async function initBareRemoteWithClone(): Promise<TempRemoteRepo> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-git-test-"));
  const remotePath = path.join(root, "remote.git");
  const clonePath = path.join(root, "clone");

  await mkdir(remotePath, { recursive: true });
  await run(remotePath, ["init", "--bare", "--initial-branch=main"]);

  await execFileAsync("git", ["clone", remotePath, clonePath]);
  await run(clonePath, ["config", "user.name", "Seed"]);
  await run(clonePath, ["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(clonePath, "README.md"), "# seed\n", "utf8");
  await run(clonePath, ["add", "-A"]);
  await run(clonePath, ["commit", "-m", "seed"]);
  await run(clonePath, ["push", "-u", "origin", "main"]);
  // resolveBaseRef looks for refs/remotes/origin/main; make sure it exists.
  await run(clonePath, ["fetch", "origin"]);

  const repository: RepositoryRef = {
    id: "test-repo",
    name: "test-repo",
    defaultBranch: "main",
    localPath: clonePath,
    provider: "local"
  };

  return { repository, remotePath, clonePath };
}
