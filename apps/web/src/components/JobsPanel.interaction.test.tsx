import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentProps } from "react";
import type { JobView, ScheduleView, WatcherView } from "../lib/types";
import { buttonByText, buttonsByText, changeValue, click, renderDom } from "../test/dom";
import { jobFixture, workerFixture } from "../test/fixtures";
import { JobsPanel } from "./JobsPanel";

// Behaviour of the Jobs screen that only exists across renders: filtering,
// paging, the per-state action buttons and the worker/schedule tables. The
// static-markup shape is covered by JobsPanel.test.tsx.

type Props = ComponentProps<typeof JobsPanel>;

interface Calls {
  selected: string[];
  closed: number;
  cancelled: string[];
  retried: string[];
  accepted: string[][];
}

function setup(overrides: Partial<Props> = {}) {
  const calls: Calls = { selected: [], closed: 0, cancelled: [], retried: [], accepted: [] };
  const props: Props = {
    jobs: [],
    schedules: [],
    workers: [],
    selectedJob: undefined,
    onSelect: (jobId) => {
      calls.selected.push(jobId);
    },
    onClose: () => {
      calls.closed += 1;
    },
    onCancel: async (jobId) => {
      calls.cancelled.push(jobId);
    },
    onRetry: async (jobId) => {
      calls.retried.push(jobId);
    },
    onAccept: async (jobIds) => {
      calls.accepted.push(jobIds);
    },
    ...overrides
  };
  return { calls, props };
}

async function mount(t: { after: (fn: () => void) => void }, overrides: Partial<Props> = {}) {
  const { calls, props } = setup(overrides);
  const mounted = await renderDom(<JobsPanel {...props} />);
  t.after(() => mounted.unmount());
  return { ...mounted, calls, props };
}

/** Minute-spaced jobs, newest first: job-0 is the most recent. */
function manyJobs(count: number, overrides: Partial<JobView> = {}): JobView[] {
  return Array.from({ length: count }, (_, index) =>
    jobFixture({
      id: `job-${index}`,
      createdAt: new Date(Date.UTC(2026, 5, 22, 20, 0, 0) - index * 60_000).toISOString(),
      ...overrides
    })
  );
}

function selects(container: HTMLElement): [HTMLSelectElement, HTMLSelectElement] {
  const [state, type] = container.querySelectorAll("select");
  assert.ok(state && type, "expected the state and type filters");
  return [state, type];
}

function listedJobs(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Jobs"] > button')];
}

function detail(container: HTMLElement): HTMLElement {
  const aside = container.querySelector("aside");
  assert.ok(aside, "expected the job detail pane");
  return aside;
}

test("an empty queue explains itself in the list, the detail pane and both tables", async (t) => {
  const { container } = await mount(t);
  const text = container.textContent ?? "";

  assert.match(text, /No jobs queued\./);
  assert.match(text, /Select a job to view its details\./);
  assert.match(text, /No workers connected\. Start a watcher to process queued jobs\./);
  assert.match(text, /No active schedules\./);
  assert.match(text, /0 workers/);
  assert.equal(buttonsByText(container, "Accept all failures").length, 0);
});

test("header badges count in-flight jobs and only the failures nobody has accepted", async (t) => {
  const jobs = [
    jobFixture({ id: "a", state: "active" }),
    jobFixture({ id: "b", state: "blocked" }),
    jobFixture({ id: "c", state: "failed" }),
    jobFixture({ id: "d", state: "failed", acceptedAt: "2026-06-22T21:00:00.000Z" }),
    jobFixture({ id: "e", state: "completed" })
  ];
  const { container, calls } = await mount(t, { jobs });
  // The Jobs heading shares its header row with the count badges.
  const header = container.querySelector("h2")?.parentElement?.textContent ?? "";

  assert.match(header, /2 active/);
  assert.match(header, /1 failed/);

  // The bulk accept sends only the un-accepted failure, never the already-accepted one.
  await click(buttonByText(container, "Accept all failures"));
  assert.deepEqual(calls.accepted, [["c"]]);
});

test("the state and type filters narrow the list and report the match count", async (t) => {
  const jobs = [
    jobFixture({ id: "a", type: "answer_question", state: "completed" }),
    jobFixture({ id: "b", type: "publish_proposal", state: "failed" }),
    jobFixture({ id: "c", type: "answer_question", state: "failed" })
  ];
  const { container } = await mount(t, { jobs });
  const [stateFilter, typeFilter] = selects(container);

  // Type options are the distinct loaded types, alphabetical, in display form.
  assert.deepEqual(
    [...typeFilter.options].map((option) => option.textContent),
    ["All types", "Answer Question", "Publish Proposal"]
  );
  assert.match(container.textContent ?? "", /3 matched/);

  await changeValue(stateFilter, "failed");
  assert.equal(listedJobs(container).length, 2);
  assert.match(container.textContent ?? "", /2 matched/);

  await changeValue(typeFilter, "publish_proposal");
  assert.equal(listedJobs(container).length, 1);
  assert.match(detail(container).textContent ?? "", /Publish Proposal/);

  await changeValue(stateFilter, "cancelled");
  assert.equal(listedJobs(container).length, 0);
  // Jobs exist, they just don't match — a different message from the empty queue.
  assert.match(container.textContent ?? "", /No jobs match the current filters\./);
  assert.doesNotMatch(container.textContent ?? "", /No jobs queued\./);
});

