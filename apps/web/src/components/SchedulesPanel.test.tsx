import assert from "node:assert/strict";
import test from "node:test";
import type { AiScheduleCost, ConfiguredKnowledgeFlow, ScheduledTask } from "../lib/types";
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

test("renders a priced task's 30-day cost, and unmetered when only CLI jobs ran", () => {
  const priced: AiScheduleCost = {
    key: "correctness_patrol:docs",
    jobs: 6,
    jobsWithUsage: 6,
    pricedJobs: 6,
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    estimatedCost: 0.42
  };
  const html = renderMarkup(
    <SchedulesPanel
      costByKey={new Map([[priced.key, priced]])}
      flows={flows}
      loading={false}
      onRunTask={async () => undefined}
      onSaveTask={async () => undefined}
      scheduledTasks={[scheduledTask]}
    />
  );
  assert.match(html, /est\. 0\.42/);

  const unmetered: AiScheduleCost = {
    key: "correctness_patrol:docs",
    jobs: 4,
    jobsWithUsage: 0,
    pricedJobs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
  const cliHtml = renderMarkup(
    <SchedulesPanel
      costByKey={new Map([[unmetered.key, unmetered]])}
      flows={flows}
      loading={false}
      onRunTask={async () => undefined}
      onSaveTask={async () => undefined}
      scheduledTasks={[scheduledTask]}
    />
  );
  assert.match(cliHtml, /unmetered/);
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
