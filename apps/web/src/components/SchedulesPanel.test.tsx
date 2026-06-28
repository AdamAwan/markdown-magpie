import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConfiguredKnowledgeFlow, MaintenanceRun } from "../lib/types";
import { MaintenanceRunDetailsModal, SchedulesPanel } from "./SchedulesPanel";

const run: MaintenanceRun = {
  id: "run-1",
  taskType: "fix_patrol",
  flowId: "docs",
  trigger: "manual",
  status: "completed",
  summary: "checked 3 docs",
  details: { checked: 3, findings: [{ path: "docs/a.md", status: "ok" }] },
  startedAt: "2026-06-28T10:00:00.000Z",
  completedAt: "2026-06-28T10:00:05.000Z"
};

const flows: ConfiguredKnowledgeFlow[] = [
  { id: "docs", name: "Docs", sourceIds: ["source"], destinationId: "dest" }
];

test("recent runs show trigger and expose a details action", () => {
  const html = renderToStaticMarkup(
    <SchedulesPanel
      flows={flows}
      loading={false}
      maintenanceRuns={[run]}
      onRunTask={async () => undefined}
      onSaveTask={async () => undefined}
      scheduledTasks={[]}
    />
  );

  assert.match(html, />Trigger</);
  assert.match(html, />manual</);
  assert.match(html, /aria-label="View details for Fix patrol run"/);
});

test("maintenance run details modal renders formatted JSON details", () => {
  const html = renderToStaticMarkup(<MaintenanceRunDetailsModal onClose={() => undefined} run={run} />);

  assert.match(html, /role="dialog"/);
  assert.match(html, /run-1/);
  assert.match(html, /Completed/);
  assert.match(html, /&quot;checked&quot;: 3/);
  assert.match(html, /docs\/a.md/);
});

test("maintenance run details modal renders an empty object when details are absent", () => {
  const html = renderToStaticMarkup(
    <MaintenanceRunDetailsModal onClose={() => undefined} run={{ ...run, details: {} }} />
  );

  assert.match(html, /<pre class="docModalBody jsonBlock">{}<\/pre>/);
});
