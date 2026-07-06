import assert from "node:assert/strict";
import test from "node:test";
import type { FunnelStage } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { GapFunnelChart } from "./GapFunnelChart";

const fixture: FunnelStage[] = [
  { key: "questions", label: "Questions asked", count: 40 },
  { key: "gaps", label: "Gaps raised", count: 28 },
  { key: "clustered", label: "Clustered", count: 22 },
  { key: "proposals", label: "Proposals drafted", count: 15 },
  { key: "prs", label: "PRs opened", count: 9 },
  { key: "merged", label: "Merged", count: 6 },
  { key: "verified", label: "Verified closed", count: 4 }
];

test("GapFunnelChart renders without throwing for real data", () => {
  const html = renderMarkup(<GapFunnelChart stages={fixture} />);
  assert.equal(typeof html, "string");
});

test("GapFunnelChart renders without throwing for empty data", () => {
  const html = renderMarkup(<GapFunnelChart stages={[]} />);
  assert.equal(typeof html, "string");
});

test("GapFunnelChart renders without throwing for all-zero data", () => {
  const zeroed = fixture.map((stage) => ({ ...stage, count: 0 }));
  const html = renderMarkup(<GapFunnelChart stages={zeroed} />);
  assert.equal(typeof html, "string");
});
