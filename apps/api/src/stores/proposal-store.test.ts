import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryProposalStore, type ProposalInput } from "./proposal-store.js";

function draft(title: string): ProposalInput {
  return {
    title,
    targetPath: `docs/${title}.md`,
    markdown: `# ${title}`,
    rationale: "because",
    evidence: []
  };
}

test("list excludes terminal proposals by default but keeps them fetchable as history", async () => {
  const store = new InMemoryProposalStore();
  const active = await store.create(draft("active"));
  const merged = await store.create(draft("merged"));
  const rejected = await store.create(draft("rejected"));
  const superseded = await store.create(draft("superseded"));
  await store.updateStatus(merged.id, "merged");
  await store.updateStatus(rejected.id, "rejected");
  await store.updateStatus(superseded.id, "superseded");

  // Merged, rejected and superseded are all settled, so the default inbox shows
  // only the active proposal — no terminal item is left stuck with no action.
  const activeList = await store.list(50);
  assert.deepEqual(
    activeList.map((proposal) => proposal.id),
    [active.id]
  );

  // Each terminal status remains fetchable by an explicit status filter.
  const byStatus = [
    { status: "merged", id: merged.id },
    { status: "rejected", id: rejected.id },
    { status: "superseded", id: superseded.id }
  ] as const;
  for (const { status, id } of byStatus) {
    const history = await store.list(50, { status });
    assert.deepEqual(
      history.map((proposal) => proposal.id),
      [id]
    );
  }
});

test("getByClusterId returns the linked non-terminal proposal and mirrors the old list().find()", async () => {
  const store = new InMemoryProposalStore();
  const linked = await store.create({ ...draft("linked"), gapClusterId: "cluster-1" });
  await store.create({ ...draft("other"), gapClusterId: "cluster-2" });

  const found = await store.getByClusterId("cluster-1");
  assert.equal(found?.id, linked.id);

  // An unlinked cluster has no proposal.
  assert.equal(await store.getByClusterId("cluster-3"), undefined);

  // A settled proposal is hidden (the old code listed via the default inbox,
  // which excludes terminal statuses), so its cluster resolves to undefined.
  await store.updateStatus(linked.id, "merged");
  assert.equal(await store.getByClusterId("cluster-1"), undefined);
});

test("getByClusterId prefers the most recent proposal when several link a cluster", async () => {
  const store = new InMemoryProposalStore();
  const older = await store.create({ ...draft("older"), gapClusterId: "cluster-x" });
  // Force a strictly-later createdAt on the second proposal.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const newer = await store.create({ ...draft("newer"), gapClusterId: "cluster-x" });

  const found = await store.getByClusterId("cluster-x");
  assert.equal(found?.id, newer.id);
  assert.notEqual(found?.id, older.id);
});

test("create defaults triggeringQuestionIds to an empty array (matching Postgres coalesce)", async () => {
  const store = new InMemoryProposalStore();
  const proposal = await store.create(draft("doc"));
  assert.deepEqual(proposal.triggeringQuestionIds, []);
});

test("updateStatus stamps mergedAt once and leaves it stable on later transitions", async () => {
  const store = new InMemoryProposalStore();
  const proposal = await store.create(draft("doc"));

  const merged = await store.updateStatus(proposal.id, "merged");
  assert.ok(merged?.mergedAt, "mergedAt should be set when merged");

  // A spurious re-merge keeps the original timestamp rather than overwriting it.
  const reMerged = await store.updateStatus(proposal.id, "merged");
  assert.equal(reMerged?.mergedAt, merged?.mergedAt);
});

test("recordPublication marks pr-opened only when a pull request URL is present", async () => {
  const store = new InMemoryProposalStore();
  const withoutPr = await store.create(draft("branch-only"));
  const branchPushed = await store.recordPublication(withoutPr.id, {
    provider: "local-git",
    branchName: "magpie/branch-only",
    commitSha: "abc123",
    publishedAt: new Date().toISOString()
  });
  assert.equal(branchPushed?.status, "branch-pushed");

  const withPr = await store.create(draft("with-pr"));
  const prOpened = await store.recordPublication(withPr.id, {
    provider: "local-git",
    branchName: "magpie/with-pr",
    commitSha: "def456",
    pullRequestUrl: "https://github.com/acme/docs/pull/7",
    publishedAt: new Date().toISOString()
  });
  assert.equal(prOpened?.status, "pr-opened");
});

test("updateMarkdown replaces the markdown and returns the proposal", async () => {
  const store = new InMemoryProposalStore();
  const created = await store.create({
    title: "Refunds",
    targetPath: "kb/refunds.md",
    markdown: "# old",
    rationale: "r",
    evidence: []
  });
  const updated = await store.updateMarkdown(created.id, "# new");
  assert.equal(updated?.markdown, "# new");
  assert.equal((await store.get(created.id))?.markdown, "# new");
});

test("updateMarkdown returns undefined for an unknown proposal", async () => {
  const store = new InMemoryProposalStore();
  assert.equal(await store.updateMarkdown("nope", "x"), undefined);
});

