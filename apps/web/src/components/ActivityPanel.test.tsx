import assert from "node:assert/strict";
import test from "node:test";
import type { MaintenanceRun } from "../lib/types";
import { renderMarkup } from "../test/render";
import { ActivityPanel, MaintenanceRunDetailsModal } from "./ActivityPanel";

test("renders maintenance runs as the activity audit surface", () => {
  const html = renderMarkup(
    <ActivityPanel
      flows={[{ id: "alpha", name: "Alpha", sourceIds: [], destinationId: "docs" }]}
      runs={[
        run({
          id: "run-1",
          taskType: "process_gaps_to_pull_requests",
          flowId: "alpha",
          summary: "reconciled flow alpha",
          details: {
            skippedModelWork: true,
            pullRequestsChecked: 2,
            proposalsDrafted: 1,
            mergeDecisions: 0,
            splitDecisions: 0
          }
        })
      ]}
    />
  );

  assert.match(html, /<h2>Activity<\/h2>/);
  assert.match(html, /Gap reconciliation/);
  assert.match(html, /Alpha/);
  assert.match(html, /2 PRs checked/);
  assert.match(html, /1 proposal drafted/);
  assert.match(html, /Skipped model work/);
});

test("renders change intent trace chips and debug details", () => {
  const html = renderMarkup(
    <ActivityPanel
      flows={[]}
      runs={[
        run({
          id: "run-trace",
          taskType: "correctness_patrol",
          summary: "checked docs",
          details: {
            intentTraces: [
              {
                createdAt: "2026-06-28T12:00:00.000Z",
                intent: {
                  lens: "verify",
                  flowId: "billing",
                  targets: ["kb/refunds.md"],
                  evidence: ["source/refunds.md"],
                  rationale: "Refund window no longer matches source material."
                },
                decision: { kind: "fold", intoProposalId: "proposal-1" },
                candidatePullRequests: [
                  {
                    proposalId: "proposal-1",
                    targets: ["kb/refunds.md"],
                    touchable: true,
                    overlapTargets: ["kb/refunds.md"]
                  }
                ],
                outcome: {
                  proposalId: "proposal-1",
                  proposalTitle: "Fix refund window",
                  proposalStatus: "draft",
                  foldJobId: "job-1"
                }
              }
            ]
          }
        })
      ]}
    />
  );

  assert.match(html, /1 intent/);
  assert.match(html, /folded/);
  assert.match(html, /View trace/);
  assert.match(html, /verify/);
  assert.match(html, /Refund window no longer matches source material/);
  assert.match(html, /Raw JSON/);
  assert.match(html, /proposal-1/);
});

test("each run card exposes a details action", () => {
  const html = renderMarkup(
    <ActivityPanel flows={[]} runs={[run({ id: "run-1", taskType: "correctness_patrol" })]} />
  );

  assert.match(html, /aria-label="View details for Correctness patrol run"/);
});

test("maintenance run details modal renders formatted JSON details", () => {
  const html = renderMarkup(
    <MaintenanceRunDetailsModal
      onClose={() => undefined}
      run={run({
        id: "run-1",
        taskType: "correctness_patrol",
        details: { checked: 3, findings: [{ path: "docs/a.md", status: "ok" }] }
      })}
    />
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /run-1/);
  assert.match(html, /Completed/);
  assert.match(html, /&quot;checked&quot;: 3/);
  assert.match(html, /docs\/a.md/);
});

test("maintenance run details modal renders an empty object when details are absent", () => {
  const html = renderMarkup(
    <MaintenanceRunDetailsModal onClose={() => undefined} run={run({ id: "run-1", taskType: "correctness_patrol", details: {} })} />
  );

  // Emotion replaces the old `docModalBody jsonBlock` class with a hashed class,
  // so assert on the dialog role plus the empty-object JSON body text instead.
  assert.match(html, /role="dialog"/);
  assert.match(html, />{}<\/pre>/);
});

function run(overrides: Partial<MaintenanceRun> & Pick<MaintenanceRun, "id" | "taskType">): MaintenanceRun {
  const { id, taskType, ...rest } = overrides;
  return {
    id,
    taskType,
    trigger: "scheduled",
    status: "completed",
    summary: "",
    details: {},
    startedAt: "2026-06-28T12:00:00.000Z",
    completedAt: "2026-06-28T12:00:01.000Z",
    ...rest
  };
}
