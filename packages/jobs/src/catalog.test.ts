import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_PROVIDERS,
  JOB_TYPES,
  allQueueDefinitions,
  answerQuestionInputSchema,
  answerQuestionOutputSchema,
  correctDocumentInputSchema,
  crosslinkPullRequestsInputSchema,
  draftMarkdownProposalInputSchema,
  draftSeedDocumentInputSchema,
  improveDocumentInputSchema,
  jobDefinition,
  jobTypesForCapability,
  jobTypesWithoutCapabilities,
  queueNameForJob,
  queueNamesForCapabilities,
  verifyDocumentInputSchema
} from "./index.js";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const FOURTEEN_DAYS_SECONDS = 14 * 24 * 60 * 60;
const EXPIRATION_SECONDS = {
  answer_question: 5 * 60,
  summarize_gap: 10 * 60,
  draft_markdown_proposal: 15 * 60,
  draft_seed_document: 15 * 60,
  outline_flow_seed: 10 * 60,
  detect_contradiction: 10 * 60,
  suggest_consolidation: 10 * 60,
  reconcile_gap_clusters: 5 * 60,
  sync_source_changes_generate_plan: 60 * 60,
  verify_document: 15 * 60,
  correct_document: 15 * 60,
  dedupe_documents: 10 * 60,
  split_document: 10 * 60,
  improve_document: 15 * 60,
  fold_changeset_proposal: 15 * 60,
  refresh_flow_snapshot: 5 * 60,
  process_gaps_to_pull_requests: 60 * 60,
  source_change_sync: 60 * 60,
  correctness_patrol: 60 * 60,
  editorial_patrol: 60 * 60,
  verify_gap_closure: 60 * 60,
  publish_proposal: 15 * 60,
  crosslink_pull_requests: 10 * 60,
  fold_markdown_proposal: 15 * 60,
  comment_pull_request: 10 * 60
} as const;

test("every job type is unique and has schemas and a valid policy", () => {
  assert.equal(new Set(JOB_TYPES).size, JOB_TYPES.length);

  for (const type of JOB_TYPES) {
    const definition = jobDefinition(type);
    assert.equal(definition.type, type);
    assert.equal(typeof definition.inputSchema.safeParse, "function");
    assert.equal(typeof definition.outputSchema.safeParse, "function");
    assert.equal(definition.policy.heartbeatSeconds, 60);
    assert.equal(definition.policy.retentionSeconds, FOURTEEN_DAYS_SECONDS);
    assert.equal(definition.policy.expireInSeconds, EXPIRATION_SECONDS[type]);
    assert.ok(definition.policy.expireInSeconds > definition.policy.heartbeatSeconds);
    assert.equal(definition.policy.deleteAfterSeconds, THIRTY_DAYS_SECONDS);
    assert.equal(definition.policy.retryBackoff, true);
  }
});

test("provider work retries three times and non-provider work retries twice", () => {
  for (const type of ["answer_question", "reconcile_gap_clusters"] as const) {
    const policy = jobDefinition(type).policy;
    assert.equal(policy.retryLimit, 3);
    assert.equal(policy.retryDelay, 15);
    assert.equal(policy.retryDelayMax, 300);
  }
  for (const type of ["process_gaps_to_pull_requests", "refresh_flow_snapshot"] as const) {
    const policy = jobDefinition(type).policy;
    assert.equal(policy.retryLimit, 2);
    assert.equal(policy.retryDelay, 30);
    assert.equal(policy.retryDelayMax, 600);
  }
});

test("codex capability can only claim codex-partitioned AI work", () => {
  const definition = jobDefinition("answer_question");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(definition.queueName({ provider: "codex" }), "answer_question__codex");

  const queues = queueNamesForCapabilities(["codex"]);

  assert.ok(queues.includes("answer_question__codex"));
  assert.ok(!queues.includes("answer_question__openai_compatible"));
  assert.equal(queueNameForJob("answer_question", { provider: "codex" }), "answer_question__codex");
});

test("github capability yields only GitHub work queues", () => {
  assert.deepEqual(queueNamesForCapabilities(["github"]), [
    "refresh_flow_snapshot",
    "publish_proposal__github",
    "crosslink_pull_requests",
    "comment_pull_request"
  ]);
});

test("local-git capability yields only the local-git publish queue", () => {
  assert.deepEqual(queueNamesForCapabilities(["local-git"]), ["publish_proposal__local_git"]);
});

