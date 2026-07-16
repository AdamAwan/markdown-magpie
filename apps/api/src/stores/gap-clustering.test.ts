import assert from "node:assert/strict";
import { test } from "node:test";
import type { GapCandidate } from "@magpie/core";
import {
  assembleClusters,
  buildCluster,
  clusterId,
  selectClustersToDraft,
  singletonCluster
} from "./gap-clustering.js";

function candidate(summary: string, questionIds: string[]): GapCandidate {
  return {
    summary,
    questionIds,
    count: questionIds.length,
    latestAskedAt: "2026-06-16T00:00:00.000Z",
    confidence: "low"
  };
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
    clusters: [{ summaries: cheese.map((gap) => gap.summary) }, { summaries: ["how often to bathe a cat"] }]
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

test("singletonCluster carries the candidate's flow onto the cluster", () => {
  const flowed: GapCandidate = { ...candidate("Pricing is undocumented", ["q1"]), flowId: "magpie-sales" };
  assert.equal(singletonCluster(flowed).flowId, "magpie-sales");
});

test("assembleClusters tags built clusters with the given flow", () => {
  const clusters = assembleClusters(
    [candidate("a", ["q1"]), candidate("b", ["q2"])],
    { clusters: [{ title: "Group", summaries: ["a", "b"] }] },
    "magpie-support"
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].flowId, "magpie-support");
});

test("clusterId is distinct for the same summaries under different flows", () => {
  assert.notEqual(clusterId(["a", "b"], "magpie-sales"), clusterId(["a", "b"], "magpie-support"));
  // Order-independent and stable within a flow.
  assert.equal(clusterId(["a", "b"], "magpie-sales"), clusterId(["b", "a"], "magpie-sales"));
});

const clusterOf = (summaries: string[]) =>
  buildCluster(
    summaries.map((s) => candidate(s, ["q"])),
    undefined,
    undefined
  );

test("selectClustersToDraft returns the live summaries of an uncovered cluster", () => {
  const selected = selectClustersToDraft([clusterOf(["a", "b"])], ["a", "b"], []);
  assert.deepEqual(selected, [["a", "b"]]);
});

test("selectClustersToDraft skips a cluster already fully covered by a proposal", () => {
  const selected = selectClustersToDraft([clusterOf(["a", "b"])], ["a", "b"], ["a", "b"]);
  assert.deepEqual(selected, []);
});

test("selectClustersToDraft drafts a cluster that has at least one uncovered gap", () => {
  // "a" is already covered but "b" is not, so the cluster is still worth drafting.
  const selected = selectClustersToDraft([clusterOf(["a", "b"])], ["a", "b"], ["a"]);
  assert.deepEqual(selected, [["a", "b"]]);
});

test("selectClustersToDraft drops summaries that are no longer live candidates", () => {
  // "gone" was resolved/removed since clustering, so it must not be drafted.
  const selected = selectClustersToDraft([clusterOf(["a", "gone"])], ["a"], []);
  assert.deepEqual(selected, [["a"]]);
});

test("selectClustersToDraft never drafts the same gap twice across overlapping clusters", () => {
  const selected = selectClustersToDraft([clusterOf(["a"]), clusterOf(["a"])], ["a"], []);
  // Second cluster is suppressed once the first claims "a".
  assert.deepEqual(selected, [["a"]]);
});
