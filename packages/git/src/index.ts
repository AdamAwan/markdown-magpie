import type {
  CreatePullRequestRequest,
  CreatePullRequestResponse,
  PublishChangesetRequest,
  PublishProposalBranchRequest,
  PublishProposalBranchResponse,
  PullRequestProvider,
  RepositoryRef
} from "@magpie/core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A hung git subprocess (e.g. a credential prompt on a misconfigured remote) or
// a stalled GitHub connection would otherwise block indexing and the PR poller
// indefinitely; large diffs/clones could also blow past execFile's 1 MB default
// stdout buffer. These bounds are configurable for unusually large repos.
const GIT_SUBPROCESS_TIMEOUT_MS = positiveIntFromEnv("GIT_TIMEOUT_MS", 120_000);
const GIT_SUBPROCESS_MAX_BUFFER = positiveIntFromEnv("GIT_MAX_BUFFER_BYTES", 64 * 1024 * 1024);
const GITHUB_API_TIMEOUT_MS = positiveIntFromEnv("GITHUB_API_TIMEOUT_MS", 30_000);

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
  const authEnv = buildGitAuthEnv(request.url);

  if (!existsSync(path.join(localPath, ".git"))) {
    const cloneArgs = ["clone"];
    if (request.branch?.trim()) {
      cloneArgs.push("--branch", request.branch.trim());
    }
    cloneArgs.push(request.url, localPath);
    await git(request.checkoutRoot, cloneArgs, authEnv);
  } else {
    const currentRemote = await tryGit(localPath, ["remote", "get-url", "origin"]);
    if (currentRemote.trim() && currentRemote.trim() !== request.url) {
      throw new Error(`Configured checkout ${localPath} already points at ${currentRemote.trim()}`);
    }
    if (!currentRemote.trim()) {
      await git(localPath, ["remote", "add", "origin", request.url]);
    }
    await git(localPath, ["fetch", "--prune", "origin"], authEnv);
    if (request.branch?.trim()) {
      const branch = request.branch.trim();
      await git(localPath, ["checkout", branch]);
      if (await remoteBranchExists(localPath, branch, authEnv)) {
        await git(localPath, ["pull", "--ff-only", "origin", branch], authEnv);
      }
    } else {
      const branch = await tryGit(localPath, ["branch", "--show-current"]);
      if (branch.trim() && (await remoteBranchExists(localPath, branch.trim(), authEnv))) {
        await git(localPath, ["pull", "--ff-only"], authEnv);
      }
    }
  }

  return {
    localPath,
    remoteUrl: request.url
  };
}

// A single file touched by a range of source commits. `diff` is the unified
// patch for that file, truncated to keep model input bounded.
export interface SourceFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "other";
  diff: string;
}

// The current commit on the checkout's HEAD, or undefined when the path is not a
// git work tree (so callers can degrade rather than throw).
export async function getHeadSha(localPath: string): Promise<string | undefined> {
  const sha = (await tryGit(localPath, ["rev-parse", "HEAD"])).trim();
  return sha || undefined;
}

