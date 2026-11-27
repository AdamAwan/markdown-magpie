import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mountConsole, type MountedConsole } from "../test/console";
import { act } from "react";
import AskPage from "../app/ask/page";
import type { JobView, QuestionLog } from "../lib/types";
import { changeValue, closeDom } from "../test/dom";
import { FakeApiError, deferred, type RouteHandler } from "../test/fakeApi";
import { configFixture, documentFixture, gapFixture, jobFixture, questionFixture } from "../test/fixtures";
import { renderMarkup } from "../test/render";
import { useConsole } from "./ConsoleProvider";
import { OTHER_DOCUMENTS_ID } from "./KnowledgePanel";

after(closeDom);

// Mounts the real provider over the fake API and guarantees teardown (fetch
// restored, timers unmocked) even when the test body throws.
async function mount(t: TestContext, options: Parameters<typeof mountConsole>[0] = {}): Promise<MountedConsole> {
  const mounted = await mountConsole(options);
  t.after(() => mounted.unmount());
  return mounted;
}

function texts(mounted: MountedConsole): string[] {
  return mounted.console().notifications.map((notification) => notification.text);
}

function proposal(id: string, status = "draft") {
  return { id, title: `Proposal ${id}`, status, targetPath: `${id}.md`, markdown: "# Draft", evidence: [] };
}

// --- mount / refresh --------------------------------------------------------

test("mount loads both tiers and derives the default document, flow and source map", async (t) => {
  const documents = [documentFixture({ id: "doc-a" }), documentFixture({ id: "doc-b", path: "b.md" })];
  const m = await mount(t, {
    routes: {
      "GET /knowledge/stats": () => ({ repositoryCount: 2, documentCount: 2, sectionCount: 14 }),
      "GET /questions": () => ({ questions: [questionFixture()], total: 40, matching: 17 }),
      "GET /knowledge/documents": () => ({ documents, total: 2 }),
      "GET /config": () => configFixture(),
      "GET /source-map": () => ({ entries: [{ sourceId: "product-repo" }] })
    }
  });
  const state = m.console();

  assert.equal(state.health?.ok, true);
  assert.equal(state.stats.sectionCount, 14);
  // total is the sidebar backlog; the pager walks `matching` in pages of 8.
  assert.equal(state.questionsTotal, 40);
  assert.equal(state.questionsMatching, 17);
  assert.equal(state.questionsPageCount, 3);
  assert.equal(state.selectedDocumentId, "doc-a");
  // The empty default flow reconciles to the first configured flow once config lands.
  assert.equal(state.flowId, "billing");
  assert.equal(state.sourceMapEntries.length, 1);
  assert.equal(state.refreshing, false);
  assert.ok(state.lastRefreshedAt);
  assert.deepEqual(state.notifications, []);

  assert.equal(m.api.calls("GET", "/questions")[0].search, "?limit=8&offset=0");
  assert.equal(m.api.calls("GET", "/knowledge/documents")[0].search, "?limit=200");
  assert.equal(m.api.calls("GET", "/source-map")[0].search, "?sourceIds=product-repo,crawler");
});

test("a failing mount refresh raises a danger toast that expires while the feed keeps it", async (t) => {
  const m = await mount(t, {
    routes: {
      "GET /health": () => {
        throw new FakeApiError(503, "API is down");
      }
    }
  });

  assert.deepEqual(texts(m), ["API is down"]);
  assert.equal(m.console().notifications[0].tone, "danger");
  assert.equal(m.console().toasts.length, 1);
  // The whole fast tier is dropped on a failed request — no half-applied state.
  assert.equal(m.console().health, undefined);
  assert.equal(m.console().refreshing, false);

  await m.tick(9_999);
  assert.equal(m.console().toasts.length, 1);
  await m.tick(1);
  assert.equal(m.console().toasts.length, 0);
  assert.equal(m.console().notifications.length, 1);
});

test("a refresh superseded mid-flight never overwrites the newer refresh's state", async (t) => {
  const m = await mount(t);
  const slow = deferred<{ repositoryCount: number; documentCount: number; sectionCount: number }>();
  m.api.on("GET /knowledge/stats", () => slow.promise);

  // Refresh A hangs on /knowledge/stats…
  act(() => {
    void m.console().refresh();
  });
  // …and refresh B starts and finishes while A is still in flight.
  m.api.on("GET /knowledge/stats", () => ({ repositoryCount: 2, documentCount: 2, sectionCount: 222 }));
  await act(async () => {
    await m.console().refresh();
  });
  assert.equal(m.console().stats.sectionCount, 222);

  slow.resolve({ repositoryCount: 1, documentCount: 1, sectionCount: 111 });
  await m.settle();

  assert.equal(m.console().stats.sectionCount, 222);
  assert.equal(m.console().refreshing, false);
  // The aborted refresh is expected and must not surface as an error.
  assert.deepEqual(texts(m), []);
});

