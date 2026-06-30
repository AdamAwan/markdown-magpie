import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAttentionNotices,
  formatJobType,
  isActiveJob,
  jobTransitionMessages,
  sectionSubtitle,
  sectionTitle
} from "./console";
import type { ConsoleSection, Health, JobView, KnowledgeStats } from "./types";

const now = "2026-06-30T12:00:00.000Z";

function job(overrides: Partial<JobView> & Pick<JobView, "id">): JobView {
  const { id, ...rest } = overrides;
  return {
    id,
    type: "answer_question",
    queueName: "ai:codex",
    deadLetter: false,
    state: "completed",
    input: {},
    retryCount: 0,
    retryLimit: 3,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    expireInSeconds: 300,
    ...rest
  };
}

const fullStats: KnowledgeStats = { repositoryCount: 2, documentCount: 10, sectionCount: 5 };

function notices(input: {
  health?: Health;
  jobs?: JobView[];
  stats?: KnowledgeStats;
  openSection?: (section: ConsoleSection) => void;
}) {
  return buildAttentionNotices({
    health: input.health,
    jobs: input.jobs ?? [],
    stats: input.stats ?? fullStats,
    openSection: input.openSection ?? (() => undefined)
  });
}

test("buildAttentionNotices returns nothing when everything is healthy", () => {
  assert.deepEqual(notices({ health: { ok: true, service: "api" } }), []);
});

test("buildAttentionNotices reports an offline API as a danger notice", () => {
  const result = notices({ health: { ok: false, service: "api" } });
  assert.deepEqual(
    result.map((notice) => ({ id: notice.id, tone: notice.tone })),
    [{ id: "api-offline", tone: "danger" }]
  );
});

test("buildAttentionNotices warns when no knowledge is indexed and wires its action", () => {
  const opened: ConsoleSection[] = [];
  const [notice] = notices({
    stats: { repositoryCount: 0, documentCount: 0, sectionCount: 0 },
    openSection: (section) => opened.push(section)
  });

  assert.equal(notice.id, "empty-knowledge");
  assert.equal(notice.tone, "warning");
  notice.action?.();
  assert.deepEqual(opened, ["knowledge"]);
});

test("buildAttentionNotices counts active jobs and pluralizes correctly", () => {
  const one = notices({ jobs: [job({ id: "a", state: "created" })] }).find((n) => n.id === "queue-waiting");
  assert.equal(one?.title, "1 queued job waiting");

  const many = notices({
    jobs: [job({ id: "a", state: "created" }), job({ id: "b", state: "active" })]
  }).find((n) => n.id === "queue-waiting");
  assert.equal(many?.title, "2 queued jobs waiting");
});

test("buildAttentionNotices flags failed jobs but ignores accepted failures", () => {
  const result = notices({
    jobs: [
      job({ id: "f1", state: "failed" }),
      job({ id: "f2", state: "failed", acceptedAt: now }) // accepted: must not count
    ]
  });
  const failed = result.find((notice) => notice.id === "failed-jobs");
  assert.equal(failed?.title, "1 AI job failed");
});

test("buildAttentionNotices preserves a stable notice order", () => {
  const result = notices({
    health: { ok: false, service: "api" },
    stats: { repositoryCount: 0, documentCount: 0, sectionCount: 0 },
    jobs: [job({ id: "a", state: "created" }), job({ id: "f", state: "failed" })]
  });
  assert.deepEqual(
    result.map((notice) => notice.id),
    ["api-offline", "empty-knowledge", "queue-waiting", "failed-jobs"]
  );
});

test("isActiveJob is true only for non-terminal states", () => {
  for (const state of ["created", "retry", "active", "blocked"] as const) {
    assert.equal(isActiveJob(job({ id: state, state })), true, `${state} should be active`);
  }
  for (const state of ["completed", "failed", "cancelled"] as const) {
    assert.equal(isActiveJob(job({ id: state, state })), false, `${state} should be terminal`);
  }
});

test("jobTransitionMessages reports active jobs that became completed or failed", () => {
  const previous = [job({ id: "1", state: "active", type: "answer_question" })];
  const next = [job({ id: "1", state: "completed", type: "answer_question" })];

  assert.deepEqual(jobTransitionMessages(previous, next), [
    { text: "Answer Question completed.", tone: "success" }
  ]);

  const failedNext = [job({ id: "1", state: "failed", type: "draft_markdown_proposal" })];
  assert.deepEqual(jobTransitionMessages(previous, failedNext), [
    { text: "Draft Markdown Proposal failed. Open Jobs for details.", tone: "danger" }
  ]);
});

test("jobTransitionMessages ignores jobs that were not previously active", () => {
  // A job already terminal in the previous snapshot produces no message.
  const previous = [job({ id: "1", state: "completed" })];
  const next = [job({ id: "1", state: "failed" })];
  assert.deepEqual(jobTransitionMessages(previous, next), []);
});

test("jobTransitionMessages ignores unchanged states and brand-new jobs", () => {
  const previous = [job({ id: "1", state: "active" })];
  const unchanged = [job({ id: "1", state: "active" })];
  assert.deepEqual(jobTransitionMessages(previous, unchanged), []);

  // A job with no prior snapshot entry is not a transition.
  assert.deepEqual(jobTransitionMessages([], [job({ id: "new", state: "completed" })]), []);
});

test("jobTransitionMessages produces no message for non-terminal transitions", () => {
  const previous = [job({ id: "1", state: "created" })];
  const next = [job({ id: "1", state: "active" })];
  assert.deepEqual(jobTransitionMessages(previous, next), []);
});

test("formatJobType title-cases underscore-delimited types", () => {
  assert.equal(formatJobType("answer_question"), "Answer Question");
  assert.equal(formatJobType("draft_markdown_proposal"), "Draft Markdown Proposal");
  // Repeated and trailing underscores yield empty segments that must be dropped.
  assert.equal(formatJobType("sync__source_"), "Sync Source");
  assert.equal(formatJobType(""), "");
});

test("section copy is defined for every section with a distinct default", () => {
  const sections: ConsoleSection[] = [
    "ask",
    "knowledge",
    "gaps",
    "jobs",
    "proposals",
    "activity",
    "schedules",
    "prompts",
    "config",
    "dataflow",
    "mcp"
  ];
  for (const section of sections) {
    assert.ok(sectionTitle(section).length > 0, `${section} needs a title`);
    assert.ok(sectionSubtitle(section).length > 0, `${section} needs a subtitle`);
  }
  // "ask" is the default branch in both helpers.
  assert.equal(sectionTitle("ask"), "Ask and inspect cited answers");
  assert.equal(sectionTitle("knowledge"), "Manage knowledge flows");
});