test("updateReviewDecision sets and returns the decision", async () => {
  const store = new InMemoryProposalStore();
  const created = await store.create(draft("refunds"));
  assert.equal(created.reviewDecision, undefined);

  const updated = await store.updateReviewDecision(created.id, "approved");
  assert.equal(updated?.reviewDecision, "approved");
  assert.equal((await store.get(created.id))?.reviewDecision, "approved");
});

test("updateReviewDecision returns undefined for an unknown proposal", async () => {
  const store = new InMemoryProposalStore();
  assert.equal(await store.updateReviewDecision("nope", "approved"), undefined);
});

test("create persists a first-class flowId", async () => {
  const store = new InMemoryProposalStore();
  const proposal = await store.create({ ...draft("doc"), flowId: "billing" });
  assert.equal(proposal.flowId, "billing");
  assert.equal((await store.get(proposal.id))?.flowId, "billing");
});

test("create persists a multi-file changeset", async () => {
  const store = new InMemoryProposalStore();
  const changeset = [
    { path: "kb/a.md", content: "# A merged" },
    { path: "kb/b.md", delete: true }
  ];
  const proposal = await store.create({ ...draft("a"), changeset });
  assert.deepEqual(proposal.changeset, changeset);
  assert.deepEqual((await store.get(proposal.id))?.changeset, changeset);
});

test("updateChangeset promotes a single-file proposal to a file-set and refreshes markdown", async () => {
  const store = new InMemoryProposalStore();
  const created = await store.create(draft("a"));
  assert.equal(created.changeset, undefined);

  const merged = [
    { path: "docs/a.md", content: "# A merged" },
    { path: "docs/b.md", delete: true }
  ];
  const updated = await store.updateChangeset(created.id, merged, "# A merged");
  assert.deepEqual(updated?.changeset, merged);
  assert.equal(updated?.markdown, "# A merged");
  assert.equal(updated?.targetPath, created.targetPath);
});

test("updateChangeset returns undefined for an unknown proposal", async () => {
  const store = new InMemoryProposalStore();
  assert.equal(await store.updateChangeset("nope", [], "x"), undefined);
});

// #214 phase 3: a fold rewrites the survivor's content, so its provenance event
// is rewritten with it — the only post-create provenance write.
test("setProvenance sets, replaces, and clears the provenance", async () => {
  const store = new InMemoryProposalStore();
  const created = await store.create(draft("folded"));
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

test("setProvenance is a no-op for an unknown proposal", async () => {
  const store = new InMemoryProposalStore();
  await store.setProvenance("nope", [{ claim: "A", sources: [{ sourceId: "s1" }] }]);
});

test("listMergedByTargetPath returns merged proposals touching a path, oldest merge first", async () => {
  const store = new InMemoryProposalStore();
  // Two merged proposals target docs/a.md; merge the "late" one first so the
  // ordering assertion exercises mergedAt, not insertion order.
  const late = await store.create({ ...draft("late"), targetPath: "docs/a.md" });
  const early = await store.create({ ...draft("early"), targetPath: "docs/a.md" });
  const other = await store.create({ ...draft("other"), targetPath: "docs/b.md" });
  await store.create({ ...draft("draft-only"), targetPath: "docs/a.md" });
  await store.updateStatus(early.id, "merged");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.updateStatus(late.id, "merged");
  await store.updateStatus(other.id, "merged");

  const events = await store.listMergedByTargetPath("docs/a.md", 10);
  assert.deepEqual(
    events.map((proposal) => proposal.id),
    [early.id, late.id],
    "only the merged docs/a.md proposals, oldest merge first"
  );
});

test("listMergedByTargetPath includes merged changesets touching the path and honours the limit", async () => {
  const store = new InMemoryProposalStore();
  const primary = await store.create({ ...draft("primary"), targetPath: "docs/a.md" });
  const viaChangeset = await store.create({
    ...draft("via-changeset"),
    targetPath: "docs/c.md",
    changeset: [
      { path: "docs/c.md", content: "# c" },
      { path: "docs/a.md", content: "# a moved" }
    ]
  });
  await store.updateStatus(primary.id, "merged");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.updateStatus(viaChangeset.id, "merged");

  const events = await store.listMergedByTargetPath("docs/a.md", 10);
  assert.deepEqual(
    events.map((proposal) => proposal.id),
    [primary.id, viaChangeset.id],
    "a merged changeset entry touching the path is a provenance event for it"
  );

  const capped = await store.listMergedByTargetPath("docs/a.md", 1);
  assert.deepEqual(
    capped.map((proposal) => proposal.id),
    [primary.id],
    "the limit keeps the OLDEST events (the stream is folded oldest-first)"
  );
});

test("create persists per-claim provenance and leaves it undefined when absent", async () => {
  const store = new InMemoryProposalStore();
  const provenance = [
    {
      claim: "Logs are retained for 12 months",
      anchor: "log-retention",
      sources: [{ sourceId: "src-1", path: "docs/ops/logging.md", lines: "L10-L14" }]
    }
  ];
  const withProvenance = await store.create({ ...draft("cited"), provenance });
  assert.deepEqual(withProvenance.provenance, provenance);
  assert.deepEqual((await store.get(withProvenance.id))?.provenance, provenance);

  const without = await store.create(draft("uncited"));
  assert.equal(without.provenance, undefined);
  assert.equal((await store.get(without.id))?.provenance, undefined);
});
