import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresGapClusterStore } from "./postgres-gap-cluster-store.js";
import { PostgresProposalStore } from "./postgres-proposal-store.js";
import type { ProposalInput } from "./proposal-store.js";

// Integration tests for the Postgres-backed proposal store. They self-skip
// unless DATABASE_URL points at a migrated database (see scripts/migrate.mjs);
// CI provides one via a pgvector service container. This is the template to
// follow for the other Postgres* stores — round-trip through real SQL and
// assert by the ids you created so parallel rows never make the suite flaky.
const databaseUrl = process.env.DATABASE_URL;

function draft(title: string): ProposalInput {
  return {
    title,
    targetPath: `docs/${title}.md`,
    markdown: `# ${title}`,
    rationale: "because",
    evidence: []
  };
}

describe("PostgresProposalStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresProposalStore(databaseUrl as string);

  it("round-trips a draft through create and get", async () => {
    const created = await store.create(draft(`roundtrip-${Date.now()}`));
    assert.equal(created.status, "draft");
    // Postgres coalesces a missing value to an empty array; the row should too.
    assert.deepEqual(created.triggeringQuestionIds, []);

    const fetched = await store.get(created.id);
    assert.equal(fetched?.id, created.id);
    assert.equal(fetched?.title, created.title);
    assert.equal(fetched?.markdown, created.markdown);
  });

  it("excludes merged proposals from the default list but keeps them as history", async () => {
    const active = await store.create(draft(`active-${Date.now()}`));
    const merged = await store.create(draft(`merged-${Date.now()}`));
    await store.updateStatus(merged.id, "merged");

    const activeIds = (await store.list(100)).map((proposal) => proposal.id);
    assert.ok(activeIds.includes(active.id), "active proposal should appear in the default list");
    assert.ok(!activeIds.includes(merged.id), "merged proposal should be excluded from the default list");

    const historyIds = (await store.list(100, { status: "merged" })).map((proposal) => proposal.id);
    assert.ok(historyIds.includes(merged.id), "merged proposal should be fetchable as history");
  });

  it("stamps mergedAt once and leaves it stable on a re-merge", async () => {
    const proposal = await store.create(draft(`merge-stamp-${Date.now()}`));

    const merged = await store.updateStatus(proposal.id, "merged");
    assert.ok(merged?.mergedAt, "mergedAt should be set when merged");

    const reMerged = await store.updateStatus(proposal.id, "merged");
    assert.equal(reMerged?.mergedAt, merged?.mergedAt);
  });

  it("marks pr-opened only when a pull request URL is present", async () => {
    const branchOnly = await store.create(draft(`branch-only-${Date.now()}`));
    const branchPushed = await store.recordPublication(branchOnly.id, {
      provider: "local-git",
      branchName: "magpie/branch-only",
      commitSha: "abc123",
      publishedAt: new Date().toISOString()
    });
    assert.equal(branchPushed?.status, "branch-pushed");

    const withPrDraft = await store.create(draft(`with-pr-${Date.now()}`));
    const prOpened = await store.recordPublication(withPrDraft.id, {
      provider: "local-git",
      branchName: "magpie/with-pr",
      commitSha: "def456",
      pullRequestUrl: "https://github.com/acme/docs/pull/7",
      publishedAt: new Date().toISOString()
    });
    assert.equal(prOpened?.status, "pr-opened");
  });

  it("returns undefined when updating or fetching an unknown id", async () => {
    assert.equal(await store.get("00000000-0000-0000-0000-000000000000"), undefined);
    assert.equal(await store.updateStatus("00000000-0000-0000-0000-000000000000", "merged"), undefined);
  });

  it("links a proposal to a gap cluster and reads it back", async () => {
    const clusterStore = new PostgresGapClusterStore(databaseUrl as string);
    const cluster = await clusterStore.createCluster({ title: `c-${randomUUID()}`, revision: 1 });

    const proposal = await store.create({
      title: "T",
      targetPath: "t.md",
      markdown: "#",
      rationale: "r",
      evidence: [],
      gapClusterId: cluster.id
    });
    const fetched = await store.get(proposal.id);
    assert.equal(fetched?.gapClusterId, cluster.id);

    const relinked = await store.linkCluster(proposal.id, cluster.id);
    assert.equal(relinked?.gapClusterId, cluster.id);
  });
});
