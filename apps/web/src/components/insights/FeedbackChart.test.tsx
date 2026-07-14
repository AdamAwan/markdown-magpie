import assert from "node:assert/strict";
import test from "node:test";
import type { FeedbackBucket } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { ChartCard } from "./ChartCard";
import { FeedbackChart } from "./FeedbackChart";

const fixture: FeedbackBucket[] = [
  { bucketStart: "2026-06-01T00:00:00.000Z", helpful: 6, unhelpful: 2, unhelpfulConfident: 1 },
  { bucketStart: "2026-06-02T00:00:00.000Z", helpful: 4, unhelpful: 0, unhelpfulConfident: 0 },
  { bucketStart: "2026-06-03T00:00:00.000Z", helpful: 0, unhelpful: 0, unhelpfulConfident: 0 }
];

test("ChartCard renders the feedback chart title", () => {
  const html = renderMarkup(
    <ChartCard title="Answer feedback" loading={false} empty={false}>
      <FeedbackChart series={fixture} />
    </ChartCard>
  );
  assert.match(html, /Answer feedback/);
});

test("FeedbackChart renders without throwing for real data", () => {
  const html = renderMarkup(<FeedbackChart series={fixture} />);
  assert.equal(typeof html, "string");
});

test("FeedbackChart renders without throwing for empty data", () => {
  const html = renderMarkup(<FeedbackChart series={[]} />);
  assert.equal(typeof html, "string");
});