test("an unknown selected flow resets to the first configured flow, but Other documents is kept", async (t) => {
  const m = await mount(t, { routes: { "GET /config": () => configFixture() } });

  await m.run(() => m.console().setFlowId("retired-flow"));
  assert.equal(m.console().flowId, "billing");

  await m.run(() => m.console().setFlowId(OTHER_DOCUMENTS_ID));
  assert.equal(m.console().flowId, OTHER_DOCUMENTS_ID);
});

test("the slow tier keeps the selected document while it exists and falls back when it is removed", async (t) => {
  let documents = [documentFixture({ id: "doc-a" }), documentFixture({ id: "doc-b" })];
  const m = await mount(t, { routes: { "GET /knowledge/documents": () => ({ documents, total: documents.length }) } });

  await m.run(() => m.console().setSelectedDocumentId("doc-b"));
  await m.run(() => m.console().refresh());
  assert.equal(m.console().selectedDocumentId, "doc-b");

  documents = [documentFixture({ id: "doc-a" })];
  await m.run(() => m.console().refresh());
  assert.equal(m.console().selectedDocumentId, "doc-a");
});

test("useConsole throws outside a ConsoleProvider", () => {
  function Orphan() {
    useConsole();
    return null;
  }
  assert.throws(() => renderMarkup(<Orphan />), /useConsole must be used within a ConsoleProvider/);
});

// --- polling ----------------------------------------------------------------

test("with no active job only the slow tier polls, on its own 30s timer", async (t) => {
  const m = await mount(t);

  await m.tick(4_000);
  assert.equal(m.api.calls("GET", "/jobs").length, 1);
  assert.equal(m.api.calls("GET", "/config").length, 1);

  await m.tick(26_000);
  assert.equal(m.api.calls("GET", "/config").length, 2);
  assert.equal(m.api.calls("GET", "/jobs").length, 1);
});

test("an active job polls the fast tier every 4s, announces its outcome, then stops polling", async (t) => {
  let jobs: JobView[] = [jobFixture({ id: "job-1", type: "draft_markdown_proposal", state: "active" })];
  const m = await mount(t, { routes: { "GET /jobs": () => ({ jobs, total: jobs.length }) } });

  await m.tick(4_000);
  assert.equal(m.api.calls("GET", "/jobs").length, 2);
  // The 4s tick never drags the heavy slow tier along with it.
  assert.equal(m.api.calls("GET", "/config").length, 1);
  assert.deepEqual(texts(m), []);

  jobs = [jobFixture({ id: "job-1", type: "draft_markdown_proposal", state: "completed" })];
  await m.tick(4_000);
  assert.deepEqual(texts(m), ["Draft Markdown Proposal completed."]);
  assert.equal(m.console().notifications[0].tone, "success");

  const pollsSoFar = m.api.calls("GET", "/jobs").length;
  await m.tick(8_000);
  assert.equal(m.api.calls("GET", "/jobs").length, pollsSoFar);
});

test("a job failing between polls is announced as a danger notification", async (t) => {
  let jobs: JobView[] = [jobFixture({ id: "job-1", state: "active" }), jobFixture({ id: "job-2", state: "created" })];
  const m = await mount(t, { routes: { "GET /jobs": () => ({ jobs, total: jobs.length }) } });

  jobs = [jobFixture({ id: "job-1", state: "failed" }), jobFixture({ id: "job-2", state: "completed" })];
  await m.tick(4_000);

  // One combined message per poll; any failure makes the whole message danger.
  assert.deepEqual(texts(m), ["Answer Question failed. Open Jobs for details. Answer Question completed."]);
  assert.equal(m.console().notifications[0].tone, "danger");
});

test("background poll failures stay silent", async (t) => {
  const m = await mount(t, {
    routes: { "GET /jobs": () => ({ jobs: [jobFixture({ state: "active" })], total: 1 }) }
  });
  m.api.on("GET /health", () => {
    throw new FakeApiError(502, "Bad gateway");
  });

  await m.tick(4_000);

  assert.equal(m.api.calls("GET", "/health").length, 2);
  assert.deepEqual(texts(m), []);
  assert.equal(m.console().refreshing, false);
});

// --- ask --------------------------------------------------------------------