test("publish_proposal routes by destination and defaults to github", () => {
  const definition = jobDefinition("publish_proposal");
  assert.deepEqual([...definition.capabilities], ["github", "local-git"]);
  assert.equal(definition.requiredCapability({ proposalId: "p", destination: "local-git" }), "local-git");
  assert.equal(definition.requiredCapability({ proposalId: "p", destination: "github" }), "github");
  // Legacy enqueues that omit destination fall back to github.
  assert.equal(definition.requiredCapability({ proposalId: "p" }), "github");
  assert.equal(queueNameForJob("publish_proposal", { proposalId: "p", destination: "local-git" }), "publish_proposal__local_git");
  assert.equal(queueNameForJob("publish_proposal", { proposalId: "p" }), "publish_proposal__github");
  // An unknown destination is rejected rather than silently defaulted.
  assert.throws(() => queueNameForJob("publish_proposal", { proposalId: "p", destination: "gitlab" as never }), /destination/i);
});

test("jobTypesForCapability and jobTypesWithoutCapabilities reflect the catalog", () => {
  assert.ok(jobTypesForCapability("local-git").includes("publish_proposal"));
  assert.ok(jobTypesForCapability("github").includes("publish_proposal"));
  assert.ok(jobTypesForCapability("maintenance").includes("source_change_sync"));

  // publish_proposal is covered by github OR local-git; a fleet with neither leaves it uncovered.
  assert.ok(!jobTypesWithoutCapabilities(["local-git", "maintenance", "codex"]).includes("publish_proposal"));
  assert.ok(jobTypesWithoutCapabilities(["maintenance"]).includes("publish_proposal"));
  // A full fleet covers everything.
  assert.deepEqual(jobTypesWithoutCapabilities([...AI_PROVIDERS, "github", "local-git", "maintenance"]), []);
  // An empty fleet covers nothing.
  assert.equal(jobTypesWithoutCapabilities([]).length, JOB_TYPES.length);
});

test("maintenance capability yields only orchestration work queues", () => {
  assert.deepEqual(queueNamesForCapabilities(["maintenance"]), [
    "process_gaps_to_pull_requests",
    "source_change_sync",
    "correctness_patrol",
    "editorial_patrol",
    "verify_gap_closure"
  ]);
});

test("verify_gap_closure is a maintenance job with an unpartitioned queue name", () => {
  const definition = jobDefinition("verify_gap_closure");
  assert.deepEqual([...definition.capabilities], ["maintenance"]);
  assert.equal(definition.requiredCapability({ proposalId: "p1" }), "maintenance");
  assert.equal(definition.queueName({ proposalId: "p1" }), "verify_gap_closure");
  assert.deepEqual(definition.inputSchema.parse({ proposalId: "p1" }), { proposalId: "p1" });
  assert.equal(definition.policy.retryLimit, 2);
});

test("reconcile_gap_clusters routes by provider like other AI work", () => {
  const definition = jobDefinition("reconcile_gap_clusters");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("reconcile_gap_clusters", { provider: "codex" }), "reconcile_gap_clusters__codex");

  const codexQueues = queueNamesForCapabilities(["codex"]);
  assert.ok(codexQueues.includes("reconcile_gap_clusters__codex"));
  const githubQueues = queueNamesForCapabilities(["github"]);
  assert.ok(!githubQueues.includes("reconcile_gap_clusters__codex"));
});

test("sync_source_changes_generate_plan routes by provider", () => {
  assert.equal(
    queueNameForJob("sync_source_changes_generate_plan", { provider: "claude" }),
    "sync_source_changes_generate_plan__claude"
  );
  const claudeQueues = queueNamesForCapabilities(["claude"]);
  assert.ok(claudeQueues.includes("sync_source_changes_generate_plan__claude"));
});

