import assert from "node:assert/strict";
import test from "node:test";
import type { AiUsageBreakdown } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { ChartCard } from "./ChartCard";
import { AiUsageChart } from "./AiUsageChart";

const fixture: AiUsageBreakdown[] = [
  {
    jobType: "answer_question",
    provider: "openai-compatible",
    model: "gpt-4o",
    jobs: 12,
    jobsWithUsage: 12,
    inputTokens: 240_000,
    outputTokens: 31_000,
    totalTokens: 271_000,
    estimatedCost: { input: 0.7, output: 0.21, total: 0.91 }
  },
  {
    // Usage reported but no price entry matched: unpriced, not $0.
    jobType: "improve_document",
    provider: "openai-compatible",
    model: "gpt-4o-mini",
    jobs: 3,
    jobsWithUsage: 3,
    inputTokens: 5_000,
    outputTokens: 800,
    totalTokens: 5_800
  },
  {
    // No usage at all (CLI provider): unmetered, not free.
    jobType: "verify_document",
    provider: "claude",
    jobs: 4,
    jobsWithUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  }
];

test("ChartCard renders the AI usage chart title", () => {
  const html = renderMarkup(
    <ChartCard title="AI token usage" loading={false} empty={false}>
      <AiUsageChart usage={fixture} />
    </ChartCard>
  );
  assert.match(html, /AI token usage/);
});

test("AiUsageChart renders without throwing for real data", () => {
  const html = renderMarkup(<AiUsageChart usage={fixture} />);
  assert.equal(typeof html, "string");
});

test("AiUsageChart renders without throwing for empty data", () => {
  const html = renderMarkup(<AiUsageChart usage={[]} />);
  assert.equal(typeof html, "string");
});

test("AiUsageChart surfaces the priced/unpriced/unmetered coverage", () => {
  const html = renderMarkup(<AiUsageChart usage={fixture} />);
  // The total is rendered from the one priced row, and the coverage line keeps
  // the three states distinct so unpriced/unmetered never read as $0.
  assert.match(html, /Est\. cost/);
  assert.match(html, /1 priced/);
  assert.match(html, /1 unpriced/);
  assert.match(html, /1 unmetered/);
});
