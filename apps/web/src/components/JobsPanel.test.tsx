import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { JobView } from "../lib/types";
import { JobsPanel } from "./JobsPanel";

const now = "2026-06-22T20:00:00.000Z";

const jobs: JobView[] = [
  job({ id: "job-new", type: "draft_markdown_proposal", input: { marker: "new-job-input" } }),
  job({
    id: "job-old",
    type: "answer_question",
    input: { marker: "old-job-input" },
    createdAt: "2026-06-22T19:00:00.000Z"
  })
];

const callbacks = {
  onSelect: (_jobId: string) => undefined,
  onClose: () => undefined,
  onCancel: async (_jobId: string) => undefined,
  onRetry: async (_jobId: string) => undefined,
  onAccept: async (_jobIds: string[]) => undefined
};

test("renders jobs, workers, and schedules as separate panels", () => {
  const html = renderToStaticMarkup(
    <JobsPanel jobs={jobs} schedules={[]} workers={[]} selectedJob={undefined} {...callbacks} />
  );

  assert.equal(html.match(/class="surface"/g)?.length, 3);
  assert.ok(html.indexOf("<h2>Jobs</h2>") < html.indexOf("<h2>Connected workers</h2>"));
  assert.ok(html.indexOf("<h2>Connected workers</h2>") < html.indexOf("<h2>Active schedules</h2>"));
  assert.match(html, /class="jobsWorkspace"/);
  assert.match(html, /class="jobList"/);
  assert.match(html, /class="jobDetailPanel"/);
  assert.match(html, /new-job-input/);
});

test("shows the explicitly selected job in the detail pane", () => {
  const html = renderToStaticMarkup(
    <JobsPanel jobs={jobs} schedules={[]} workers={[]} selectedJob={jobs[1]} {...callbacks} />
  );

  assert.match(html, /old-job-input/);
  assert.match(html, /jobListItem selected/);
});

function job(overrides: Partial<JobView> & Pick<JobView, "id" | "type">): JobView {
  const { id, type, ...rest } = overrides;
  return {
    id,
    type,
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
