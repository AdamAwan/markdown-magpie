import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RepositoryRef } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { publishProposalOutputSchema } from "@magpie/jobs";
import type {
  ProposalExecutionContext,
  WatcherApi
} from "../http-client.js";
import { preparePublicationRepository, PublicationRunner } from "./publication.js";

function job(type: JobView["type"], input: unknown): JobView {
  return {
    id: "j",
    type,
    queueName: type,
    deadLetter: false,
    state: "active",
    input,
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300
  };
}

const REPOSITORY = {
  id: "repo-1",
  localPath: "/tmp/repo",
  remoteUrl: "https://github.com/acme/docs.git",
  defaultBranch: "main",
  git: { scope: "repository-root", indexedPath: "/tmp/repo", workTreeRoot: "/tmp/repo" }
};

const PROPOSAL_CONTEXT: ProposalExecutionContext = {
  proposal: {
    id: "prop-12345678",
    title: "Deploy guide",
    markdown: "# Deploy\n",
    targetPath: "ops/deploy.md",
    rationale: "Close the deploy gap",
    gapSummary: "no deploy docs"
  },
  repository: REPOSITORY
};

function fakeApi(overrides: Partial<WatcherApi> = {}): WatcherApi {
  return {
    claim: async () => undefined,
    heartbeat: async () => ({ cancelled: false }),
    complete: async () => undefined,
    fail: async () => undefined,
    retrieve: async () => [],
    routeByEmbedding: async () => ({ status: "abstain" }),
    proposalExecutionContext: async () => PROPOSAL_CONTEXT,
    reconcileGaps: async () => ({ ok: true }),
    verifyClosure: async () => ({ proposalId: "p", closureStatus: "verified_closed", perQuestion: [] }),
    runSourceSync: async () => ({ runIds: [] }),
    runFixPatrol: async () => ({ runId: "run-1", selectedCount: 0, findingCount: 0 }),
    runImprovePatrol: async () => ({ runId: "run-1", selectedCount: 0, enqueuedCount: 0 }),
    listOpenPullRequests: async () => [],
    ...overrides
  };
}

