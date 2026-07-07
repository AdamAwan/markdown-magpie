import assert from "node:assert/strict";
import test from "node:test";
import type { ConfiguredKnowledgeFlow, ScheduledTask } from "../lib/types";
import { renderMarkup } from "../test/render";
import { SchedulesPanel } from "./SchedulesPanel";

const flows: ConfiguredKnowledgeFlow[] = [
  { id: "docs", name: "Docs", sourceIds: ["source"], destinationId: "dest" }
];

const scheduledTask: ScheduledTask = {
  key: "correctness_patrol:docs",
  baseKey: "correctness_patrol",
  flowId: "docs",
  typeLabel: "Correctness patrol",
  label: "Correctness patrol · Docs",
  description: "Patrols the knowledge base for incorrect docs.",
  settings: { key: "correctness_patrol:docs", enabled: true, cron: "*/10 * * * *" }
};

test("renders the schedules table grouped by job type", () => {
  const html = renderMarkup(
    <SchedulesPanel
      flows={flows}
      loading={false}
      onRunTask={async () => undefined}
      onSaveTask={async () => undefined}
      scheduledTasks={[scheduledTask]}
    />
  );

  assert.match(html, /<h2>Schedules<\/h2>/);
  assert.match(html, /Correctness patrol/);
  assert.match(html, /\*\/10 \* \* \* \*/);
});

test("no longer renders a recent runs audit — that lives on the Activity page", () => {
  const html = renderMarkup(
    <SchedulesPanel
      flows={flows}
      loading={false}
      onRunTask={async () => undefined}
      onSaveTask={async () => undefined}
      scheduledTasks={[scheduledTask]}
    />
  );

  assert.doesNotMatch(html, /Recent runs/);
  assert.doesNotMatch(html, /View details for/);
});