test("the list pages 20 at a time, newest first, and a filter change returns to page one", async (t) => {
  const jobs = [
    ...manyJobs(45),
    jobFixture({ id: "failed-old", state: "failed", createdAt: "2026-01-01T00:00:00.000Z" })
  ];
  // Shuffle the input order: the panel must sort by createdAt itself.
  const { container } = await mount(t, { jobs: [...jobs].reverse() });

  assert.equal(listedJobs(container).length, 20);
  assert.match(container.textContent ?? "", /1\/3/);
  assert.equal(buttonByText(container, "Previous").disabled, true);
  // With nothing selected the newest job drives the detail pane.
  assert.match(detail(container).textContent ?? "", /job-0\b/);

  await click(buttonByText(container, "Next"));
  await click(buttonByText(container, "Next"));
  assert.match(container.textContent ?? "", /3\/3/);
  assert.equal(listedJobs(container).length, 6);
  assert.equal(buttonByText(container, "Next").disabled, true);
  assert.match(detail(container).textContent ?? "", /job-40\b/);

  const [stateFilter] = selects(container);
  await changeValue(stateFilter, "completed");
  assert.match(container.textContent ?? "", /1\/3/);
  assert.match(detail(container).textContent ?? "", /job-0\b/);

  // 20 or fewer matches: no pager at all.
  await changeValue(stateFilter, "failed");
  assert.equal(buttonsByText(container, "Next").length, 0);
});

test("when a poll shrinks the list under the current page the view clamps to the last real page", async (t) => {
  const { container, props, rerender } = await mount(t, { jobs: manyJobs(45) });
  await click(buttonByText(container, "Next"));
  await click(buttonByText(container, "Next"));
  assert.match(container.textContent ?? "", /3\/3/);

  await rerender(<JobsPanel {...props} jobs={manyJobs(25)} />);

  assert.match(container.textContent ?? "", /2\/2/);
  assert.equal(listedJobs(container).length, 5);
});

test("clicking a job row or a worker's current job selects that job", async (t) => {
  const workers = [workerFixture({ status: "busy", currentJobId: "0123456789abcdef" })];
  const { container, calls } = await mount(t, { jobs: manyJobs(3), workers });

  await click(listedJobs(container)[1]);
  // The worker row shows a short id but selects by the full one.
  await click(buttonByText(container, "01234567"));

  assert.deepEqual(calls.selected, ["job-1", "0123456789abcdef"]);
});

test("an in-flight job offers only Cancel", async (t) => {
  for (const state of ["created", "retry", "active"] as const) {
    const job = jobFixture({ id: `job-${state}`, state });
    const { container, calls, unmount } = await mount(t, { jobs: [job], selectedJob: job });
    const pane = detail(container);

    await click(buttonByText(pane, "Cancel"));
    assert.deepEqual(calls.cancelled, [`job-${state}`]);
    assert.equal(buttonsByText(pane, "Retry").length, 0);
    assert.equal(buttonsByText(pane, "Accept failure").length, 0);
    unmount();
  }
});

test("a failed job offers Retry and Accept failure; once accepted only Retry remains", async (t) => {
  const failed = jobFixture({
    id: "job-failed",
    state: "failed",
    error: { code: "E_TIMEOUT", message: "Provider timed out", category: "timeout" }
  });
  const { container, calls, props, rerender } = await mount(t, { jobs: [failed], selectedJob: failed });

  assert.match(detail(container).textContent ?? "", /\[timeout\] E_TIMEOUT: Provider timed out/);
  assert.equal(buttonsByText(detail(container), "Cancel").length, 0);
  await click(buttonByText(detail(container), "Retry"));
  await click(buttonByText(detail(container), "Accept failure"));
  assert.deepEqual(calls.retried, ["job-failed"]);
  assert.deepEqual(calls.accepted, [["job-failed"]]);

  const accepted = { ...failed, acceptedAt: "2026-06-22T21:00:00.000Z" };
  await rerender(<JobsPanel {...props} jobs={[accepted]} selectedJob={accepted} />);

  assert.equal(buttonsByText(detail(container), "Accept failure").length, 0);
  assert.equal(buttonsByText(detail(container), "Retry").length, 1);
  // The row badge reads "accepted" rather than the raw failed state, and the bulk action goes away.
  assert.match(listedJobs(container)[0].textContent ?? "", /accepted/);
  assert.equal(buttonsByText(container, "Accept all failures").length, 0);
});

