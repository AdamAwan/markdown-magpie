import assert from "node:assert/strict";
import { test } from "node:test";
import type { GapCandidate } from "@magpie/core";
import { assembleClusters, clusterId, singletonCluster } from "./gap-clustering.js";

function candidate(summary: string, questionIds: string[]): GapCandidate {
  return { summary, questionIds, count: questionIds.length, latestAskedAt: "2026-06-16T00:00:00.000Z", confidence: "low" };
}

// The motivating case: one multi-topic question produced three related gaps and
// the model groups them into a single cluster, so they draft one proposal.
const cheese = [
  candidate("whether cats like cheese", ["q1"]),
  candidate("health impact of cheese on cats", ["q1"]),
  candidate("consequences of cats eating large amounts of cheese", ["q1"])
];

test("assembleClusters groups the gaps the model returned together into one cluster", () => {
  const clusters = assembleClusters(cheese, {
    clusters: [
      {
        title: "Cats and cheese",
        summaries: cheese.map((gap) => gap.summary),
        rationale: "All three concern cats eating cheese."
      }
    ]
  });

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].summaries.length, 3);
  assert.equal(clusters[0].title, "Cats and cheese");
  // questionIds are unioned and de-duplicated across the member gaps.
  assert.deepEqual(clusters[0].questionIds, ["q1"]);
  assert.equal(clusters[0].count, 1);
});

test("assembleClusters keeps distinct clusters separate", () => {
  const gaps = [...cheese, candidate("how often to bathe a cat", ["q2"])];
  const clusters = assembleClusters(gaps, {
    clusters: [
      { summaries: cheese.map((gap) => gap.summary) },
      { summaries: ["how often to bathe a cat"] }
    ]
  });

  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].summaries.length, 3);
  assert.deepEqual(clusters[1].summaries, ["how often to bathe a cat"]);
});

test("assembleClusters gives any gap the model dropped its own cluster so nothing disappears", () => {
  const clusters = assembleClusters(cheese, {
    clusters: [{ summaries: ["whether cats like cheese"] }]
  });

  const covered = clusters.flatMap((cluster) => cluster.summaries).sort();
  assert.deepEqual(covered, cheese.map((gap) => gap.summary).sort());
});

test("assembleClusters never places a gap in two clusters even if the model duplicates it", () => {
  const clusters = assembleClusters(cheese, {
    clusters: [
      { summaries: ["whether cats like cheese", "health impact of cheese on cats"] },
      { summaries: ["whether cats like cheese", "consequences of cats eating large amounts of cheese"] }
    ]
  });

  const all = clusters.flatMap((cluster) => cluster.summaries);
  assert.equal(all.length, new Set(all).size);
  assert.equal(all.length, 3);
});

test("assembleClusters matches summaries case-insensitively and ignoring whitespace", () => {
  const clusters = assembleClusters(cheese, {
    clusters: [{ summaries: ["  WHETHER Cats Like Cheese  ", "health impact of cheese on cats"] }]
  });

  assert.equal(clusters[0].summaries.length, 2);
  assert.ok(clusters[0].summaries.includes("whether cats like cheese"));
});

test("assembleClusters falls back to singletons when the model output is unusable", () => {
  const clusters = assembleClusters(cheese, { nonsense: true });
  assert.equal(clusters.length, 3);
  for (const cluster of clusters) {
    assert.equal(cluster.summaries.length, 1);
  }
});

test("clusterId is stable and order-independent", () => {
  const summaries = ["a", "b", "c"];
  assert.equal(clusterId(summaries), clusterId([...summaries].reverse()));
  assert.notEqual(clusterId(["a", "b"]), clusterId(["a", "c"]));
});

test("singletonCluster derives a title from the gap summary", () => {
  const cluster = singletonCluster(candidate("No source material found for: How do I trim claws?", ["q9"]));
  assert.equal(cluster.summaries.length, 1);
  assert.equal(cluster.title, "How Do I Trim Claws");
  assert.deepEqual(cluster.questionIds, ["q9"]);
});
