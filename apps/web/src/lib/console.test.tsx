import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAttentionNotices,
  formatJobType,
  isActiveJob,
  jobResult,
  jobTransitionMessages,
  runPublishProposal,
  sectionSubtitle,
  sectionTitle
} from "./console";
import type { ConsoleSection, Health, JobType, JobView, KnowledgeStats, UiMessage, WatcherView } from "./types";

const now = "2026-06-30T12:00:00.000Z";

// Two fully-capable watchers, so tests that aren't about coverage trip neither the
// "no watchers"/"uncovered jobs" banners nor the single-watcher warning (which fires
// at exactly one connected watcher — see the maintenance-orchestrator note in
// buildAttentionNotices).
const readyFleet: WatcherView[] = [
  { name: "w1", status: "idle", capabilities: ["codex", "github", "local-git", "maintenance"], lastSeenAt: now },
  { name: "w2", status: "idle", capabilities: ["codex", "github", "local-git", "maintenance"], lastSeenAt: now }
];

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
  workers?: WatcherView[];
  uncoveredJobTypes?: JobType[];
}) {
  return buildAttentionNotices({
    health: input.health,
    jobs: input.jobs ?? [],
    stats: input.stats ?? fullStats,
    openSection: input.openSection ?? (() => undefined),
    workers: input.workers ?? readyFleet,
    uncoveredJobTypes: input.uncoveredJobTypes ?? []
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

test("buildAttentionNotices shows a concise notice when no watchers are connected", () => {
  const opened: ConsoleSection[] = [];
  const result = notices({
    health: { ok: true, service: "api" },
    workers: [],
    // With no watchers the API reports every type uncovered; the banner must NOT
    // dump the list — it collapses to a single "no watchers" notice.
    uncoveredJobTypes: ["answer_question", "publish_proposal"],
    openSection: (section) => opened.push(section)
  });
  const ids = result.map((n) => n.id);
  assert.deepEqual(ids, ["no-watchers"]);
  assert.equal(result[0].tone, "warning");
  result[0].action?.();
  assert.deepEqual(opened, ["jobs"]);
});

test("buildAttentionNotices warns when exactly one watcher is connected", () => {
  const opened: ConsoleSection[] = [];
  const result = notices({
    health: { ok: true, service: "api" },
    workers: [{ name: "solo", status: "idle", capabilities: ["codex", "github", "local-git", "maintenance"], lastSeenAt: now }],
    openSection: (section) => opened.push(section)
  });
  const notice = result.find((n) => n.id === "single-watcher");
  assert.ok(notice, "expected a single-watcher notice");
  assert.equal(notice.tone, "warning");
  notice.action?.();
  assert.deepEqual(opened, ["jobs"]);
});

test("buildAttentionNotices does not warn about a single watcher once a second connects", () => {
  const result = notices({ health: { ok: true, service: "api" }, workers: readyFleet });
  assert.equal(result.find((n) => n.id === "single-watcher"), undefined);
});

test("buildAttentionNotices shows the no-watchers notice, not the single-watcher one, when none are connected", () => {
  const result = notices({ health: { ok: true, service: "api" }, workers: [] });
  const ids = result.map((n) => n.id);
  assert.ok(ids.includes("no-watchers"));
  assert.equal(ids.includes("single-watcher"), false, "zero watchers is the no-watchers case, not single-watcher");
});

test("buildAttentionNotices lists uncovered job types when watchers run but miss a capability", () => {
  const result = notices({
    health: { ok: true, service: "api" },
    workers: readyFleet,
    uncoveredJobTypes: ["publish_proposal", "crosslink_pull_requests"]
  });
  const notice = result.find((n) => n.id === "uncovered-job-types");
  assert.ok(notice, "expected an uncovered-job-types notice");
  assert.equal(notice.tone, "danger");
  assert.match(notice.body, /Publish Proposal, Crosslink Pull Requests/);
});

test("buildAttentionNotices shows no coverage notice when the fleet covers everything", () => {
  const result = notices({ health: { ok: true, service: "api" }, workers: readyFleet, uncoveredJobTypes: [] });
  assert.equal(result.length, 0);
});

test("buildAttentionNotices appends the coverage notice after failed jobs", () => {
  const result = notices({
    health: { ok: false, service: "api" },
    stats: { repositoryCount: 0, documentCount: 0, sectionCount: 0 },
    jobs: [job({ id: "a", state: "created" }), job({ id: "f", state: "failed" })],
    workers: readyFleet,
    uncoveredJobTypes: ["publish_proposal"]
  });
  assert.deepEqual(
    result.map((notice) => notice.id),
    ["api-offline", "empty-knowledge", "queue-waiting", "failed-jobs", "uncovered-job-types"]
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
    "seed",
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

// Regression: the outline path read job.output.items, but a completed job's output
// is the envelope { result, executor } — the payload lives under `result`. Reading
// the wrong level silently returned undefined, so seed outlines never showed docs.
test("jobResult unwraps the { result, executor } envelope, not job.output directly", () => {
  const items = [{ title: "Aggregation Types", coverage: ["sum", "count"] }];
  const completed = job({
    id: "j1",
    type: "outline_flow_seed",
    output: { result: { items, rationale: "why" }, executor: "watcher-1" }
  });
  const payload = jobResult<{ items?: typeof items }>(completed);
  assert.deepEqual(payload?.items, items, "items must come from output.result, not output");

  // The pre-fix bug: reading the top level yields nothing.
  assert.equal((completed.output as { items?: unknown }).items, undefined);
});

test("jobResult returns undefined when the job has no output yet", () => {
  assert.equal(jobResult(job({ id: "j2", state: "active", output: undefined })), undefined);
});

// Publication is enqueue-only and must stay fire-and-forget in the console: one
// POST, a "queued" message, a refresh — no navigation away from the proposal and
// no long-poll on /jobs/:id/wait holding the global loading flag for up to 25s.
function publishHarness(response: { job?: JobView }) {
  const apiCalls: Array<{ path: string; body: unknown }> = [];
  const messages: Array<Pick<UiMessage, "text" | "tone">> = [];
  const refreshes: Array<{ preserveMessage: boolean }> = [];
  const deps = {
    apiPost: async (path: string, body: unknown) => {
      apiCalls.push({ path, body });
      return response;
    },
    showMessage: (text: string, tone: UiMessage["tone"]) => {
      messages.push({ text, tone });
    },
    refresh: async (options: { preserveMessage: boolean }) => {
      refreshes.push(options);
    }
  };
  return { deps, apiCalls, messages, refreshes };
}

test("runPublishProposal enqueues once, reports the queued job, and refreshes in place", async () => {
  const queued = job({ id: "pub-1", type: "publish_proposal", state: "created" });
  const { deps, apiCalls, messages, refreshes } = publishHarness({ job: queued });

  await runPublishProposal(deps, "p1");

  // Exactly one API call: the enqueue. No follow-up /jobs/:id/wait long-poll.
  assert.deepEqual(apiCalls, [{ path: "/proposals/p1/publish", body: {} }]);
  assert.deepEqual(messages, [
    { text: "Publish Proposal queued. This page will update when it finishes.", tone: "info" }
  ]);
  assert.deepEqual(refreshes, [{ preserveMessage: true }]);
});

test("runPublishProposal still refreshes when the API returns no job", async () => {
  const { deps, messages, refreshes } = publishHarness({});

  await runPublishProposal(deps, "p1");

  assert.deepEqual(messages, []);
  assert.deepEqual(refreshes, [{ preserveMessage: true }]);
});

test("runPublishProposal propagates API errors without refreshing", async () => {
  const refreshes: Array<{ preserveMessage: boolean }> = [];
  const deps = {
    apiPost: async () => {
      throw new Error("publish rejected");
    },
    showMessage: () => undefined,
    refresh: async (options: { preserveMessage: boolean }) => {
      refreshes.push(options);
    }
  };

  await assert.rejects(runPublishProposal(deps, "p1"), /publish rejected/);
  assert.deepEqual(refreshes, []);
});