describe("PublicationRunner", () => {
  it("declares the github capability and supports only publish job types", () => {
    const runner = new PublicationRunner(fakeApi(), {
      prepareRepository: async (repository) => repository,
      publishProposal: async () => ({ branchName: "b", commitSha: "c" }),
      publishChangeset: async () => ({ branchName: "b", commitSha: "c" }),
      raisePullRequest: async () => undefined,
      commentOnPullRequest: async () => undefined
    });
    assert.equal(runner.capability, "github");
    assert.ok(runner.supports("publish_proposal"));
    assert.ok(!runner.supports("publish_source_sync" as never));
    assert.ok(runner.supports("crosslink_pull_requests"));
    assert.ok(!runner.supports("answer_question"));
  });

  it("publishes a proposal and returns a schema-valid output with the derived branch", async () => {
    let publishedBranch: string | undefined;
    const runner = new PublicationRunner(fakeApi(), {
      prepareRepository: async (repository) => repository,
      publishProposal: async (request) => {
        publishedBranch = request.branchName;
        return { branchName: request.branchName, commitSha: "abc123", remoteUrl: REPOSITORY.remoteUrl };
      },
      publishChangeset: async () => ({ branchName: "b", commitSha: "c" }),
      raisePullRequest: async () => ({ url: "https://github.com/acme/docs/pull/7", number: 7 }),
      commentOnPullRequest: async () => undefined
    });

    const output = await runner.run(job("publish_proposal", { proposalId: "prop-12345678" }), new AbortController().signal);
    const parsed = publishProposalOutputSchema.parse(output);
    assert.equal(parsed.proposalId, "prop-12345678");
    assert.equal(parsed.branchName, "magpie/proposal-prop-123-deploy-guide");
    assert.equal(publishedBranch, "magpie/proposal-prop-123-deploy-guide");
    assert.equal(parsed.commitSha, "abc123");
    assert.equal(parsed.pullRequestUrl, "https://github.com/acme/docs/pull/7");
  });

  it("publishes a changeset proposal via publishChangeset, not the single-file path", async () => {
    let changesetCall: { branchName: string; changes: unknown } | undefined;
    let singleFileCalled = false;
    const changesetContext: ProposalExecutionContext = {
      proposal: {
        id: "prop-12345678",
        title: "Dedupe deploy guide",
        markdown: "# Deploy\nmerged",
        targetPath: "ops/deploy.md",
        changeset: [
          { path: "ops/deploy.md", content: "# Deploy\nmerged" },
          { path: "ops/deploy-old.md", delete: true }
        ]
      },
      repository: REPOSITORY
    };
    const runner = new PublicationRunner(fakeApi({ proposalExecutionContext: async () => changesetContext }), {
      prepareRepository: async (repository) => repository,
      publishProposal: async () => {
        singleFileCalled = true;
        return { branchName: "b", commitSha: "c" };
      },
      publishChangeset: async (request) => {
        changesetCall = { branchName: request.branchName, changes: request.changes };
        return { branchName: request.branchName, commitSha: "abc123", remoteUrl: REPOSITORY.remoteUrl };
      },
      raisePullRequest: async () => ({ url: "https://github.com/acme/docs/pull/9", number: 9 }),
      commentOnPullRequest: async () => undefined
    });

    const output = await runner.run(job("publish_proposal", { proposalId: "prop-12345678" }), new AbortController().signal);
    const parsed = publishProposalOutputSchema.parse(output);
    assert.equal(singleFileCalled, false, "single-file publish must not run for a changeset proposal");
    assert.deepEqual(changesetCall?.changes, [
      { path: "ops/deploy.md", content: "# Deploy\nmerged" },
      { path: "ops/deploy-old.md", delete: true }
    ]);
    assert.equal(parsed.pullRequestUrl, "https://github.com/acme/docs/pull/9");
  });

  it("degrades to a branch-only proposal publish when PR raising fails", async () => {
    const runner = new PublicationRunner(fakeApi(), {
      prepareRepository: async (repository) => repository,
      publishProposal: async (request) => ({ branchName: request.branchName, commitSha: "abc123", remoteUrl: REPOSITORY.remoteUrl }),
      publishChangeset: async () => ({ branchName: "b", commitSha: "c" }),
      raisePullRequest: async () => {
        throw new Error("pr api down");
      },
      commentOnPullRequest: async () => undefined
    });
    const output = await runner.run(job("publish_proposal", { proposalId: "prop-12345678" }), new AbortController().signal);
    const parsed = publishProposalOutputSchema.parse(output);
    assert.equal(parsed.pullRequestUrl, undefined);
    assert.equal(parsed.commitSha, "abc123");
  });

  it("skips PR raising for a local-git destination and returns a branch-only publish", async () => {
    let prRaised = false;
    const runner = new PublicationRunner(fakeApi(), {
      prepareRepository: async (repository) => repository,
      publishProposal: async (request) => ({ branchName: request.branchName, commitSha: "abc123", remoteUrl: "file:///tmp/local-repo" }),
      publishChangeset: async () => ({ branchName: "b", commitSha: "c" }),
      raisePullRequest: async () => {
        prRaised = true;
        return undefined;
      },
      commentOnPullRequest: async () => undefined
    });

    const output = await runner.run(
      job("publish_proposal", { proposalId: "prop-12345678", destination: "local-git" }),
      new AbortController().signal
    );
    const parsed = publishProposalOutputSchema.parse(output);
    assert.equal(prRaised, false, "local-git publish must not attempt to raise a PR");
    assert.equal(parsed.pullRequestUrl, undefined);
    assert.equal(parsed.branchName, "magpie/proposal-prop-123-deploy-guide");
    assert.equal(parsed.commitSha, "abc123");
  });

  it("prepares a watcher-local checkout before every publication flow", async () => {
    const preparedPaths: string[] = [];
    const publishedPaths: string[] = [];
    const runner = new PublicationRunner(fakeApi(), {
      prepareRepository: async (repository: RepositoryRef) => {
        preparedPaths.push(repository.localPath);
        return {
          ...repository,
          localPath: "/data/checkouts/repo-1",
          git: {
            ...repository.git!,
            indexedPath: "/data/checkouts/repo-1/docs",
            workTreeRoot: "/data/checkouts/repo-1"
          }
        };
      },
      publishProposal: async (request) => {
        publishedPaths.push(request.repository.git?.workTreeRoot ?? request.repository.localPath);
        return { branchName: request.branchName, commitSha: "abc123", remoteUrl: REPOSITORY.remoteUrl };
      },
      publishChangeset: async (request) => {
        publishedPaths.push(request.repository.git?.workTreeRoot ?? request.repository.localPath);
        return { branchName: request.branchName, commitSha: "def456", remoteUrl: REPOSITORY.remoteUrl };
      },
      raisePullRequest: async () => undefined,
      commentOnPullRequest: async () => undefined
    });

    const signal = new AbortController().signal;
    await runner.run(job("publish_proposal", { proposalId: "prop-12345678" }), signal);

    assert.deepEqual(preparedPaths, ["/tmp/repo"]);
    assert.deepEqual(publishedPaths, ["/data/checkouts/repo-1"]);
  });

  it("rejects checkout preparation without a repository remote URL", async () => {
    const repository: RepositoryRef = {
      id: "repo-1",
      name: "repo-1",
      localPath: "/api-host/checkout",
      defaultBranch: "main",
      provider: "github"
    };

    await assert.rejects(
      () => preparePublicationRepository(repository, "/data/checkouts"),
      /remote URL/
    );
  });

  it("rewrites API-host paths to the watcher checkout and preserves repository subdirectory scope", async () => {
    const repository: RepositoryRef = {
      id: "repo-1",
      name: "repo-1",
      localPath: "/api-host/checkout/docs",
      remoteUrl: "https://github.com/acme/docs.git",
      defaultBranch: "main",
      provider: "github",
      git: {
        scope: "subdirectory",
        indexedPath: "/api-host/checkout/docs",
        workTreeRoot: "/api-host/checkout",
        relativePathFromRoot: "docs",
        remoteUrl: "https://github.com/acme/docs.git"
      }
    };
    let checkoutRequest: unknown;

    const prepared = await preparePublicationRepository(
      repository,
      "/data/checkouts",
      async (request) => {
        checkoutRequest = request;
        return {
          localPath: "/data/checkouts/repo-1",
          remoteUrl: "https://github.com/acme/docs.git"
        };
      }
    );

    assert.deepEqual(checkoutRequest, {
      id: "repo-1",
      url: "https://github.com/acme/docs.git",
      checkoutRoot: "/data/checkouts",
      branch: "main"
    });
    assert.equal(prepared.localPath, "/data/checkouts/repo-1");
    assert.equal(prepared.git?.workTreeRoot, "/data/checkouts/repo-1");
    assert.equal(prepared.git?.indexedPath, "/data/checkouts/repo-1/docs");
    assert.equal(prepared.git?.relativePathFromRoot, "docs");
  });
});
