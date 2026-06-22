import type {
  ChangesetChange,
  GitRepositoryContext,
  PublishChangesetRequest,
  PublishProposalBranchRequest,
  PublishProposalBranchResponse,
  RepositoryRef
} from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import {
  publishCrunchInputSchema,
  publishCrunchOutputSchema,
  publishProposalInputSchema,
  publishProposalOutputSchema,
  publishSourceSyncInputSchema,
  publishSourceSyncOutputSchema
} from "@magpie/jobs";
import {
  LocalGitProposalPublisher,
  raisePullRequest,
  type RaisePullRequestRequest,
  type RaisedPullRequest
} from "@magpie/git";
import { z } from "zod";
import type {
  CrunchExecutionContext,
  ProposalExecutionContext,
  SourceSyncExecutionContext,
  WatcherApi
} from "../http-client.js";

// The git operations the publication runner needs, injectable so tests exercise
// the orchestration (context fetch, branch derivation, changeset assembly, PR
// fallback) without running real git or hitting GitHub.
export interface PublicationDeps {
  publishProposal(request: PublishProposalBranchRequest): Promise<PublishProposalBranchResponse>;
  publishChangeset(request: PublishChangesetRequest): Promise<PublishProposalBranchResponse>;
  raisePullRequest(request: RaisePullRequestRequest): Promise<RaisedPullRequest | undefined>;
}

// Real git-backed deps used in production.
export function createGitPublicationDeps(): PublicationDeps {
  const publisher = new LocalGitProposalPublisher();
  return {
    publishProposal: (request) => publisher.publish(request),
    publishChangeset: (request) => publisher.publishChangeset(request),
    raisePullRequest
  };
}

// Validates the credential-free execution-context the API returns, so a malformed
// response is rejected rather than silently producing a bad publish. Only the
// fields the runner actually uses are required.
const gitContextSchema = z.object({
  scope: z.string(),
  indexedPath: z.string(),
  workTreeRoot: z.string().optional(),
  relativePathFromRoot: z.string().optional(),
  currentBranch: z.string().optional(),
  defaultBranch: z.string().optional(),
  remoteUrl: z.string().optional()
});
const repositorySchema = z.object({
  id: z.string(),
  localPath: z.string(),
  remoteUrl: z.string().optional(),
  defaultBranch: z.string(),
  git: gitContextSchema.optional()
});
const proposalSchema = z.object({
  id: z.string(),
  title: z.string(),
  markdown: z.string(),
  targetPath: z.string(),
  rationale: z.string().optional(),
  gapSummary: z.string().optional()
});
const crunchPlanSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  operations: z.array(
    z.object({
      title: z.string(),
      writes: z.array(z.object({ path: z.string(), content: z.string() })),
      deletes: z.array(z.string())
    })
  )
});
const runSchema = z.object({ id: z.string(), plan: crunchPlanSchema });
const changesetChangeSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  delete: z.boolean().optional()
});
const sourceSyncRunSchema = z.object({ id: z.string(), changeset: z.array(changesetChangeSchema) });

type PublishRepository = z.infer<typeof repositorySchema>;
type PublishProposal = z.infer<typeof proposalSchema>;
type PublishRun = z.infer<typeof runSchema>;
type PublishSourceSyncRun = z.infer<typeof sourceSyncRunSchema>;

const PUBLISH_JOB_TYPES: ReadonlySet<JobType> = new Set([
  "publish_proposal",
  "publish_crunch",
  "publish_source_sync"
]);

// Executes the queue-only publication jobs with @magpie/git. It fetches the
// non-generative execution context from the API, derives the same branch name the
// API used to, publishes via the shared checkout, and returns ONLY the
// schema-defined publication result. Registered only under the github capability.
export class PublicationRunner {
  readonly capability: JobCapability = "github";

  constructor(
    private readonly api: WatcherApi,
    private readonly deps: PublicationDeps
  ) {}

  supports(type: JobType): boolean {
    return PUBLISH_JOB_TYPES.has(type);
  }