// The files changed between two commits, with a (capped) per-file patch. Scope to
// a subdirectory with `subpath` so a source's configured subpath is the only
// thing diffed. Returns [] when either ref is missing or nothing changed.
export async function diffChangedFiles(
  localPath: string,
  fromSha: string,
  toSha: string,
  options: { subpath?: string; maxDiffChars?: number } = {}
): Promise<SourceFileChange[]> {
  const maxDiffChars = options.maxDiffChars ?? 8_000;
  const pathspec = options.subpath?.trim() ? ["--", options.subpath.trim()] : [];

  const nameStatus = await tryGit(localPath, ["diff", "--name-status", "-M", `${fromSha}..${toSha}`, ...pathspec]);
  const changes: SourceFileChange[] = [];

  for (const line of nameStatus.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    // Columns are tab-separated: "<status>\t<path>" (renames add an old/new pair).
    const parts = trimmed.split(/\t/);
    const code = parts[0]?.[0] ?? "";
    const filePath = parts.length > 2 ? parts[parts.length - 1] : parts[1];
    if (!filePath) {
      continue;
    }

    const status: SourceFileChange["status"] =
      code === "A" ? "added" : code === "M" ? "modified" : code === "D" ? "deleted" : code === "R" ? "renamed" : "other";

    const rawDiff = await tryGit(localPath, ["diff", "-M", `${fromSha}..${toSha}`, "--", filePath]);
    const diff = rawDiff.length > maxDiffChars ? `${rawDiff.slice(0, maxDiffChars)}\n… (diff truncated)` : rawDiff;
    changes.push({ path: filePath, status, diff });
  }

  return changes;
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

export interface RaisePullRequestRequest {
  // Remote the published branch lives on. Used to derive the host and repo slug.
  remoteUrl: string | undefined;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface RaisedPullRequest {
  url: string;
  number: number;
}

// Opens a pull request for an already-pushed branch. Returns undefined when the
// remote host is unsupported or no token is configured, so callers can degrade
// to a branch-only publish. Throws only when a supported host's API rejects the
// request, so genuine failures surface rather than being silently swallowed.
export async function raisePullRequest(request: RaisePullRequestRequest): Promise<RaisedPullRequest | undefined> {
  const slug = parseGitHubSlug(request.remoteUrl);
  if (!slug) {
    return undefined;
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return undefined;
  }

  const response = await githubFetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "markdown-magpie"
    },
    body: JSON.stringify({
      title: request.title,
      head: request.headBranch,
      base: request.baseBranch,
      body: request.body
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub pull request creation failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await response.json()) as { html_url?: string; number?: number };
  if (!data.html_url || typeof data.number !== "number") {
    throw new Error("GitHub pull request creation returned an unexpected response");
  }

  return { url: data.html_url, number: data.number };
}

export interface PullRequestStatus {
  merged: boolean;
  // GitHub reports a merged PR as state "closed"; `merged` disambiguates a merge
  // from a close-without-merge.
  state: "open" | "closed";
}

// Reads the current state of a previously-raised GitHub pull request. Returns
// undefined when the URL is not a GitHub PR, no token is configured, or the PR
// can no longer be found — all cases where the poller should simply skip it.
// Throws only on an unexpected API error so transient failures surface in logs.
export async function fetchPullRequestStatus(pullRequestUrl: string | undefined): Promise<PullRequestStatus | undefined> {
  const ref = parseGitHubPullRequestUrl(pullRequestUrl);
  if (!ref) {
    return undefined;
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return undefined;
  }

  const response = await githubFetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "markdown-magpie"
      }
    }
  );

  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub pull request lookup failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await response.json()) as { merged?: boolean; state?: string };
  return { merged: Boolean(data.merged), state: data.state === "closed" ? "closed" : "open" };
}

// Parses owner/repo/number from a github.com pull request html_url such as
// https://github.com/owner/repo/pull/7.
function parseGitHubPullRequestUrl(
  pullRequestUrl: string | undefined
): { owner: string; repo: string; number: number } | undefined {
  if (!pullRequestUrl?.trim()) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(pullRequestUrl.trim());
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && !host.endsWith(".github.com")) {
    return undefined;
  }

  const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  // owner / repo / "pull" / number
  if (segments.length < 4 || segments[2] !== "pull") {
    return undefined;
  }

  const number = Number.parseInt(segments[3], 10);
  if (!Number.isInteger(number)) {
    return undefined;
  }

  return { owner: segments[0], repo: segments[1].replace(/\.git$/, ""), number };
}

// Extracts the owner/repo slug from an https or ssh github.com remote. Returns
// undefined for any other host so non-GitHub remotes degrade to branch-only.
function parseGitHubSlug(remoteUrl: string | undefined): { owner: string; repo: string } | undefined {
  if (!remoteUrl?.trim()) {
    return undefined;
  }

  const trimmed = remoteUrl.trim();
  // git@github.com:owner/repo(.git)
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && !host.endsWith(".github.com")) {
    return undefined;
  }

  const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2) {
    return undefined;
  }

  return { owner: segments[0], repo: segments[1].replace(/\.git$/, "") };
}

