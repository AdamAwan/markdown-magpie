import type {
  CreatePullRequestRequest,
  CreatePullRequestResponse,
  PublishProposalBranchRequest,
  PublishProposalBranchResponse,
  PullRequestProvider,
  RepositoryRef
} from "@magpie/core";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

export class LocalRepositorySyncProvider implements RepositorySyncProvider {
  async sync(repository: RepositoryRef): Promise<RepositorySyncResult> {
    return {
      repository,
      changedPaths: []
    };
  }
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
    const absoluteTargetPath = path.resolve(root, targetPath);

    assertWithinRoot(root, absoluteTargetPath);
    await assertCleanWorkTree(root);
    await ensureRemote(root);

    const baseBranch = request.repository.git?.currentBranch ?? request.repository.defaultBranch;
    await git(root, ["checkout", baseBranch]);
    await git(root, ["checkout", "-B", request.branchName]);

    await mkdir(path.dirname(absoluteTargetPath), { recursive: true });
    await writeFile(absoluteTargetPath, request.markdown, "utf8");
    await git(root, ["add", "--", targetPath]);

    const status = await git(root, ["status", "--porcelain", "--", targetPath]);
    if (!status.trim()) {
      throw new Error(`Proposal does not change ${targetPath}`);
    }

    await git(root, ["commit", "-m", request.title]);
    const commitSha = (await git(root, ["rev-parse", "HEAD"])).trim();
    await git(root, ["push", "-u", "origin", request.branchName]);

    return {
      branchName: request.branchName,
      commitSha,
      remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
    };
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

async function assertCleanWorkTree(root: string): Promise<void> {
  const status = await git(root, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error("Cannot publish proposal because the repository checkout has uncommitted changes");
  }
}

async function ensureRemote(root: string): Promise<void> {
  const remote = await git(root, ["remote", "get-url", "origin"]);
  if (!remote.trim()) {
    throw new Error("Cannot publish proposal because git remote 'origin' is not configured");
  }
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

function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Proposal target path must stay inside the repository checkout");
  }
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}
