import assert from "node:assert/strict";
import test from "node:test";
import type { JobErrorBreakdown } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { ChartCard } from "./ChartCard";
import { JobErrorBreakdownChart } from "./JobErrorBreakdownChart";

const byCategory: JobErrorBreakdown[] = [
  { key: "provider", count: 5 },
  { key: "internal", count: 2 }
];
const byType: JobErrorBreakdown[] = [
  { key: "answer_question", count: 4 },
  { key: "publish_proposal", count: 3 }
];

test("ChartCard renders the job-error breakdown title", () => {
  const html = renderMarkup(
    <ChartCard title="Job error breakdown" loading={false} empty={false}>
      <JobErrorBreakdownChart byCategory={byCategory} byType={byType} />
    </ChartCard>
  );
  assert.match(html, /Job error breakdown/);
});

test("JobErrorBreakdownChart renders without throwing for real data", () => {
  const html = renderMarkup(<JobErrorBreakdownChart byCategory={byCategory} byType={byType} />);
  assert.equal(typeof html, "string");
});

test("JobErrorBreakdownChart renders without throwing for empty data", () => {
  const html = renderMarkup(<JobErrorBreakdownChart byCategory={[]} byType={[]} />);
  assert.equal(typeof html, "string");
});