export class LocalGitProposalPublisher {
  async publish(request: PublishProposalBranchRequest): Promise<PublishProposalBranchResponse> {
    const root = request.repository.git?.workTreeRoot ?? request.repository.localPath;
    const targetPath = resolveTargetPath(request.repository, request.targetPath);
    const remoteUrl = await ensureRemote(root);
    const authEnv = buildGitAuthEnv(remoteUrl);
    await assertBranchDoesNotExist(root, request.branchName, authEnv);

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
      await git(worktreePath, ["push", "-u", "origin", request.branchName], authEnv);

      return {
        branchName: request.branchName,
        commitSha,
        remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
      };
    } finally {
      await cleanupWorktree(root, worktreePath, tempRoot);
    }
  }

  // Publishes a multi-file changeset (writes and deletes) to a single new
  // branch in one commit. Used by Crunch, where consolidating or splitting
  // documents necessarily creates and removes several files at once.
  async publishChangeset(request: PublishChangesetRequest): Promise<PublishProposalBranchResponse> {
    const root = request.repository.git?.workTreeRoot ?? request.repository.localPath;
    const remoteUrl = await ensureRemote(root);
    const authEnv = buildGitAuthEnv(remoteUrl);
    await assertBranchDoesNotExist(root, request.branchName, authEnv);

    const baseRef = await resolveBaseRef(root, request.repository);
    const tempRoot = await mkdtemp(path.join(tmpdir(), "markdown-magpie-worktree-"));
    const worktreePath = path.join(tempRoot, "checkout");

    try {
      await git(root, ["worktree", "add", "-B", request.branchName, worktreePath, baseRef]);

      for (const change of request.changes) {
        const repoRelativePath = resolveTargetPath(request.repository, change.path);
        const absolutePath = path.resolve(worktreePath, repoRelativePath);
        assertWithinRoot(worktreePath, absolutePath);

        if (change.delete) {
          await tryGit(worktreePath, ["rm", "--ignore-unmatch", "--", repoRelativePath]);
          // git rm already removes the file; unlink covers untracked paths.
          await unlink(absolutePath).catch(() => undefined);
          continue;
        }

        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, change.content ?? "", "utf8");
        await git(worktreePath, ["add", "--", repoRelativePath]);
      }

      const status = await git(worktreePath, ["status", "--porcelain"]);
      if (!status.trim()) {
        throw new Error("Crunch plan does not change any files");
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
      await git(worktreePath, ["push", "-u", "origin", request.branchName], authEnv);

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

async function ensureRemote(root: string): Promise<string> {
  const remote = await git(root, ["remote", "get-url", "origin"]);
  if (!remote.trim()) {
    throw new Error("Cannot publish proposal because git remote 'origin' is not configured");
  }
  return remote.trim();
}

async function assertBranchDoesNotExist(
  root: string,
  branchName: string,
  authEnv?: Partial<NodeJS.ProcessEnv>
): Promise<void> {
  const localBranch = await tryGit(root, ["show-ref", "--verify", `refs/heads/${branchName}`]);
  const remoteBranch = await tryGit(root, ["ls-remote", "--heads", "origin", branchName], authEnv);
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

// GitHub REST call with an abort-based timeout so the PR poller can't hang on a
// stalled connection. The TimeoutError is rethrown as a readable message.
async function githubFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`GitHub request timed out after ${GITHUB_API_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

async function git(cwd: string, args: string[], env?: Partial<NodeJS.ProcessEnv>): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      timeout: GIT_SUBPROCESS_TIMEOUT_MS,
      maxBuffer: GIT_SUBPROCESS_MAX_BUFFER
    });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : "git command failed";
    throw new Error(message);
  }
}

async function tryGit(cwd: string, args: string[], env?: Partial<NodeJS.ProcessEnv>): Promise<string> {
  try {
    return await git(cwd, args, env);
  } catch {
    return "";
  }
}

// Authenticate HTTPS git operations using a host-matched token, injected as an
// http.extraheader via GIT_CONFIG_* environment variables (git >= 2.31). The
// secret travels in the child's environment only — never in argv or the remote
// URL — so it can't leak into the command line that git() echoes back in error
// messages (which are surfaced to the UI). Returns {} when no token applies, so
// public repos, SSH remotes, and credential-embedded URLs keep working unchanged.
function buildGitAuthEnv(remoteUrl: string | undefined): Partial<NodeJS.ProcessEnv> {
  const header = buildAuthHeader(remoteUrl);
  if (!header) {
    return {};
  }
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: header
  };
}

function buildAuthHeader(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl?.trim()) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl.trim());
  } catch {
    return undefined;
  }

  // SSH (git@/ssh://) authenticates with keys; credential-embedded URLs already
  // carry their own auth — don't override either.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  if (parsed.username || parsed.password) {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) {
    const token = process.env.GITHUB_TOKEN?.trim();
    return token ? basicAuthHeader("x-access-token", token) : undefined;
  }
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    const pat = process.env.AZURE_DEVOPS_PAT?.trim();
    return pat ? basicAuthHeader("pat", pat) : undefined;
  }

  return undefined;
}

function basicAuthHeader(username: string, secret: string): string {
  const encoded = Buffer.from(`${username}:${secret}`).toString("base64");
  return `Authorization: Basic ${encoded}`;
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

async function remoteBranchExists(
  root: string,
  branch: string,
  authEnv?: Partial<NodeJS.ProcessEnv>
): Promise<boolean> {
  const result = await tryGit(root, ["ls-remote", "--heads", "origin", branch], authEnv);
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
