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
