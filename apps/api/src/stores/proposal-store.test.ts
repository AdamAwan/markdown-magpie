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

test("list excludes merged proposals by default but keeps them fetchable as history", async () => {
  const store = new InMemoryProposalStore();
  const active = await store.create(draft("active"));
  const merged = await store.create(draft("merged"));
  await store.updateStatus(merged.id, "merged");

  const activeList = await store.list(50);
  assert.deepEqual(
    activeList.map((proposal) => proposal.id),
    [active.id]
  );

  const history = await store.list(50, { status: "merged" });
  assert.deepEqual(
    history.map((proposal) => proposal.id),
    [merged.id]
  );
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