  async run(job: JobView, _signal: AbortSignal): Promise<unknown> {
    if (job.type === "publish_proposal") {
      return this.publishProposal(job);
    }
    if (job.type === "publish_crunch") {
      return this.publishCrunch(job);
    }
    if (job.type === "publish_source_sync") {
      return this.publishSourceSync(job);
    }
    throw new Error(`PublicationRunner cannot handle ${job.type}`);
  }

  private async publishProposal(job: JobView): Promise<unknown> {
    const { proposalId } = publishProposalInputSchema.parse(job.input);
    const context = await this.api.proposalExecutionContext(proposalId);
    const { proposal, repository } = parseProposalContext(context);

    const branchName = createProposalBranchName(proposal);
    const publication = await this.deps.publishProposal({
      repository: toRepositoryRef(repository),
      branchName,
      title: `docs: ${proposal.title}`,
      markdown: proposal.markdown,
      targetPath: proposal.targetPath
    });

    // The branch is pushed; try to open a PR. A PR failure must not lose the
    // branch, so degrade to a branch-only publish.
    let pullRequestUrl: string | undefined;
    try {
      const baseBranch = repository.defaultBranch || repository.git?.defaultBranch || "main";
      const raised = await this.deps.raisePullRequest({
        remoteUrl: publication.remoteUrl,
        headBranch: publication.branchName,
        baseBranch,
        title: `docs: ${proposal.title}`,
        body: buildPullRequestBody(proposal)
      });
      pullRequestUrl = raised?.url;
    } catch (error) {
      console.warn(
        `Branch ${publication.branchName} pushed, but PR creation failed: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }

    // Validate against the contract before returning, symmetric with publishCrunch.
    return publishProposalOutputSchema.parse({
      proposalId,
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      ...(publication.remoteUrl ? { remoteUrl: publication.remoteUrl } : {}),
      ...(pullRequestUrl ? { pullRequestUrl } : {}),
      publishedAt: new Date().toISOString()
    });
  }

  private async publishCrunch(job: JobView): Promise<unknown> {
    const { runId } = publishCrunchInputSchema.parse(job.input);
    const context = await this.api.crunchExecutionContext(runId);
    const { run, repository } = parseCrunchContext(context);

    const changes = changesetFromPlan(run);
    const operationCount = run.plan.operations.length;
    const publication = await this.deps.publishChangeset({
      repository: toRepositoryRef(repository),
      branchName: crunchBranchName(run),
      title: `docs: crunch tidy (${operationCount} operation${operationCount === 1 ? "" : "s"})`,
      changes
    });

    // Crunch raises no PR. Validate against the contract before returning.
    return publishCrunchOutputSchema.parse({
      runId,
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      ...(publication.remoteUrl ? { remoteUrl: publication.remoteUrl } : {}),
      publishedAt: new Date().toISOString()
    });
  }

  private async publishSourceSync(job: JobView): Promise<unknown> {
    const { runId } = publishSourceSyncInputSchema.parse(job.input);
    const context = await this.api.sourceSyncExecutionContext(runId);
    const { run, sourceName, repository } = parseSourceSyncContext(context);

    const documentCount = run.changeset.length;
    const publication = await this.deps.publishChangeset({
      repository: toRepositoryRef(repository),
      branchName: sourceSyncBranchName(run),
      // Match the title the API used before git moved out.
      title: `docs: sync to ${sourceName} change (${documentCount} document${documentCount === 1 ? "" : "s"})`,
      changes: run.changeset
    });

    // Source-sync raises no PR. Validate against the contract before returning.
    return publishSourceSyncOutputSchema.parse({
      runId,
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      ...(publication.remoteUrl ? { remoteUrl: publication.remoteUrl } : {}),
      publishedAt: new Date().toISOString()
    });
  }
}

function parseProposalContext(context: ProposalExecutionContext): {
  proposal: PublishProposal;
  repository: PublishRepository;
} {
  return {
    proposal: proposalSchema.parse(context.proposal),
    repository: repositorySchema.parse(context.repository)
  };
}

function parseCrunchContext(context: CrunchExecutionContext): {
  run: PublishRun;
  repository: PublishRepository;
} {
  return {
    run: runSchema.parse(context.run),
    repository: repositorySchema.parse(context.repository)
  };
}

function parseSourceSyncContext(context: SourceSyncExecutionContext): {
  run: PublishSourceSyncRun;
  sourceName: string;
  repository: PublishRepository;
} {
  return {
    run: sourceSyncRunSchema.parse(context.run),
    sourceName: z.string().parse(context.sourceName),
    repository: repositorySchema.parse(context.repository)
  };
}

// Builds a full RepositoryRef from the execution-context subset. The git
// publisher does not read `name` or `provider`, so they are filled honestly from
// what is available rather than cast around the missing fields.
function toRepositoryRef(repository: PublishRepository): RepositoryRef {
  return {
    id: repository.id,
    name: repository.id,
    defaultBranch: repository.defaultBranch,
    localPath: repository.localPath,
    provider: "github",
    ...(repository.remoteUrl ? { remoteUrl: repository.remoteUrl } : {}),
    ...(repository.git
      ? {
          git: {
            scope: asGitScope(repository.git.scope),
            indexedPath: repository.git.indexedPath,
            ...(repository.git.workTreeRoot ? { workTreeRoot: repository.git.workTreeRoot } : {}),
            ...(repository.git.relativePathFromRoot ? { relativePathFromRoot: repository.git.relativePathFromRoot } : {}),
            ...(repository.git.currentBranch ? { currentBranch: repository.git.currentBranch } : {}),
            ...(repository.git.defaultBranch ? { defaultBranch: repository.git.defaultBranch } : {}),
            ...(repository.git.remoteUrl ? { remoteUrl: repository.git.remoteUrl } : {})
          }
        }
      : {})
  };
}

function asGitScope(scope: string): GitRepositoryContext["scope"] {
  if (scope === "repository-root" || scope === "subdirectory" || scope === "not-git") {
    return scope;
  }
  // A publishable repository is always a git checkout; default conservatively.
  return "repository-root";
}

// The branch a proposal publishes onto. Mirrors the API's createProposalBranchName
// so the watcher publishes to the same branch the API records.
function createProposalBranchName(proposal: PublishProposal): string {
  return `magpie/proposal-${proposal.id.slice(0, 8)}-${slugify(proposal.title).slice(0, 40)}`;
}

// The branch a crunch run publishes onto. Mirrors the API's crunchBranchName.
function crunchBranchName(run: PublishRun): string {
  return `magpie/crunch-${run.id.slice(0, 8)}`;
}

// The branch a source-sync run publishes onto. Mirrors the API's
// sourceSyncBranchName so the watcher publishes to the same branch.
function sourceSyncBranchName(run: PublishSourceSyncRun): string {
  return `magpie/source-sync-${run.id.slice(0, 8)}`;
}

// Flattens a plan into a de-duplicated changeset (deletes first, then writes so a
// rewritten path stays a write). Mirrors the API's changesetFromPlan.
function changesetFromPlan(run: PublishRun): ChangesetChange[] {
  const changes = new Map<string, ChangesetChange>();
  for (const operation of run.plan.operations) {
    for (const deletion of operation.deletes) {
      changes.set(normalizeRelativePath(deletion), { path: deletion, delete: true });
    }
  }
  for (const operation of run.plan.operations) {
    for (const write of operation.writes) {
      changes.set(normalizeRelativePath(write.path), { path: write.path, content: write.content });
    }
  }
  return [...changes.values()];
}

// Human-facing PR description, mirroring the API's buildPullRequestBody.
function buildPullRequestBody(proposal: PublishProposal): string {
  const lines = ["Proposed by Markdown Magpie to close knowledge gaps.", ""];
  if (proposal.rationale) {
    lines.push(proposal.rationale, "");
  }
  const summaries = proposal.gapSummary
    ? proposal.gapSummary.split("\n").map((entry) => entry.trim()).filter(Boolean)
    : [];
  if (summaries.length > 0) {
    lines.push("Gaps addressed:");
    lines.push(...summaries.map((summary) => `- ${summary}`));
  }
  return lines.join("\n").trim();
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "docs-update"
  );
}

// Faithful copy of the API's normalizeRelativePath (apps/api/src/platform/paths.ts):
// strip backslashes and both leading and trailing slashes, so changeset dedup keys
// match exactly what the API records.
function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
