import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import { publishCrunchOutputSchema, publishProposalOutputSchema, publishSourceSyncOutputSchema } from "@magpie/jobs";
import type {
  CrunchExecutionContext,
  ProposalExecutionContext,
  SourceSyncExecutionContext,
  WatcherApi
} from "../http-client.js";
import { PublicationRunner } from "./publication.js";

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

const CRUNCH_CONTEXT: CrunchExecutionContext = {
  run: {
    id: "run-abcdef12",
    plan: {
      summary: "tidy",
      rationale: "overlap",
      operations: [
        { kind: "consolidate", title: "merge", reason: "dupes", sources: ["a.md", "b.md"], writes: [{ path: "merged.md", content: "x" }], deletes: ["b.md"] }
      ]
    }
  },
  repository: REPOSITORY
};

const SOURCE_SYNC_CONTEXT: SourceSyncExecutionContext = {
  run: {
    id: "run-aabbccdd",
    changeset: [{ path: "guide.md", content: "# Guide\nupdated" }]
  },
  sourceName: "Pricing repo",
  repository: REPOSITORY
};

function fakeApi(overrides: Partial<WatcherApi> = {}): WatcherApi {
  return {
    claim: async () => undefined,
    heartbeat: async () => ({ cancelled: false }),
    complete: async () => undefined,
    fail: async () => undefined,
    retrieve: async () => [],
    proposalExecutionContext: async () => PROPOSAL_CONTEXT,
    crunchExecutionContext: async () => CRUNCH_CONTEXT,
    sourceSyncExecutionContext: async () => SOURCE_SYNC_CONTEXT,
    reconcileGaps: async () => ({ ok: true }),
    runSourceSync: async () => ({ runIds: [] }),
    ...overrides
  };
}

describe("PublicationRunner", () => {
  it("declares the github capability and supports only publish job types", () => {
    const runner = new PublicationRunner(fakeApi(), {
      publishProposal: async () => ({ branchName: "b", commitSha: "c" }),
      publishChangeset: async () => ({ branchName: "b", commitSha: "c" }),
      raisePullRequest: async () => undefined
    });
    assert.equal(runner.capability, "github");
    assert.ok(runner.supports("publish_proposal"));
    assert.ok(runner.supports("publish_crunch"));
    assert.ok(runner.supports("publish_source_sync"));
    assert.ok(!runner.supports("answer_question"));
  });

  it("publishes a proposal and returns a schema-valid output with the derived branch", async () => {
    let publishedBranch: string | undefined;
    const runner = new PublicationRunner(fakeApi(), {
      publishProposal: async (request) => {
        publishedBranch = request.branchName;
        return { branchName: request.branchName, commitSha: "abc123", remoteUrl: REPOSITORY.remoteUrl };
      },
      publishChangeset: async () => ({ branchName: "b", commitSha: "c" }),
      raisePullRequest: async () => ({ url: "https://github.com/acme/docs/pull/7", number: 7 })
    });

    const output = await runner.run(job("publish_proposal", { proposalId: "prop-12345678" }), new AbortController().signal);
    const parsed = publishProposalOutputSchema.parse(output);
    assert.equal(parsed.proposalId, "prop-12345678");
    assert.equal(parsed.branchName, "magpie/proposal-prop-123-deploy-guide");
    assert.equal(publishedBranch, "magpie/proposal-prop-123-deploy-guide");
    assert.equal(parsed.commitSha, "abc123");
    assert.equal(parsed.pullRequestUrl, "https://github.com/acme/docs/pull/7");
  });

  it("degrades to a branch-only proposal publish when PR raising fails", async () => {
    const runner = new PublicationRunner(fakeApi(), {
      publishProposal: async (request) => ({ branchName: request.branchName, commitSha: "abc123", remoteUrl: REPOSITORY.remoteUrl }),
      publishChangeset: async () => ({ branchName: "b", commitSha: "c" }),
      raisePullRequest: async () => {
        throw new Error("pr api down");
      }
    });
    const output = await runner.run(job("publish_proposal", { proposalId: "prop-12345678" }), new AbortController().signal);
    const parsed = publishProposalOutputSchema.parse(output);
    assert.equal(parsed.pullRequestUrl, undefined);
    assert.equal(parsed.commitSha, "abc123");
  });

  it("publishes a crunch changeset and returns a schema-valid output", async () => {
    let publishedChanges: unknown;
    const runner = new PublicationRunner(fakeApi(), {
      publishProposal: async () => ({ branchName: "b", commitSha: "c" }),
      publishChangeset: async (request) => {
        publishedChanges = request.changes;
        return { branchName: request.branchName, commitSha: "def456", remoteUrl: REPOSITORY.remoteUrl };
      },
      raisePullRequest: async () => undefined
    });

    const output = await runner.run(job("publish_crunch", { runId: "run-abcdef12" }), new AbortController().signal);
    const parsed = publishCrunchOutputSchema.parse(output);
    assert.equal(parsed.runId, "run-abcdef12");
    assert.equal(parsed.branchName, "magpie/crunch-run-abcd");
    assert.equal(parsed.commitSha, "def456");
    assert.ok(Array.isArray(publishedChanges));
  });

  it("publishes a source-sync changeset with the derived branch and source-named title (no PR)", async () => {
    let publishedBranch: string | undefined;
    let publishedTitle: string | undefined;
    let publishedChanges: unknown;
    let prRaised = false;
    const runner = new PublicationRunner(fakeApi(), {
      publishProposal: async () => ({ branchName: "b", commitSha: "c" }),
      publishChangeset: async (request) => {
        publishedBranch = request.branchName;
        publishedTitle = request.title;
        publishedChanges = request.changes;
        return { branchName: request.branchName, commitSha: "fed789", remoteUrl: REPOSITORY.remoteUrl };
      },
      raisePullRequest: async () => {
        prRaised = true;
        return undefined;
      }
    });

    const output = await runner.run(job("publish_source_sync", { runId: "run-aabbccdd" }), new AbortController().signal);
    const parsed = publishSourceSyncOutputSchema.parse(output);
    assert.equal(parsed.runId, "run-aabbccdd");
    assert.equal(parsed.branchName, "magpie/source-sync-run-aabb");
    assert.equal(publishedBranch, "magpie/source-sync-run-aabb");
    assert.equal(parsed.commitSha, "fed789");
    assert.equal(publishedTitle, "docs: sync to Pricing repo change (1 document)");
    assert.ok(Array.isArray(publishedChanges));
    assert.equal(prRaised, false, "source-sync raises no PR");
  });

  it("rejects a source-sync context whose run carries no changeset", async () => {
    const api = fakeApi({
      sourceSyncExecutionContext: async () => ({
        run: { id: "run-aabbccdd" },
        sourceName: "Pricing repo",
        repository: REPOSITORY
      })
    });
    const runner = new PublicationRunner(api, {
      publishProposal: async () => ({ branchName: "b", commitSha: "c" }),
      publishChangeset: async () => ({ branchName: "b", commitSha: "c" }),
      raisePullRequest: async () => undefined
    });
    await assert.rejects(() => runner.run(job("publish_source_sync", { runId: "run-aabbccdd" }), new AbortController().signal));
  });
});
