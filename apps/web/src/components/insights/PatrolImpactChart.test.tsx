import assert from "node:assert/strict";
import test from "node:test";
import type { PatrolImpact } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { ChartCard } from "./ChartCard";
import { PatrolImpactChart } from "./PatrolImpactChart";

const fixture: PatrolImpact[] = [
  { taskType: "correctness_patrol", runs: 8, findings: 5, proposals: 0 },
  { taskType: "process_gaps_to_pull_requests", runs: 4, findings: 0, proposals: 3 }
];

test("ChartCard renders the patrol-impact title", () => {
  const html = renderMarkup(
    <ChartCard title="Maintenance patrol impact" loading={false} empty={false}>
      <PatrolImpactChart runs={fixture} />
    </ChartCard>
  );
  assert.match(html, /Maintenance patrol impact/);
});

test("PatrolImpactChart renders without throwing for real data", () => {
  const html = renderMarkup(<PatrolImpactChart runs={fixture} />);
  assert.equal(typeof html, "string");
});

test("PatrolImpactChart renders without throwing for empty data", () => {
  const html = renderMarkup(<PatrolImpactChart runs={[]} />);
  assert.equal(typeof html, "string");
});
