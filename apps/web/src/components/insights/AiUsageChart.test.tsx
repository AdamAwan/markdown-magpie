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
    jobs: 12,
    jobsWithUsage: 12,
    inputTokens: 240_000,
    outputTokens: 31_000,
    totalTokens: 271_000
  },
  {
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
