import assert from "node:assert/strict";
import test from "node:test";
import type { JobThroughputBucket } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { JobThroughputChart } from "./JobThroughputChart";

const fixture: JobThroughputBucket[] = [
  { bucketStart: "2026-06-01T00:00:00.000Z", completed: 5, failed: 1, active: 2, retry: 0 },
  { bucketStart: "2026-06-02T00:00:00.000Z", completed: 8, failed: 0, active: 1, retry: 1 }
];

test("JobThroughputChart renders without throwing for real data", () => {
  const html = renderMarkup(<JobThroughputChart series={fixture} />);
  assert.equal(typeof html, "string");
});

test("JobThroughputChart renders without throwing for empty data", () => {
  const html = renderMarkup(<JobThroughputChart series={[]} />);
  assert.equal(typeof html, "string");
});
