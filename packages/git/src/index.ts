import type {
  CreatePullRequestRequest,
  CreatePullRequestResponse,
  PublishProposalBranchRequest,
  PublishProposalBranchResponse,
  PullRequestProvider,
  RepositoryRef
} from "@magpie/core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositorySyncResult {
  repository: RepositoryRef;
  headSha?: string;
  changedPaths: string[];
}

export interface RepositorySyncProvider {
  sync(repository: RepositoryRef): Promise<RepositorySyncResult>;
}

export interface GitCheckoutRequest {
  id: string;
  url: string;
  checkoutRoot: string;
  branch?: string;
}

export interface GitCheckoutResult {
  localPath: string;
  remoteUrl: string;
}

export class LocalRepositorySyncProvider implements RepositorySyncProvider {
  async sync(repository: RepositoryRef): Promise<RepositorySyncResult> {
    return {
      repository,
      changedPaths: []
    };
  }
}

export async function ensureGitCheckout(request: GitCheckoutRequest): Promise<GitCheckoutResult> {
  const localPath = path.join(request.checkoutRoot, safeCheckoutName(request.id));
  await mkdir(request.checkoutRoot, { recursive: true });

  if (!existsSync(path.join(localPath, ".git"))) {
    const cloneArgs = ["clone"];
    if (request.branch?.trim()) {
      cloneArgs.push("--branch", request.branch.trim());
    }
    cloneArgs.push(request.url, localPath);
    await git(request.checkoutRoot, cloneArgs);
  } else {
    const currentRemote = await tryGit(localPath, ["remote", "get-url", "origin"]);
    if (currentRemote.trim() && currentRemote.trim() !== request.url) {
      throw new Error(`Configured checkout ${localPath} already points at ${currentRemote.trim()}`);
    }
    if (!currentRemote.trim()) {
      await git(localPath, ["remote", "add", "origin", request.url]);
    }
    await git(localPath, ["fetch", "--prune", "origin"]);
    if (request.branch?.trim()) {
      const branch = request.branch.trim();
      await git(localPath, ["checkout", branch]);
      if (await remoteBranchExists(localPath, branch)) {
        await git(localPath, ["pull", "--ff-only", "origin", branch]);
      }
    } else {
      const branch = await tryGit(localPath, ["branch", "--show-current"]);
      if (branch.trim() && (await remoteBranchExists(localPath, branch.trim()))) {
        await git(localPath, ["pull", "--ff-only"]);
      }
    }
  }

  return {
    localPath,
    remoteUrl: request.url
  };
}

export class DryRunPullRequestProvider implements PullRequestProvider {
  async createPullRequest(request: CreatePullRequestRequest): Promise<CreatePullRequestResponse> {
    return {
      id: `dry-run:${request.branchName}`,
      url: `file://${request.repository.localPath}`,
      status: "open"
    };
  }
}

export class LocalGitProposalPublisher {
  async publish(request: PublishProposalBranchRequest): Promise<PublishProposalBranchResponse> {
    const root = request.repository.git?.workTreeRoot ?? request.repository.localPath;
    const targetPath = resolveTargetPath(request.repository, request.targetPath);
    await ensureRemote(root);
    await assertBranchDoesNotExist(root, request.branchName);

    const baseRef = await resolveBaseRef(root, request.repository);
    const tempRoot = await mkdtemp(path.join(tmpdir(), "markdown-magpie-worktree-"));
    const worktreePath = path.join(tempRoot, "checkout");

    try {
      await git(root, ["worktree", "add", "-B", request.branchName, worktreePath, baseRef]);

      const absoluteTargetPath = path.resolve(worktreePath, targetPath);
      assertWithinRoot(worktreePath, absoluteTargetPath);
      await mkdir(path.dirname(absoluteTargetPath), { recursive: true });
      await writeFile(absoluteTargetPath, request.markdown, "utf8");
      await git(worktreePath, ["add", "--", targetPath]);

      const status = await git(worktreePath, ["status", "--porcelain", "--", targetPath]);
      if (!status.trim()) {
        throw new Error(`Proposal does not change ${targetPath}`);
      }

      const { name: authorName, email: authorEmail } = resolveCommitterIdentity();
      await git(worktreePath, [
        "-c",
        `user.name=${authorName}`,
        "-c",
        `user.email=${authorEmail}`,
        "commit",
        "-m",
        request.title
      ]);
      const commitSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
      await git(worktreePath, ["push", "-u", "origin", request.branchName]);

      return {
        branchName: request.branchName,
        commitSha,
        remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
      };
    } finally {
      await cleanupWorktree(root, worktreePath, tempRoot);
    }
  }
}

function resolveTargetPath(repository: RepositoryRef, targetPath: string): string {
  const normalizedTargetPath = toPosixPath(targetPath).replace(/^\/+/, "");
  const relativePathFromRoot = repository.git?.relativePathFromRoot;
  if (!relativePathFromRoot || relativePathFromRoot === ".") {
    return normalizedTargetPath;
  }

  const normalizedRelativePath = toPosixPath(relativePathFromRoot).replace(/^\/+|\/+$/g, "");
  if (normalizedTargetPath === normalizedRelativePath || normalizedTargetPath.startsWith(`${normalizedRelativePath}/`)) {
    return normalizedTargetPath;
  }

  return `${normalizedRelativePath}/${normalizedTargetPath}`;
}

function resolveCommitterIdentity(): { name: string; email: string } {
  const name = process.env.MAGPIE_GIT_AUTHOR_NAME?.trim();
  const email = process.env.MAGPIE_GIT_AUTHOR_EMAIL?.trim();
  if (!name || !email) {
    throw new Error(
      "Cannot publish proposal because the commit identity is not configured. " +
        "Set MAGPIE_GIT_AUTHOR_NAME and MAGPIE_GIT_AUTHOR_EMAIL."
    );
  }
  return { name, email };
}

async function ensureRemote(root: string): Promise<void> {
  const remote = await git(root, ["remote", "get-url", "origin"]);
  if (!remote.trim()) {
    throw new Error("Cannot publish proposal because git remote 'origin' is not configured");
  }
}

async function assertBranchDoesNotExist(root: string, branchName: string): Promise<void> {
  const localBranch = await tryGit(root, ["show-ref", "--verify", `refs/heads/${branchName}`]);
  const remoteBranch = await tryGit(root, ["ls-remote", "--heads", "origin", branchName]);
  if (localBranch.trim() || remoteBranch.trim()) {
    throw new Error(`Cannot publish proposal because branch ${branchName} already exists`);
  }
}

async function resolveBaseRef(root: string, repository: RepositoryRef): Promise<string> {
  const defaultBranch = repository.defaultBranch || repository.git?.defaultBranch || repository.git?.currentBranch || "main";
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  const hasRemoteRef = await tryGit(root, ["show-ref", "--verify", remoteRef]);
  if (hasRemoteRef.trim()) {
    return `origin/${defaultBranch}`;
  }

  return defaultBranch;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : "git command failed";
    throw new Error(message);
  }
}

async function tryGit(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}

async function cleanupWorktree(root: string, worktreePath: string, tempRoot: string): Promise<void> {
  await tryGit(root, ["worktree", "remove", "--force", worktreePath]);
  await rm(tempRoot, { force: true, recursive: true });
}

function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Proposal target path must stay inside the repository checkout");
  }
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function remoteBranchExists(root: string, branch: string): Promise<boolean> {
  const result = await tryGit(root, ["ls-remote", "--heads", "origin", branch]);
  return Boolean(result.trim());
}

function safeCheckoutName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repository"
  );
}
