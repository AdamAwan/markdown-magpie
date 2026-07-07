import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cosineSimilarity,
  foldIntoCentroid,
  l2Normalise,
  normalisedMean,
  planAssignments,
  type AssignmentCandidate,
  type ClusterRepresentative
} from "./gap-assignment.js";

// 2-d unit vectors are enough to exercise every code path; angles picked so the
// intended relations are far from the 0.9-ish thresholds under test.
const east = [1, 0];
const nearEast = l2Normalise([0.995, 0.0999]); // cosine vs east ≈ 0.995
const north = [0, 1];
const nearNorth = l2Normalise([0.0999, 0.995]);
const northeast = l2Normalise([1, 1]); // cosine vs east ≈ 0.707

describe("vector helpers", () => {
  it("l2Normalise produces a unit vector and rejects zero vectors", () => {
    const normalised = l2Normalise([3, 4]);
    assert.ok(Math.abs(cosineSimilarity(normalised, [3, 4]) - 1) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...normalised) - 1) < 1e-12);
    assert.throws(() => l2Normalise([0, 0]), /zero or non-finite/);
  });

  it("cosineSimilarity matches known angles and rejects length mismatches", () => {
    assert.ok(Math.abs(cosineSimilarity(east, north)) < 1e-12);
    assert.ok(Math.abs(cosineSimilarity(east, east) - 1) < 1e-12);
    assert.ok(Math.abs(cosineSimilarity(east, northeast) - Math.SQRT1_2) < 1e-9);
    assert.throws(() => cosineSimilarity([1], [1, 0]), /length mismatch/);
  });

  it("normalisedMean averages then normalises", () => {
    const mean = normalisedMean([east, north]);
    assert.ok(Math.abs(cosineSimilarity(mean, northeast) - 1) < 1e-12);
    assert.throws(() => normalisedMean([]), /zero vectors/);
  });

  it("foldIntoCentroid folds additions as if the prior members summed to n·r", () => {
    // Prior: one member at east. Fold in one member at north → normalise([1,1]).
    const folded = foldIntoCentroid(east, 1, [north]);
    assert.ok(Math.abs(cosineSimilarity(folded, northeast) - 1) < 1e-12);
    // No additions → unchanged direction.
    const unchanged = foldIntoCentroid(east, 3, []);
    assert.ok(Math.abs(cosineSimilarity(unchanged, east) - 1) < 1e-12);
  });
});

describe("planAssignments", () => {
  const clusters: ClusterRepresentative[] = [
    { clusterId: "10", embedding: east },
    { clusterId: "11", embedding: north }
  ];

  it("joins each candidate to the best cluster at or above the threshold", () => {
    const candidates: AssignmentCandidate[] = [
      { key: "a", embedding: nearEast },
      { key: "b", embedding: nearNorth }
    ];
    const plan = planAssignments(candidates, clusters, 0.9);
    assert.deepEqual(plan.joins.get("10"), ["a"]);
    assert.deepEqual(plan.joins.get("11"), ["b"]);
    assert.deepEqual(plan.seeds, []);
  });

  it("seeds new clusters from candidates below the threshold, grouping transitively", () => {
    // c1~c2 and c2~c3 are above the threshold, c1~c3 is not: still one component.
    const c1 = l2Normalise([1, 0]);
    const c2 = l2Normalise([0.98, 0.199]); // cos(c1,c2) ≈ 0.98
    const c3 = l2Normalise([0.921, 0.39]); // cos(c2,c3) ≈ 0.98, cos(c1,c3) ≈ 0.92
    const lone = north;
    const plan = planAssignments(
      [
        { key: "c3", embedding: c3 },
        { key: "c1", embedding: c1 },
        { key: "lone", embedding: lone },
        { key: "c2", embedding: c2 }
      ],
      [],
      0.95
    );
    assert.deepEqual(plan.joins.size, 0);
    assert.deepEqual(plan.seeds, [["c1", "c2", "c3"], ["lone"]]);
  });

  it("is independent of candidate input order", () => {
    const candidates: AssignmentCandidate[] = [
      { key: "p", embedding: nearEast },
      { key: "q", embedding: northeast },
      { key: "r", embedding: nearNorth },
      { key: "s", embedding: l2Normalise([0.6, 0.8]) }
    ];
    const forward = planAssignments(candidates, clusters, 0.9);
    const reversed = planAssignments([...candidates].reverse(), clusters, 0.9);
    assert.deepEqual([...forward.joins.entries()].sort(), [...reversed.joins.entries()].sort());
    assert.deepEqual(forward.seeds, reversed.seeds);
  });

  it("breaks exact ties toward the earlier representative (callers pass id-ASC)", () => {
    const tied: ClusterRepresentative[] = [
      { clusterId: "3", embedding: east },
      { clusterId: "7", embedding: east }
    ];
    const plan = planAssignments([{ key: "x", embedding: east }], tied, 0.9);
    assert.deepEqual(plan.joins.get("3"), ["x"]);
    assert.equal(plan.joins.has("7"), false);
  });

  it("handles empty inputs", () => {
    const plan = planAssignments([], clusters, 0.9);
    assert.equal(plan.joins.size, 0);
    assert.deepEqual(plan.seeds, []);
  });
});