test("verify_document routes by provider like other AI work", () => {
  const definition = jobDefinition("verify_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("verify_document", { provider: "codex" }), "verify_document__codex");
  const codexQueues = queueNamesForCapabilities(["codex"]);
  assert.ok(codexQueues.includes("verify_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("verify_document__codex"));
});

test("correct_document routes by provider like other AI work", () => {
  const definition = jobDefinition("correct_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("correct_document", { provider: "codex" }), "correct_document__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("correct_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("correct_document__codex"));
});

test("draft_seed_document routes by provider like other AI work", () => {
  const definition = jobDefinition("draft_seed_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("draft_seed_document", { provider: "codex" }), "draft_seed_document__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("draft_seed_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("draft_seed_document__codex"));
});

test("outline_flow_seed routes by provider like other AI work", () => {
  const definition = jobDefinition("outline_flow_seed");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("outline_flow_seed", { provider: "codex" }), "outline_flow_seed__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("outline_flow_seed__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("outline_flow_seed__codex"));
});

test("dedupe_documents routes by provider like other AI work", () => {
  const definition = jobDefinition("dedupe_documents");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("dedupe_documents", { provider: "codex" }), "dedupe_documents__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("dedupe_documents__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("dedupe_documents__codex"));
});

test("split_document routes by provider like other AI work", () => {
  const definition = jobDefinition("split_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("split_document", { provider: "codex" }), "split_document__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("split_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("split_document__codex"));
});

test("improve_document routes by provider like other AI work", () => {
  const definition = jobDefinition("improve_document");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("improve_document", { provider: "codex" }), "improve_document__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("improve_document__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("improve_document__codex"));
});

test("fold_changeset_proposal routes by provider like other AI work", () => {
  const definition = jobDefinition("fold_changeset_proposal");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("fold_changeset_proposal", { provider: "codex" }), "fold_changeset_proposal__codex");
  assert.ok(queueNamesForCapabilities(["codex"]).includes("fold_changeset_proposal__codex"));
  assert.ok(!queueNamesForCapabilities(["github"]).includes("fold_changeset_proposal__codex"));
});

test("source_change_sync is a maintenance queue named by its type", () => {
  const definition = jobDefinition("source_change_sync");
  assert.equal(definition.requiredCapability({}), "maintenance");
  assert.equal(queueNameForJob("source_change_sync", {}), "source_change_sync");
});

test("process_gaps_to_pull_requests requires a flowId but stays on the maintenance queue", () => {
  const definition = jobDefinition("process_gaps_to_pull_requests");
  assert.equal(definition.requiredCapability({ flowId: "billing" }), "maintenance");
  assert.equal(queueNameForJob("process_gaps_to_pull_requests", { flowId: "billing" }), "process_gaps_to_pull_requests");
  assert.ok(!definition.inputSchema.safeParse({}).success);
  assert.ok(definition.inputSchema.safeParse({ flowId: "billing" }).success);
});

test("correctness_patrol is a maintenance queue named by its type", () => {
  const definition = jobDefinition("correctness_patrol");
  assert.equal(definition.requiredCapability({ flowId: "billing" }), "maintenance");
  assert.equal(queueNameForJob("correctness_patrol", { flowId: "billing" }), "correctness_patrol");
});

test("correctness_patrol input accepts an optional flowId; output carries runId + selectedCount + findingCount", () => {
  assert.ok(jobDefinition("correctness_patrol").inputSchema.safeParse({}).success);
  assert.ok(jobDefinition("correctness_patrol").inputSchema.safeParse({ flowId: "billing" }).success);
  assert.ok(jobDefinition("correctness_patrol").outputSchema.safeParse({ runId: "r1", selectedCount: 3, findingCount: 1 }).success);
  assert.ok(!jobDefinition("correctness_patrol").outputSchema.safeParse({ runId: "r1", selectedCount: 3 }).success);
});

test("editorial_patrol is a maintenance queue whose output reports enqueued improve scans", () => {
  const definition = jobDefinition("editorial_patrol");
  assert.equal(definition.requiredCapability({ flowId: "billing" }), "maintenance");
  assert.equal(queueNameForJob("editorial_patrol", { flowId: "billing" }), "editorial_patrol");
  assert.ok(definition.inputSchema.safeParse({}).success);
  assert.ok(definition.inputSchema.safeParse({ flowId: "billing" }).success);
  assert.ok(definition.outputSchema.safeParse({ runId: "r1", selectedCount: 2, enqueuedCount: 2 }).success);
  assert.ok(!definition.outputSchema.safeParse({ runId: "r1", selectedCount: 2 }).success);
});

test("source_change_sync output reports the run ids it created (0..N)", () => {
  const schema = jobDefinition("source_change_sync").outputSchema;
  assert.ok(schema.safeParse({ runIds: [] }).success, "empty run set is valid");
  assert.ok(schema.safeParse({ runIds: ["run-1", "run-2"] }).success, "multiple runs are valid");
  // The legacy {runId, planned} shape is gone; runIds is required.
  assert.ok(!schema.safeParse({ planned: true }).success, "missing runIds is rejected");
});

test("publish_source_sync is retired", () => {
  assert.equal(JOB_TYPES.includes("publish_source_sync" as never), false);
});

test("all queue definitions provision every AI provider partition and a dead-letter queue", () => {
  const queueDefinitions = allQueueDefinitions();
  for (const provider of AI_PROVIDERS) {
    const queueName = queueNameForJob("answer_question", { provider });
    const definition = queueDefinitions.find((candidate) => candidate.name === queueName);
    assert.ok(definition);
    assert.equal(definition.capability, provider);
    assert.equal(definition.deadLetter, false);
    assert.ok(definition.policy?.deadLetter);
    assert.ok(
      queueDefinitions.some(
        (candidate) => candidate.name === definition.policy?.deadLetter && candidate.deadLetter
      )
    );
  }

  const claimable = queueNamesForCapabilities([...AI_PROVIDERS, "github", "maintenance"]);
  assert.ok(claimable.every((name) => !name.endsWith("__dead_letter")));
});

test("every concrete work and dead-letter queue name is unique", () => {
  const names = allQueueDefinitions().map((definition) => definition.name);
  assert.equal(new Set(names).size, names.length);
});

test("answer_question input carries routing flows, not pre-retrieved context", () => {
  const valid = answerQuestionInputSchema.safeParse({
    provider: "openai-compatible",
    questionLogId: "log-1",
    question: "How do I configure X?",
    flows: [{ id: "flow-1", name: "Support", persona: "You are helpful" }, { id: "flow-2", name: "Eng" }],
    expectedOutput: "answer_result"
  });
  assert.ok(valid.success, "flows-based input should be accepted");

  const emptyFlows = answerQuestionInputSchema.safeParse({
    provider: "openai-compatible",
    question: "q",
    flows: [],
    expectedOutput: "answer_result"
  });
  assert.ok(emptyFlows.success, "empty flows should be accepted");

  const legacy = answerQuestionInputSchema.safeParse({
    provider: "openai-compatible",
    question: "q",
    context: [{ sectionId: "s", path: "p", heading: "h", content: "c" }],
    expectedOutput: "answer_result"
  });
  assert.ok(!legacy.success, "the old context-array input should be rejected (flows missing)");
});

test("answer_question output may record the routed flowId", () => {
  const withFlow = answerQuestionOutputSchema.safeParse({
    answer: "A",
    confidence: "high",
    citations: [],
    flowId: "flow-1"
  });
  assert.ok(withFlow.success, "flowId should be accepted on output");

  const withoutFlow = answerQuestionOutputSchema.safeParse({
    answer: "A",
    confidence: "high",
    citations: []
  });
  assert.ok(withoutFlow.success, "flowId is optional on output");
});

test("answer_question output may carry the watcher's answer trace", () => {
  const withTrace = answerQuestionOutputSchema.safeParse({
    answer: "A",
    confidence: "low",
    citations: [],
    trace: {
      routing: { mode: "routed", flowId: "flow-1", confidence: "high" },
      seedSectionCount: 3,
      searches: [{ query: "SOC 2", resultCount: 0, round: 1 }],
      poolSectionCount: 3,
      answerForced: false,
      answerContract: "structured",
      verification: { status: "claims_stripped", unsupportedClaims: ["SOC 2 compliance status"] }
    }
  });
  assert.ok(withTrace.success, "a full trace should be accepted on output");
  // zod strips undeclared keys, so acceptance here is what keeps the trace
  // alive through completion validation all the way to the question log.
  assert.ok(
    withTrace.success && withTrace.data.trace?.searches[0]?.resultCount === 0,
    "the trace survives parsing intact"
  );

  const withoutTrace = answerQuestionOutputSchema.safeParse({
    answer: "A",
    confidence: "high",
    citations: []
  });
  assert.ok(withoutTrace.success, "trace is optional on output");
});

test("queue naming rejects a missing or invalid AI provider", () => {
  assert.throws(() => queueNameForJob("answer_question", {}), /provider/i);
  assert.throws(
    () => queueNameForJob("answer_question", { provider: "mock" as never }),
    /provider/i
  );
});

test("crosslink_pull_requests is a registered github job", () => {
  assert.ok(JOB_TYPES.includes("crosslink_pull_requests"));
  const def = jobDefinition("crosslink_pull_requests");
  assert.equal(def.requiredCapability({}), "github");
});

test("crosslink input schema requires exactly two pull requests", () => {
  const ok = crosslinkPullRequestsInputSchema.safeParse({
    targets: ["kb/a.md"],
    pullRequests: [
      { proposalId: "p1", pullRequestUrl: "https://github.com/o/r/pull/1" },
      { proposalId: "p2", pullRequestUrl: "https://github.com/o/r/pull/2" }
    ]
  });
  assert.equal(ok.success, true);
  const bad = crosslinkPullRequestsInputSchema.safeParse({
    targets: ["kb/a.md"],
    pullRequests: [{ proposalId: "p1", pullRequestUrl: "u" }]
  });
  assert.equal(bad.success, false);
});

test("draft_seed_document input carries source descriptors, not inline content", () => {
  const input = {
    provider: "openai-compatible",
    flowId: "flow-1",
    coverage: ["how statements are ingested"],
    sources: [
      { id: "src-1", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" },
      { id: "src-2", name: "Local notes", kind: "local", path: "/srv/notes" },
      { id: "src-3", name: "Vendor site", kind: "internet", url: "https://vendor.example" },
      { id: "src-4", name: "Agent knowledge", kind: "agent" }
    ]
  };
  assert.equal(draftSeedDocumentInputSchema.safeParse(input).success, true);
  const legacy = { provider: "openai-compatible", flowId: "flow-1", coverage: ["x"], sourceContext: [] };
  assert.equal(draftSeedDocumentInputSchema.safeParse(legacy).success, false);
});

test("draft_markdown_proposal input carries source descriptors, not inline content", () => {
  const input = {
    provider: "openai-compatible",
    gapSummaries: ["how refunds are processed"],
    triggeringQuestions: ["What is the refund window?"],
    evidence: [],
    sources: [
      { id: "src-1", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" },
      { id: "src-2", name: "Agent knowledge", kind: "agent" }
    ],
    expectedOutput: "markdown_proposal"
  };
  assert.equal(draftMarkdownProposalInputSchema.safeParse(input).success, true);
  const legacy = {
    provider: "openai-compatible",
    gapSummaries: ["x"],
    triggeringQuestions: [],
    evidence: [],
    sourceContext: [],
    expectedOutput: "markdown_proposal"
  };
  assert.equal(draftMarkdownProposalInputSchema.safeParse(legacy).success, false);
});

test("patrol child-job inputs carry source descriptors, not a corpus ref", () => {
  const sources = [
    { id: "src-1", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" },
    { id: "src-2", name: "Agent knowledge", kind: "agent" }
  ];
  const verify = { provider: "openai-compatible", path: "kb/a.md", content: "# A", sources };
  const correct = {
    provider: "openai-compatible",
    path: "kb/a.md",
    content: "# A",
    claims: [{ claim: "x", reason: "y" }],
    sources
  };
  const improve = { provider: "openai-compatible", path: "kb/a.md", content: "# A", sources };
  assert.equal(verifyDocumentInputSchema.safeParse(verify).success, true);
  assert.equal(correctDocumentInputSchema.safeParse(correct).success, true);
  assert.equal(improveDocumentInputSchema.safeParse(improve).success, true);
  // The pre-migration inputs carried a corpus-ref string instead of a sources
  // array; anything without `sources` is rejected regardless of extra keys.
  const legacy = { provider: "openai-compatible", path: "kb/a.md", content: "# A" };
  assert.equal(verifyDocumentInputSchema.safeParse(legacy).success, false);
  assert.equal(improveDocumentInputSchema.safeParse(legacy).success, false);
  // With claims present the only thing missing is `sources`, so this rejection
  // pins the sources requirement specifically.
  const legacyCorrect = { ...legacy, claims: [{ claim: "x", reason: "y" }] };
  assert.equal(correctDocumentInputSchema.safeParse(legacyCorrect).success, false);
});

test("fold_markdown_proposal is a provider AI job; comment_pull_request is github", () => {
  assert.ok(JOB_TYPES.includes("fold_markdown_proposal"));
  assert.ok(JOB_TYPES.includes("comment_pull_request"));
  assert.equal(jobDefinition("fold_markdown_proposal").requiredCapability({ provider: "codex" }), "codex");
  assert.equal(queueNameForJob("fold_markdown_proposal", { provider: "codex" }), "fold_markdown_proposal__codex");
  assert.equal(jobDefinition("comment_pull_request").requiredCapability({}), "github");
});
