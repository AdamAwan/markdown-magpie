import assert from "node:assert/strict";
import test from "node:test";
import type { JourneySankey } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { QuestionJourneyChart } from "./QuestionJourneyChart";

const fixture: JourneySankey = {
  nodes: [
    { key: "questions", label: "Questions asked", segment: "answer" },
    { key: "conf_high", label: "High confidence", segment: "answer" },
    { key: "conf_low", label: "Low confidence", segment: "answer" },
    { key: "no_gap", label: "Answered, no gap", segment: "answer" },
    { key: "gaps", label: "Gaps raised", segment: "gap" },
    { key: "gap_dismissed", label: "Dismissed", segment: "gap" },
    { key: "clustered", label: "Clustered", segment: "gap" },
    { key: "proposals", label: "Proposals drafted", segment: "proposal" },
    { key: "merged", label: "Merged", segment: "proposal" },
    { key: "v_closed", label: "Verified closed", segment: "verify" }
  ],
  links: [
    { source: "questions", target: "conf_high", value: 30 },
    { source: "questions", target: "conf_low", value: 10 },
    { source: "conf_high", target: "no_gap", value: 24 },
    { source: "conf_high", target: "gaps", value: 6 },
    { source: "conf_low", target: "gaps", value: 12 },
    { source: "gaps", target: "gap_dismissed", value: 4 },
    { source: "gaps", target: "clustered", value: 14 },
    // Boundary link carries the gap-side count (Clustered stays conserved at 14); the
    // unit shift to proposal counts surfaces at "Proposals drafted" downstream.
    { source: "clustered", target: "proposals", value: 14 },
    { source: "proposals", target: "merged", value: 6 },
    { source: "merged", target: "v_closed", value: 4 }
  ]
};

test("QuestionJourneyChart renders without throwing for real data", () => {
  const html = renderMarkup(<QuestionJourneyChart journey={fixture} />);
  assert.equal(typeof html, "string");
});

test("QuestionJourneyChart renders a placeholder without throwing for empty data", () => {
  const html = renderMarkup(<QuestionJourneyChart journey={{ nodes: [], links: [] }} />);
  assert.equal(typeof html, "string");
});
