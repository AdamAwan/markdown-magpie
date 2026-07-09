import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftMarkdownProposalInputSchema,
  draftMarkdownProposalOutputSchema,
  draftSeedDocumentOutputSchema,
  foldMarkdownProposalInputSchema,
  foldMarkdownProposalOutputSchema,
  commentPullRequestInputSchema,
  processGapsToPullRequestsInputSchema,
  refreshFlowSnapshotOutputSchema,
  improveDocumentInputSchema,
  improveDocumentOutputSchema,
  splitDocumentInputSchema,
  splitDocumentOutputSchema,
  verifyDocumentInputSchema,
  verifyDocumentOutputSchema,
  correctDocumentOutputSchema
} from "./schemas.js";

test("process_gaps_to_pull_requests input requires and preserves flowId", () => {
  assert.equal(processGapsToPullRequestsInputSchema.safeParse({}).success, false);
  const parsed = processGapsToPullRequestsInputSchema.parse({ flowId: "magpie-support" });
  assert.deepEqual(parsed, { flowId: "magpie-support" });
});

test("verify_document input round-trips path/content/sources with a provider", () => {
  const ok = verifyDocumentInputSchema.safeParse({
    provider: "codex",
    path: "kb/refunds.md",
    content: "Refunds take 5 days.",
    sources: [{ id: "src-1", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" }]
  });
  assert.equal(ok.success, true);
});

test("verify_document input requires sources", () => {
  const missing = verifyDocumentInputSchema.safeParse({
    provider: "codex",
    path: "kb/refunds.md",
    content: "Refunds take 5 days."
  });
  assert.equal(missing.success, false);
});

test("verify_document output rejects an unknown verdict and accepts healthy/unprovable", () => {
  assert.equal(verifyDocumentOutputSchema.safeParse({ verdict: "healthy", claims: [] }).success, true);
  assert.equal(
    verifyDocumentOutputSchema.safeParse({ verdict: "unprovable", claims: [{ claim: "5 days", reason: "source says 7" }] }).success,
    true
  );
  assert.equal(verifyDocumentOutputSchema.safeParse({ verdict: "maybe", claims: [] }).success, false);
});

test("draft input schema preserves gapClusterId", () => {
  const parsed = draftMarkdownProposalInputSchema.parse({
    provider: "codex",
    gapSummaries: ["g"],
    triggeringQuestions: ["q"],
    evidence: [],
    sources: [],
    expectedOutput: "markdown_proposal",
    gapClusterId: "cluster-1"
  });
  assert.equal(parsed.gapClusterId, "cluster-1");
});

test("draft input schema leaves gapClusterId absent when not provided", () => {
  const parsed = draftMarkdownProposalInputSchema.parse({
    provider: "codex",
    gapSummaries: ["g"],
    triggeringQuestions: ["q"],
    evidence: [],
    sources: [],
    expectedOutput: "markdown_proposal"
  });
  assert.equal(parsed.gapClusterId, undefined);
});

test("draft input schema preserves triggeringQuestionIds and openPullRequests", () => {
  // Both are read back off the stored job input (triggeringQuestionIds links the
  // proposal to its triggering questions; openPullRequests makes the drafter aware
  // of in-flight work). The broker stores schema-parsed input, so a field missing
  // from the schema is silently stripped — regression guard for that strip.
  const parsed = draftMarkdownProposalInputSchema.parse({
    provider: "codex",
    gapSummaries: ["g"],
    triggeringQuestions: ["q"],
    evidence: [],
    sources: [],
    expectedOutput: "markdown_proposal",
    triggeringQuestionIds: ["question-1", "question-2"],
    openPullRequests: [
      { title: "Existing doc", url: "https://github.com/o/r/pull/1", targetPath: "x.md", status: "pr-opened" }
    ]
  });
  assert.deepEqual(parsed.triggeringQuestionIds, ["question-1", "question-2"]);
  assert.equal(parsed.openPullRequests?.length, 1);
  assert.equal(parsed.openPullRequests?.[0]?.status, "pr-opened");
});

test("draft input schema rejects an unknown open pull request status", () => {
  assert.ok(
    !draftMarkdownProposalInputSchema.safeParse({
      provider: "codex",
      gapSummaries: ["g"],
      triggeringQuestions: ["q"],
      evidence: [],
      expectedOutput: "markdown_proposal",
      openPullRequests: [{ title: "x", status: "in-review" }]
    }).success
  );
});

test("fold input schema round-trips the survivor/rival fields", () => {
  const parsed = foldMarkdownProposalInputSchema.parse({
    provider: "codex",
    survivorProposalId: "A",
    rivalProposalId: "B",
    targetPath: "kb/refunds.md",
    survivorMarkdown: "# A",
    rivalMarkdown: "# B",
    rivalGapSummaries: ["refund timing"],
    rivalEvidence: [],
    expectedOutput: "folded_markdown"
  });
  assert.equal(parsed.survivorProposalId, "A");
  assert.equal(parsed.rivalProposalId, "B");
});

test("fold output schema requires markdown and rationale", () => {
  assert.ok(foldMarkdownProposalOutputSchema.safeParse({ markdown: "m", rationale: "r" }).success);
  assert.ok(!foldMarkdownProposalOutputSchema.safeParse({ markdown: "m" }).success);
});

test("split_document schemas round-trip a bounded changeset", () => {
  assert.ok(
    splitDocumentInputSchema.safeParse({
      provider: "codex",
      path: "kb/refunds.md",
      content: "# Refunds",
      neighbours: [{ path: "kb/refund-operations.md", content: "# Refund operations" }],
      destinationId: "docs",
      flowId: "billing"
    }).success
  );
  assert.ok(
    splitDocumentOutputSchema.safeParse({
      split: true,
      rationale: "separated policy from operations",
      primaryPath: "kb/refunds.md",
      changeset: [
        { path: "kb/refunds.md", content: "# Refunds\nSee refund-operations.md." },
        { path: "kb/refund-operations.md", content: "# Refund operations\nMoved detail." }
      ]
    }).success
  );
  assert.ok(splitDocumentOutputSchema.safeParse({ split: false, rationale: "already focused", changeset: [] }).success);
});

test("improve_document schemas round-trip explicit improve and no-op outputs", () => {
  assert.ok(
    improveDocumentInputSchema.safeParse({
      provider: "codex",
      path: "kb/refunds.md",
      content: "# Refunds",
      sources: [],
      destinationId: "docs",
      flowId: "billing"
    }).success
  );
  assert.ok(
    improveDocumentOutputSchema.safeParse({
      improved: true,
      markdown: "# Refunds\nPartial refunds are supported.",
      rationale: "Added source-backed partial refund coverage."
    }).success
  );
  assert.ok(improveDocumentOutputSchema.safeParse({ improved: false, rationale: "No clear source-backed addition." }).success);
  assert.ok(!improveDocumentOutputSchema.safeParse({ improved: true, rationale: "missing markdown" }).success);
});

test("comment_pull_request input requires url and body", () => {
  assert.ok(commentPullRequestInputSchema.safeParse({ pullRequestUrl: "u", body: "b" }).success);
  assert.ok(!commentPullRequestInputSchema.safeParse({ pullRequestUrl: "u" }).success);
});

test("refresh output schema accepts a result with a reviewDecision", () => {
  const parsed = refreshFlowSnapshotOutputSchema.parse({
    results: [{ proposalId: "p1", state: "open", merged: false, reviewDecision: "approved" }]
  });
  assert.equal(parsed.results[0].reviewDecision, "approved");
});

test("refresh output schema leaves reviewDecision absent when not provided", () => {
  const parsed = refreshFlowSnapshotOutputSchema.parse({
    results: [{ proposalId: "p1", state: "closed", merged: true }]
  });
  assert.equal(parsed.results[0].reviewDecision, undefined);
});

test("refresh output schema rejects an unknown reviewDecision value", () => {
  assert.ok(
    !refreshFlowSnapshotOutputSchema.safeParse({
      results: [{ proposalId: "p1", state: "open", merged: false, reviewDecision: "maybe" }]
    }).success
  );
});

test.describe("source map updates on source-grounded outputs", () => {
  const update = {
    sourceId: "s1",
    topic: "event system",
    paths: ["src/events/"],
    description: "Event bus and handlers",
    observedSha: "abc123"
  };

  test("accepts outputs carrying mapUpdates on all five source-grounded jobs", () => {
    assert.equal(verifyDocumentOutputSchema.safeParse({ verdict: "healthy", claims: [], mapUpdates: [update] }).success, true);
    assert.equal(correctDocumentOutputSchema.safeParse({ markdown: "# d", rationale: "r", mapUpdates: [update] }).success, true);
    assert.equal(draftSeedDocumentOutputSchema.safeParse({ title: "t", targetPath: "p.md", markdown: "# d", rationale: "r", mapUpdates: [update] }).success, true);
    assert.equal(draftMarkdownProposalOutputSchema.safeParse({ title: "t", targetPath: "p.md", markdown: "# d", rationale: "r", mapUpdates: [update] }).success, true);
    assert.equal(improveDocumentOutputSchema.safeParse({ improved: false, rationale: "r", mapUpdates: [update] }).success, true);
    assert.equal(improveDocumentOutputSchema.safeParse({ improved: true, markdown: "# d", rationale: "r", mapUpdates: [update] }).success, true);
  });

  test("still accepts outputs without mapUpdates", () => {
    assert.equal(verifyDocumentOutputSchema.safeParse({ verdict: "healthy", claims: [] }).success, true);
  });

  test("rejects a mapUpdate missing its topic", () => {
    const { topic: _omitted, ...broken } = update;
    assert.equal(
      verifyDocumentOutputSchema.safeParse({ verdict: "healthy", claims: [], mapUpdates: [broken] }).success,
      false
    );
  });
});

test("draft outputs accept and preserve optional uncoveredPoints", () => {
  const base = { title: "T", targetPath: "t.md", markdown: "# T", rationale: "r" };
  // Absent stays valid (back-compat with providers that report nothing).
  assert.equal(draftMarkdownProposalOutputSchema.safeParse(base).success, true);
  assert.equal(draftSeedDocumentOutputSchema.safeParse(base).success, true);
  // Present round-trips.
  const gap = draftSeedDocumentOutputSchema.parse({ ...base, uncoveredPoints: ["refund SLAs"] });
  assert.deepEqual(gap.uncoveredPoints, ["refund SLAs"]);
  const draft = draftMarkdownProposalOutputSchema.parse({ ...base, uncoveredPoints: ["retry limits"] });
  assert.deepEqual(draft.uncoveredPoints, ["retry limits"]);
  // Malformed entries are rejected, not coerced.
  assert.equal(draftSeedDocumentOutputSchema.safeParse({ ...base, uncoveredPoints: [42] }).success, false);
});

test("draft output schemas keep the provenance field (broker-strip protection)", () => {
  const provenance = [
    {
      claim: "Logs are retained for 12 months",
      anchor: "log-retention",
      sources: [{ sourceId: "src-1", path: "docs/ops/logging.md", lines: "L10-L14" }]
    }
  ];
  const base = { title: "t", targetPath: "p.md", markdown: "# d", rationale: "r" };
  for (const schema of [draftMarkdownProposalOutputSchema, draftSeedDocumentOutputSchema]) {
    const parsed = schema.safeParse({ ...base, provenance });
    assert.ok(parsed.success);
    assert.deepEqual(parsed.success ? parsed.data.provenance : undefined, provenance);
    assert.ok(schema.safeParse(base).success, "provenance stays optional");
  }
});

test("provenance rejects a claim without sources array", () => {
  const base = { title: "t", targetPath: "p.md", markdown: "# d", rationale: "r" };
  assert.ok(
    !draftMarkdownProposalOutputSchema.safeParse({
      ...base,
      provenance: [{ claim: "c" }]
    }).success
  );
});
