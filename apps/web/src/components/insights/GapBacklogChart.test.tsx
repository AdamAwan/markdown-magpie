import assert from "node:assert/strict";
import test from "node:test";
import type { GapBacklogBucket } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { ChartCard } from "./ChartCard";
import { GapBacklogChart } from "./GapBacklogChart";

const fixture: GapBacklogBucket[] = [
  { bucketStart: "2026-06-01T00:00:00.000Z", opened: 3, resolved: 1, dismissed: 0, parked: 0, openTotal: 2 },
  { bucketStart: "2026-06-02T00:00:00.000Z", opened: 1, resolved: 2, dismissed: 1, parked: 0, openTotal: 0 }
];

test("ChartCard shows the loading state before data arrives", () => {
  const html = renderMarkup(
    <ChartCard title="Open-gap backlog" loading empty={false}>
      <div>chart</div>
    </ChartCard>
  );
  assert.match(html, /Open-gap backlog/);
  assert.match(html, /Loading/);
  assert.doesNotMatch(html, /chart/);
});

test("ChartCard shows an empty state when there is no data", () => {
  const html = renderMarkup(
    <ChartCard title="Open-gap backlog" loading={false} empty emptyMessage="Nothing yet.">
      <div>chart</div>
    </ChartCard>
  );
  assert.match(html, /Nothing yet\./);
  assert.doesNotMatch(html, />chart</);
});

test("ChartCard surfaces fetch errors", () => {
  const html = renderMarkup(
    <ChartCard title="Open-gap backlog" loading={false} empty={false} error="boom">
      <div>chart</div>
    </ChartCard>
  );
  assert.match(html, /boom/);
});

test("GapBacklogChart renders without throwing for real data", () => {
  const html = renderMarkup(<GapBacklogChart series={fixture} />);
  assert.equal(typeof html, "string");
});

test("GapBacklogChart renders without throwing for empty data", () => {
  const html = renderMarkup(<GapBacklogChart series={[]} />);
  assert.equal(typeof html, "string");
});