test("a finished job offers no actions, and Output renders only when the job has one", async (t) => {
  const done = jobFixture({ id: "job-done", state: "completed", input: { question: "hi" } });
  const { container, props, rerender } = await mount(t, { jobs: [done], selectedJob: done });
  const pane = detail(container);

  for (const label of ["Cancel", "Retry", "Accept failure"]) {
    assert.equal(buttonsByText(pane, label).length, 0, `${label} should not be offered`);
  }
  assert.match(pane.textContent ?? "", /Input/);
  assert.doesNotMatch(pane.textContent ?? "", /Output/);

  const withOutput = { ...done, output: { result: { marker: "the-output" } } };
  await rerender(<JobsPanel {...props} jobs={[withOutput]} selectedJob={withOutput} />);
  assert.match(detail(container).textContent ?? "", /Output/);
  assert.match(detail(container).textContent ?? "", /the-output/);
});

test("the close button appears only for an explicit selection", async (t) => {
  const jobs = manyJobs(2);
  const { container, calls, props, rerender } = await mount(t, { jobs });
  // The implicit "first job" preview has nothing to close.
  assert.equal(container.querySelector('button[aria-label="Close details"]'), null);

  await rerender(<JobsPanel {...props} selectedJob={jobs[1]} />);
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close details"]');
  assert.ok(close);
  await click(close);

  assert.equal(calls.closed, 1);
});

test("an explicitly selected job stays in the detail pane even when the filters hide its row", async (t) => {
  const jobs = [jobFixture({ id: "kept", state: "completed" }), jobFixture({ id: "other", state: "failed" })];
  const { container } = await mount(t, { jobs, selectedJob: jobs[0] });

  await changeValue(selects(container)[0], "failed");

  assert.equal(listedJobs(container).length, 1);
  assert.match(detail(container).textContent ?? "", /kept/);
});

test("workers sort by name, split the uuid suffix into a short id, and count the busy ones", async (t) => {
  const workers: WatcherView[] = [
    workerFixture({ name: "zeta" }),
    workerFixture({ name: "alpha-3f2a9c1e-1b2c-4d5e-8f90-123456789abc", status: "busy" })
  ];
  const { container } = await mount(t, { workers });
  const names = [...container.querySelectorAll("span[title]")]
    .filter((node) => workers.some((worker) => worker.name === node.getAttribute("title")))
    .map((node) => [...node.children].map((child) => child.textContent));

  assert.deepEqual(names, [["alpha", "3f2a9c1e"], ["zeta"]]);
  assert.match(container.textContent ?? "", /2 workers/);
  assert.match(container.textContent ?? "", /1 busy/);
});

test("a worker's job types are the de-duplicated union of what its capabilities run", async (t) => {
  // github and local-git both run publish_proposal; "quantum" is not a known capability.
  const workers = [workerFixture({ capabilities: ["github", "local-git", "quantum"] })];
  const { container } = await mount(t, { workers });
  const text = container.textContent ?? "";

  assert.equal(text.split("Publish Proposal").length - 1, 1);
  for (const jobType of ["Refresh Flow Snapshot", "Crosslink Pull Requests", "Comment Pull Request"]) {
    assert.match(text, new RegExp(jobType));
  }
  // The unknown capability is still listed, it just contributes no job types.
  assert.match(text, /quantum/);
  assert.doesNotMatch(text, /Answer Question/);
});

test("a provider capability unlocks the AI job types", async (t) => {
  const { container } = await mount(t, { workers: [workerFixture({ capabilities: ["codex", "claude"] })] });
  const text = container.textContent ?? "";

  assert.equal(text.split("Answer Question").length - 1, 1);
  assert.match(text, /Draft Markdown Proposal/);
  assert.doesNotMatch(text, /Publish Proposal/);
});

test("the schedules table lists only enabled schedules", async (t) => {
  const schedules: ScheduleView[] = [
    { key: "patrol:billing", type: "correctness_patrol", cron: "0 3 * * *", enabled: true },
    { key: "sync:billing", type: "source_change_sync", cron: "*/5 * * * *", enabled: false }
  ];
  const { container } = await mount(t, { schedules });
  const text = container.textContent ?? "";

  assert.match(text, /patrol:billing/);
  assert.match(text, /Correctness Patrol/);
  assert.match(text, /0 3 \* \* \*/);
  assert.doesNotMatch(text, /sync:billing/);
  assert.match(text, /1 active/);
});
