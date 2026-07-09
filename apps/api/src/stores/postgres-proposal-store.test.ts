import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresGapClusterStore } from "./postgres-gap-cluster-store.js";
import { PostgresProposalStore } from "./postgres-proposal-store.js";
import type { ProposalInput } from "./proposal-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

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
  const store = new PostgresProposalStore(makeTestPool(databaseUrl as string));

  it("round-trips a draft through create and get", async () => {
    const provenance = [
      {
        claim: "Logs are retained for 12 months",
        anchor: "log-retention",
        sources: [{ sourceId: "src-1", path: "docs/ops/logging.md", lines: "L10-L14" }]
      }
    ];
    const created = await store.create({ ...draft(`roundtrip-${Date.now()}`), provenance });
    assert.equal(created.status, "draft");
    // Postgres coalesces a missing value to an empty array; the row should too.
    assert.deepEqual(created.triggeringQuestionIds, []);
    assert.deepEqual(created.provenance, provenance);

    const fetched = await store.get(created.id);
    assert.equal(fetched?.id, created.id);
    assert.equal(fetched?.title, created.title);
    assert.equal(fetched?.markdown, created.markdown);
    assert.deepEqual(fetched?.provenance, provenance);
  });

  // #214 phase 3: the fold rewrites the survivor's provenance event alongside
  // its content — set, replace, and clear (undefined → NULL) must round-trip.
  it("setProvenance sets, replaces, and clears the provenance column", async () => {
    const created = await store.create(draft(`set-provenance-${Date.now()}`));
    assert.equal(created.provenance, undefined);

    const first = [{ claim: "A", sources: [{ sourceId: "s1", path: "a.md" }] }];
    await store.setProvenance(created.id, first);
    assert.deepEqual((await store.get(created.id))?.provenance, first);

    const replaced = [
      { claim: "A", sources: [{ sourceId: "s1", path: "a.md" }] },
      { claim: "B", anchor: "b", sources: [{ sourceId: "s2", path: "b.md", lines: "L1-L3" }] }
    ];
    await store.setProvenance(created.id, replaced);
    assert.deepEqual((await store.get(created.id))?.provenance, replaced);

    await store.setProvenance(created.id, undefined);
    assert.equal((await store.get(created.id))?.provenance, undefined);
  });

  it("excludes terminal proposals from the default list but keeps them as history", async () => {
    const stamp = Date.now();
    const active = await store.create(draft(`active-${stamp}`));
    const terminal = [
      { status: "merged", proposal: await store.create(draft(`merged-${stamp}`)) },
      { status: "rejected", proposal: await store.create(draft(`rejected-${stamp}`)) },
      { status: "superseded", proposal: await store.create(draft(`superseded-${stamp}`)) }
    ] as const;
    for (const { status, proposal } of terminal) {
      await store.updateStatus(proposal.id, status);
    }

    const activeIds = (await store.list(200)).map((proposal) => proposal.id);
    assert.ok(activeIds.includes(active.id), "active proposal should appear in the default list");
    for (const { status, proposal } of terminal) {
      assert.ok(!activeIds.includes(proposal.id), `${status} proposal should be excluded from the default list`);

      const historyIds = (await store.list(200, { status })).map((row) => row.id);
      assert.ok(historyIds.includes(proposal.id), `${status} proposal should be fetchable as history`);
    }
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
    const clusterStore = new PostgresGapClusterStore(makeTestPool(databaseUrl as string));
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

  it("getByClusterId returns the cluster's non-terminal proposal, newest first", async () => {
    const clusterStore = new PostgresGapClusterStore(makeTestPool(databaseUrl as string));
    const cluster = await clusterStore.createCluster({ title: `c-${randomUUID()}`, revision: 1 });

    assert.equal(await store.getByClusterId(cluster.id), undefined, "no proposal yet");

    const proposal = await store.create({
      title: "T",
      targetPath: "t.md",
      markdown: "#",
      rationale: "r",
      evidence: [],
      gapClusterId: cluster.id
    });
    const found = await store.getByClusterId(cluster.id);
    assert.equal(found?.id, proposal.id);

    // A settled proposal is hidden, matching the old default-list().find() scan.
    await store.updateStatus(proposal.id, "merged");
    assert.equal(await store.getByClusterId(cluster.id), undefined, "merged proposal is excluded");
  });
});