function askRoutes(state: { jobs: JobView[]; questions: QuestionLog[] }): Record<string, RouteHandler> {
  return {
    "GET /config": () => configFixture(),
    "GET /jobs": () => ({ jobs: state.jobs, total: state.jobs.length }),
    "GET /questions": () => ({
      questions: state.questions,
      total: state.questions.length,
      matching: state.questions.length
    })
  };
}

async function submitAskForm(m: MountedConsole) {
  const form = m.container.querySelector("form");
  assert.ok(form, "expected the ask form");
  await m.run(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

test("asking through the Ask page enqueues, shows the queued job, then the logged answer", async (t) => {
  const state: { jobs: JobView[]; questions: QuestionLog[] } = { jobs: [], questions: [] };
  const m = await mount(t, { ui: <AskPage />, routes: askRoutes(state) });
  const queued = jobFixture({ id: "job-9", state: "created" });
  m.api.on("POST /ask", () => {
    state.jobs = [jobFixture({ id: "job-9", state: "active" })];
    state.questions = [questionFixture({ id: "question-9", question: "How do refunds work?", confidence: "unknown" })];
    return { questionId: "question-9", job: queued };
  });
  // The bounded wait returns the still-active view when the watcher is slow.
  m.api.on("GET /jobs/job-9/wait", () => ({ job: jobFixture({ id: "job-9", state: "active" }) }));

  const textarea = m.container.querySelector("textarea");
  const flowSelect = m.container.querySelector("select");
  assert.ok(textarea && flowSelect);
  await changeValue(textarea, "  How do refunds work?  ");
  await changeValue(flowSelect, "billing");
  await submitAskForm(m);

  assert.deepEqual(m.api.calls("POST", "/ask")[0].body, { question: "How do refunds work?", flow: "billing" });
  assert.equal(m.console().question, "");
  assert.equal(m.console().loading, false);
  assert.equal(m.console().answer?.job.state, "active");
  assert.deepEqual(texts(m), ["Answer Question queued. We will update this page when it finishes."]);
  assert.match(m.container.textContent ?? "", /Queued as answer_question \(active\)/);
  assert.match(m.container.textContent ?? "", /Waiting for an answer\./);

  // The watcher finishes: the job completes and the answer lands on the question log.
  state.jobs = [jobFixture({ id: "job-9", state: "completed" })];
  state.questions = [
    questionFixture({
      id: "question-9",
      question: "How do refunds work?",
      flowId: "billing",
      answer: { answer: "Refunds settle within five days.", confidence: "high", citations: [] }
    })
  ];
  await m.tick(4_000);

  assert.equal(m.console().answer?.job.state, "completed");
  assert.equal(texts(m)[0], "Answer Question completed.");
  assert.doesNotMatch(m.container.textContent ?? "", /Queued as answer_question/);
  assert.match(m.container.textContent ?? "", /Refunds settle within five days\./);
});

test("a blank question is never submitted", async (t) => {
  const m = await mount(t, { ui: <AskPage />, routes: askRoutes({ jobs: [], questions: [] }) });
  const textarea = m.container.querySelector("textarea");
  assert.ok(textarea);
  await changeValue(textarea, "   ");

  await submitAskForm(m);

  assert.equal(m.api.calls("POST", "/ask").length, 0);
});

test("a rejected ask keeps the typed question and reports the API message", async (t) => {
  const m = await mount(t, { ui: <AskPage />, routes: askRoutes({ jobs: [], questions: [] }) });
  m.api.on("POST /ask", () => {
    throw new FakeApiError(400, "Unknown flow: nope");
  });
  const textarea = m.container.querySelector("textarea");
  assert.ok(textarea);
  await changeValue(textarea, "Anything?");

  await submitAskForm(m);

  assert.deepEqual(texts(m), ["Unknown flow: nope"]);
  assert.equal(m.console().notifications[0].tone, "danger");
  assert.equal(m.console().question, "Anything?");
  assert.equal(m.console().answer, undefined);
  assert.equal(m.console().loading, false);
});

test("an answer job that already failed is reported as a danger message", async (t) => {
  const m = await mount(t);
  m.api.on("POST /ask", () => ({ questionId: "question-9", job: jobFixture({ id: "job-9", state: "created" }) }));
  m.api.on("GET /jobs/job-9/wait", () => ({ job: jobFixture({ id: "job-9", state: "failed" }) }));

  await m.run(() => m.console().reAskWithFlow("How do refunds work?", "support"));

  assert.deepEqual(m.api.calls("POST", "/ask")[0].body, { question: "How do refunds work?", flow: "support" });
  assert.deepEqual(texts(m), ["Answer Question failed."]);
  assert.equal(m.console().notifications[0].tone, "danger");
});

// --- answered-questions pager and search --------------------------------------

test("the pager fetches only the requested page and clamps negative pages to the first", async (t) => {
  const m = await mount(t);

  await m.run(() => m.console().loadQuestionsPage(2));
  assert.equal(m.console().questionsPage, 2);
  assert.equal(m.api.calls("GET", "/questions").at(-1)?.search, "?limit=8&offset=16");
  // Paging is a single request, not a whole fast-tier refresh.
  assert.equal(m.api.calls("GET", "/jobs").length, 1);

  await m.run(() => m.console().loadQuestionsPage(-1));
  assert.equal(m.console().questionsPage, 0);
  assert.equal(m.api.calls("GET", "/questions").at(-1)?.search, "?limit=8&offset=0");
});

test("search updates the input immediately but debounces one encoded request from page 0", async (t) => {
  const m = await mount(t);
  await m.run(() => m.console().loadQuestionsPage(3));
  const before = m.api.calls("GET", "/questions").length;

  await m.run(() => m.console().setAnsweredSearch("cats"));
  await m.run(() => m.console().setAnsweredSearch(" cats & dogs "));
  assert.equal(m.console().answeredSearch, " cats & dogs ");
  assert.equal(m.console().questionsPage, 0);
  await m.tick(299);
  assert.equal(m.api.calls("GET", "/questions").length, before);

  await m.tick(1);
  assert.equal(m.api.calls("GET", "/questions").length, before + 1);
  assert.equal(m.api.calls("GET", "/questions").at(-1)?.search, "?limit=8&offset=0&q=cats%20%26%20dogs");
});

test("a new ask drops the active search and returns to the first page", async (t) => {
  const m = await mount(t);
  m.api.on("POST /ask", () => ({ questionId: "question-9", job: jobFixture({ id: "job-9" }) }));
  m.api.on("GET /jobs/job-9/wait", () => ({ job: jobFixture({ id: "job-9" }) }));
  await m.run(() => m.console().setAnsweredSearch("cats"));
  await m.tick(300);

  await m.run(() => m.console().reAskWithFlow("New question", "auto"));

  assert.equal(m.console().answeredSearch, "");
  assert.equal(m.console().questionsPage, 0);
  assert.equal(m.api.calls("GET", "/questions").at(-1)?.search, "?limit=8&offset=0");
});

test("a refresh that finds the current page gone snaps back to the last real page", async (t) => {
  let matching = 40;
  const m = await mount(t, {
    routes: { "GET /questions": () => ({ questions: [], total: matching, matching }) }
  });
  await m.run(() => m.console().loadQuestionsPage(4));

  // Logs were deleted under the operator: only two pages remain.
  matching = 9;
  await m.run(() => m.console().refresh());

  assert.equal(m.console().questionsPage, 1);
  assert.equal(m.api.calls("GET", "/questions").at(-1)?.search, "?limit=8&offset=8");
});

test("a page response that arrives after the operator paged again is dropped", async (t) => {
  const m = await mount(t);
  const stale = deferred<{ questions: QuestionLog[]; total: number; matching: number }>();
  m.api.on("GET /questions", (request) =>
    request.search.includes("offset=8")
      ? stale.promise
      : { questions: [questionFixture({ id: "page-2-question" })], total: 30, matching: 30 }
  );

  act(() => {
    void m.console().loadQuestionsPage(1);
  });
  await act(async () => {
    await m.console().loadQuestionsPage(2);
  });
  stale.resolve({ questions: [questionFixture({ id: "page-1-question" })], total: 30, matching: 30 });
  await m.settle();

  assert.equal(m.console().questionsPage, 2);
  assert.deepEqual(
    m.console().questions.map((item) => item.id),
    ["page-2-question"]
  );
});

// --- question actions -------------------------------------------------------

test("feedback and the manual gap flag replace just the affected question", async (t) => {
  const questions = [questionFixture({ id: "question-1" }), questionFixture({ id: "question-2" })];
  const m = await mount(t, { routes: { "GET /questions": () => ({ questions, total: 2, matching: 2 }) } });
  m.api.on("POST /questions/question-2/feedback", () => ({
    question: questionFixture({ id: "question-2", feedback: "helpful" })
  }));
  m.api.on("POST /questions/question-2/gap", () => ({
    question: questionFixture({ id: "question-2", manualGap: true })
  }));
  m.api.on("DELETE /questions/question-2/gap", () => ({
    question: questionFixture({ id: "question-2", manualGap: false })
  }));

  await m.run(() => m.console().sendFeedback("question-2", "helpful"));
  assert.deepEqual(m.api.calls("POST", "/questions/question-2/feedback")[0].body, { feedback: "helpful" });
  assert.deepEqual(
    m.console().questions.map((item) => item.feedback),
    [undefined, "helpful"]
  );

  // Flagging POSTs, un-flagging DELETEs the same resource.
  await m.run(() => m.console().toggleKnowledgeGap("question-2", true));
  assert.equal(m.console().questions[1].manualGap, true);
  await m.run(() => m.console().toggleKnowledgeGap("question-2", false));
  assert.equal(m.api.calls("DELETE", "/questions/question-2/gap").length, 1);
  assert.equal(m.console().questions[1].manualGap, false);
});

test("deleting a question reports success per mode and resolves true", async (t) => {
  const m = await mount(t);
  const report = { deleted: { question: true, gaps: 0, clustersDismissed: 0, clustersRecomputed: 0, proposals: 0 } };
  m.api.on("DELETE /questions/question-1", () => ({ ...report, warnings: [] }));

  let outcome: boolean | undefined;
  await m.run(async () => {
    outcome = await m.console().deleteQuestion("question-1", false);
  });
  assert.equal(outcome, true);
  assert.equal(m.api.calls("DELETE", "/questions/question-1")[0].search, "");
  assert.equal(texts(m)[0], "Question deleted.");

  await m.run(() => m.console().deleteQuestion("question-1", true));
  assert.equal(m.api.calls("DELETE", "/questions/question-1")[1].search, "?scrub=true");
  assert.equal(texts(m)[0], "Question and its downstream drafts scrubbed.");
});

test("a scrub that leaves published proposals behind warns with their titles and PR links", async (t) => {
  const m = await mount(t);
  m.api.on("DELETE /questions/question-1", () => ({
    deleted: { question: true, gaps: 1, clustersDismissed: 0, clustersRecomputed: 0, proposals: 0 },
    warnings: [
      { proposalId: "p1", title: "Refund policy", status: "published", pullRequestUrl: "https://git.test/pr/7" },
      { proposalId: "p2", title: "Billing FAQ", status: "merged" }
    ]
  }));

  await m.run(() => m.console().deleteQuestion("question-1", true));

  assert.equal(m.console().notifications[0].tone, "danger");
  assert.equal(
    texts(m)[0],
    "Question deleted, but 2 published proposals still contain its text and must be handled manually: " +
      "“Refund policy” (https://git.test/pr/7); “Billing FAQ”"
  );
});

test("a refused delete resolves false and leaves the question in the list", async (t) => {
  const questions = [questionFixture({ id: "question-1" })];
  const m = await mount(t, { routes: { "GET /questions": () => ({ questions, total: 1, matching: 1 }) } });
  m.api.on("DELETE /questions/question-1", () => {
    throw new FakeApiError(403, "Requires manage:admin");
  });

  let outcome: boolean | undefined;
  await m.run(async () => {
    outcome = await m.console().deleteQuestion("question-1", false);
  });

  assert.equal(outcome, false);
  assert.deepEqual(texts(m), ["Requires manage:admin"]);
  assert.equal(m.console().questions.length, 1);
});

// --- jobs -------------------------------------------------------------------

test("selecting a job pins the detail pane to the live list entry, with a fetched fallback off-page", async (t) => {
  let jobs = [jobFixture({ id: "job-1", state: "active" })];
  const m = await mount(t, { routes: { "GET /jobs": () => ({ jobs, total: jobs.length }) } });
  m.api.on("GET /jobs/job-1", () => ({ job: jobFixture({ id: "job-1", state: "active" }) }));
  m.api.on("GET /jobs/job-old", () => ({ job: jobFixture({ id: "job-old", input: { marker: "archived" } }) }));

  await m.run(() => m.console().selectJob("job-1"));
  assert.equal(m.console().selectedJob?.state, "active");

  // The poll moves the job on; the pane follows the list, not the stale detail copy.
  jobs = [jobFixture({ id: "job-1", state: "completed" })];
  await m.tick(4_000);
  assert.equal(m.console().selectedJob?.state, "completed");

  // A job older than the loaded page is only reachable through its own fetch.
  await m.run(() => m.console().selectJob("job-old"));
  assert.deepEqual(m.console().selectedJob?.input, { marker: "archived" });

  await m.run(() => m.console().clearSelectedJob());
  assert.equal(m.console().selectedJob, undefined);
  assert.equal(m.console().selectedJobId, undefined);
});

test("cancel, retry and accept-failure post to the job endpoints, confirm and refresh", async (t) => {
  const m = await mount(t);
  m.api.on("POST /jobs/job-1/cancel", () => ({ job: jobFixture({ id: "job-1", state: "cancelled" }) }));
  m.api.on("POST /jobs/job-1/retry", () => ({ job: jobFixture({ id: "job-1", state: "retry" }) }));
  m.api.on("POST /jobs/job-1/accept-failure", () => ({ job: jobFixture({ id: "job-1", state: "failed" }) }));
  m.api.on("POST /jobs/job-2/accept-failure", () => ({ job: jobFixture({ id: "job-2", state: "failed" }) }));

  await m.run(() => m.console().cancelJob("job-1"));
  assert.equal(texts(m)[0], "Job cancelled.");
  assert.equal(m.api.calls("GET", "/jobs").length, 2);

  await m.run(() => m.console().retryJob("job-1"));
  assert.equal(texts(m)[0], "Job re-queued for retry.");

  await m.run(() => m.console().acceptFailedJobs(["job-1"]));
  assert.equal(texts(m)[0], "1 failed job accepted.");
  await m.run(() => m.console().acceptFailedJobs(["job-1", "job-2"]));
  assert.equal(texts(m)[0], "2 failed jobs accepted.");
  assert.equal(m.api.calls("POST", "/jobs/job-2/accept-failure").length, 1);
});

test("a rejected job action reports the API error and does not refresh", async (t) => {
  const m = await mount(t);
  m.api.on("POST /jobs/job-1/cancel", () => {
    throw new FakeApiError(409, "Job already finished");
  });

  await m.run(() => m.console().cancelJob("job-1"));

  assert.deepEqual(texts(m), ["Job already finished"]);
  assert.equal(m.console().notifications[0].tone, "danger");
  assert.equal(m.api.calls("GET", "/jobs").length, 1);
});

// --- drafting and proposals -------------------------------------------------

test("drafting a gap uses the gap's own flow and opens Proposals when a draft comes straight back", async (t) => {
  const m = await mount(t, { routes: { "GET /config": () => configFixture() } });
  m.api.on("POST /proposals/from-gap", () => ({ proposal: proposal("proposal-7") }));
  m.api.on("GET /proposals", () => ({ proposals: [proposal("proposal-1"), proposal("proposal-7")] }));

  await m.run(() => m.console().draftProposal(gapFixture({ summary: "Refund window?", flowId: "support" })));

  assert.deepEqual(m.api.calls("POST", "/proposals/from-gap")[0].body, {
    summary: "Refund window?",
    flowId: "support"
  });
  assert.deepEqual(m.pushes, ["/proposals"]);
  assert.equal(m.console().selectedProposalId, "proposal-7");
  assert.equal(m.console().loading, false);
});

test("drafting an un-routed gap falls back to the selected flow and follows the queued job to Jobs", async (t) => {
  const m = await mount(t, { routes: { "GET /config": () => configFixture() } });
  m.api.on("POST /proposals/from-gap", () => ({
    job: jobFixture({ id: "job-5", type: "draft_markdown_proposal", state: "created" })
  }));
  m.api.on("GET /jobs/job-5/wait", () => ({
    job: jobFixture({ id: "job-5", type: "draft_markdown_proposal", state: "completed" })
  }));

  await m.run(() => m.console().draftProposal(gapFixture({ flowId: undefined })));

  assert.deepEqual(m.api.calls("POST", "/proposals/from-gap")[0].body, {
    summary: "How are refunds processed?",
    flowId: "billing"
  });
  assert.deepEqual(m.pushes, ["/jobs"]);
  assert.deepEqual(texts(m), ["Draft Markdown Proposal completed."]);
});

test("drafting a cluster posts its summaries; an empty cluster is a no-op", async (t) => {
  const m = await mount(t, { routes: { "GET /config": () => configFixture() } });
  m.api.on("POST /proposals/from-gaps", () => ({ proposal: proposal("proposal-8") }));

  await m.run(() => m.console().draftCluster([]));
  assert.equal(m.api.calls("POST", "/proposals/from-gaps").length, 0);

  await m.run(() => m.console().draftCluster(["Gap A", "Gap B"], "support"));
  assert.deepEqual(m.api.calls("POST", "/proposals/from-gaps")[0].body, {
    summaries: ["Gap A", "Gap B"],
    flowId: "support"
  });
  assert.deepEqual(m.pushes, ["/proposals"]);
});

test("the selected proposal survives refreshes that reorder the list around it", async (t) => {
  let proposals = [proposal("p1"), proposal("p2"), proposal("p3")];
  const m = await mount(t, { routes: { "GET /proposals": () => ({ proposals }) } });
  // Nothing chosen yet: the preview shows the top of the backlog.
  assert.equal(m.console().selectedProposal?.id, "p1");

  await m.run(() => m.console().setSelectedProposalId("p3"));
  proposals = [proposal("p0"), proposal("p1"), proposal("p3")];
  await m.run(() => m.console().refresh());

  assert.equal(m.console().selectedProposal?.id, "p3");
});

test("marking a proposal ready updates it in place; merging also refreshes", async (t) => {
  const m = await mount(t, { routes: { "GET /proposals": () => ({ proposals: [proposal("p1")] }) } });
  // The API echoes the proposal back in whichever status was requested.
  let status = "draft";
  m.api.on("POST /proposals/p1/status", () => ({ proposal: proposal("p1", status) }));

  status = "ready";
  await m.run(() => m.console().updateProposalStatus("p1", "ready"));
  assert.deepEqual(m.api.calls("POST", "/proposals/p1/status")[0].body, { status: "ready" });
  assert.equal(m.console().proposals[0].status, "ready");
  assert.equal(texts(m)[0], "Proposal marked ready for PR workflow.");
  assert.equal(m.api.calls("GET", "/proposals").length, 1);

  status = "merged";
  await m.run(() => m.console().updateProposalStatus("p1", "merged"));
  assert.equal(texts(m)[0], "Proposal merged — resolving gaps and re-indexing in the background.");
  assert.equal(m.api.calls("GET", "/proposals").length, 2);
});

test("publishing is fire-and-forget: it reports the queued job and stays on the page", async (t) => {
  const m = await mount(t);
  m.api.on("POST /proposals/p1/publish", () => ({
    job: jobFixture({ id: "job-6", type: "publish_proposal", state: "created" })
  }));

  await m.run(() => m.console().publishProposal("p1"));

  assert.deepEqual(texts(m), ["Publish Proposal queued. This page will update when it finishes."]);
  assert.deepEqual(m.pushes, []);
  assert.equal(m.api.requests.filter((request) => request.path.endsWith("/wait")).length, 0);
  assert.equal(m.console().loading, false);
});

test("a bulk action posts once and reports one summary; an empty selection does nothing", async (t) => {
  const m = await mount(t);
  m.api.on("POST /proposals/bulk", () => ({
    results: [
      { id: "p1", ok: true },
      { id: "p2", ok: false, code: "not_ready" }
    ]
  }));

  await m.run(() => m.console().bulkProposalAction("merge", []));
  assert.equal(m.api.calls("POST", "/proposals/bulk").length, 0);

  await m.run(() => m.console().bulkProposalAction("merge", ["p1", "p2"]));
  assert.deepEqual(m.api.calls("POST", "/proposals/bulk")[0].body, { action: "merge", ids: ["p1", "p2"] });
  assert.equal(m.console().notifications.length, 1);
  assert.match(texts(m)[0], /Skipped 1: not_ready\./);
  assert.equal(m.api.calls("GET", "/proposals").length, 2);
});

// --- knowledge, schedules, seed, questionnaires -----------------------------

test("indexing posts the trimmed flow and reports the summary; a blank flow is a no-op", async (t) => {
  const m = await mount(t);
  m.api.on("POST /knowledge/repositories/index", () => ({
    documentCount: 12,
    sectionCount: 80,
    repository: { id: "billing-kb", name: "Billing KB", localPath: "/kb/billing" }
  }));

  // No flow is configured, so the default (empty) flow id must not be sent.
  await m.run(() => m.console().indexRepository());
  assert.equal(m.api.calls("POST", "/knowledge/repositories/index").length, 0);

  await m.run(() => m.console().indexRepository(" billing "));
  assert.deepEqual(m.api.calls("POST", "/knowledge/repositories/index")[0].body, { flowId: "billing" });
  assert.deepEqual(texts(m), ["Indexed Billing KB with 12 documents and 80 sections."]);
  assert.equal(m.console().indexingRepo, false);
});

test("saving a schedule stores the returned tasks and words the message by enabled state", async (t) => {
  const m = await mount(t);
  const tasks = [{ key: "patrol:billing", baseKey: "patrol", label: "Patrol", settings: { enabled: false } }];
  m.api.on("POST /scheduled-tasks/patrol:billing/settings", () => ({ tasks }));

  await m.run(() => m.console().saveScheduledTask("patrol:billing", false, "0 3 * * *"));

  assert.deepEqual(m.api.calls("POST", "/scheduled-tasks/patrol:billing/settings")[0].body, {
    enabled: false,
    cron: "0 3 * * *"
  });
  assert.equal(m.console().scheduledTasks.length, 1);
  assert.deepEqual(texts(m), ["Side-process schedule disabled."]);
});

test("proposing a seed plan omits blank notes and distinguishes a reused run", async (t) => {
  const m = await mount(t);
  let reused = false;
  m.api.on("POST /flows/billing/outline", () => ({ ok: true, jobId: "job-3", reused }));

  let outcome: { jobId: string; reused: boolean } | undefined;
  await m.run(async () => {
    outcome = await m.console().proposeSeedPlan("billing", "   ");
  });
  assert.deepEqual(outcome, { jobId: "job-3", reused: false });
  assert.deepEqual(m.api.calls("POST", "/flows/billing/outline")[0].body, {});
  assert.match(texts(m)[0], /^Planning — exploring the flow's sources/);

  reused = true;
  await m.run(() => m.console().proposeSeedPlan("billing", " focus on refunds "));
  assert.deepEqual(m.api.calls("POST", "/flows/billing/outline")[1].body, { notes: "focus on refunds" });
  assert.match(texts(m)[0], /^Already planning this flow/);
});

test("creating a questionnaire sends optional fields only when set and words the import path differently", async (t) => {
  const m = await mount(t);
  m.api.on("POST /questionnaires", () => ({ questionnaire: { id: "questionnaire-1" } }));

  await m.run(() => m.console().createQuestionnaire("Vendor review", "billing", ["Q1"]));
  assert.deepEqual(m.api.calls("POST", "/questionnaires")[0].body, {
    name: "Vendor review",
    flowId: "billing",
    questions: ["Q1"]
  });
  assert.match(texts(m)[0], /^Questionnaire created/);

  await m.run(() => m.console().createQuestionnaire("Vendor review", "billing", ["Q1"], "Be terse", "upload.xlsx"));
  assert.deepEqual(m.api.calls("POST", "/questionnaires")[1].body, {
    name: "Vendor review",
    flowId: "billing",
    questions: ["Q1"],
    direction: "Be terse",
    importOrigin: "upload.xlsx"
  });
  assert.match(texts(m)[0], /^Questionnaire imported/);
});

test("an asserted-claims outage degrades to an empty register without an error toast", async (t) => {
  const m = await mount(t);
  m.api.on("GET /asserted-claims", () => {
    throw new FakeApiError(500, "register offline");
  });

  let claims: unknown;
  await m.run(async () => {
    claims = await m.console().listAssertedClaims("billing & co");
  });

  assert.deepEqual(claims, []);
  assert.equal(m.api.calls("GET", "/asserted-claims")[0].search, "?status=open&flowId=billing%20%26%20co");
  assert.deepEqual(texts(m), []);
});

// --- notification feed ------------------------------------------------------

test("the notification feed is newest-first, capped at 20, and tracks read/dismiss/clear", async (t) => {
  const m = await mount(t);

  await m.run(() => {
    for (let index = 1; index <= 22; index++) {
      m.console().showMessage(`message ${index}`, index === 22 ? "danger" : "info");
    }
  });
  assert.equal(m.console().notifications.length, 20);
  assert.equal(texts(m)[0], "message 22");
  assert.equal(texts(m).at(-1), "message 3");
  assert.equal(m.console().toasts.length, 22);

  await m.run(() => m.console().markNotificationsRead());
  assert.ok(m.console().notifications.every((notification) => notification.read));
  // Nothing unread: marking again must keep the same array so polling re-renders don't churn.
  const feed = m.console().notifications;
  await m.run(() => m.console().markNotificationsRead());
  assert.equal(m.console().notifications, feed);

  // Dismissing a toast only hides the overlay; the feed keeps the entry.
  const newest = m.console().notifications[0];
  await m.run(() => m.console().dismissToast(newest.id));
  assert.equal(m.console().toasts.length, 21);
  assert.equal(m.console().notifications.length, 20);

  await m.run(() => m.console().dismissNotification(newest.id));
  assert.equal(texts(m)[0], "message 21");

  // Info toasts expire after 5s.
  await m.tick(5_000);
  assert.equal(m.console().toasts.length, 0);

  await m.run(() => m.console().clearNotifications());
  assert.deepEqual(m.console().notifications, []);
});

test("citations expand and collapse per question", async (t) => {
  const m = await mount(t);

  await m.run(() => m.console().toggleCitations("question-1"));
  await m.run(() => m.console().toggleCitations("question-2"));
  assert.deepEqual(m.console().expandedQuestionIds, ["question-1", "question-2"]);

  await m.run(() => m.console().toggleCitations("question-1"));
  assert.deepEqual(m.console().expandedQuestionIds, ["question-2"]);
});
