import assert from "node:assert/strict";
import test from "node:test";
import type { LatencyBin } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { ChartCard } from "./ChartCard";
import { LatencyHistogramChart } from "./LatencyHistogramChart";

const fixture: LatencyBin[] = [
  { label: "0–5s", from: 0, to: 5, count: 4 },
  { label: "5–15s", from: 5, to: 15, count: 2 },
  { label: "5m+", from: 300, to: null, count: 1 }
];

test("ChartCard renders the latency histogram title", () => {
  const html = renderMarkup(
    <ChartCard title="Answer latency" loading={false} empty={false}>
      <LatencyHistogramChart bins={fixture} />
    </ChartCard>
  );
  assert.match(html, /Answer latency/);
});

test("LatencyHistogramChart renders without throwing for real data", () => {
  const html = renderMarkup(<LatencyHistogramChart bins={fixture} />);
  assert.equal(typeof html, "string");
});

test("LatencyHistogramChart renders without throwing for empty data", () => {
  const html = renderMarkup(<LatencyHistogramChart bins={[]} />);
  assert.equal(typeof html, "string");
});
