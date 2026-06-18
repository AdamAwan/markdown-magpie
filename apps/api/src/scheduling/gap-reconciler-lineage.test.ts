import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectSurvivingClusterOnMerge, selectRetainingChildOnSplit } from "./gap-reconciler-lineage.js";

describe("merge lineage", () => {
  it("keeps the oldest cluster (lowest createdAt; ties by lowest id)", () => {
    const survivor = selectSurvivingClusterOnMerge([
      { id: "10", createdAt: "2026-06-02T00:00:00.000Z" },
      { id: "3", createdAt: "2026-06-01T00:00:00.000Z" },
      { id: "7", createdAt: "2026-06-01T00:00:00.000Z" }
    ]);
    // Two share the oldest createdAt; lowest id wins.
    assert.equal(survivor, "3");
  });
});

describe("split lineage", () => {
  it("keeps the largest child; ties by lowest leading gap id", () => {
    const retaining = selectRetainingChildOnSplit([
      { key: "child-a", gapIds: ["5", "9"] },
      { key: "child-b", gapIds: ["2", "4", "8"] },
      { key: "child-c", gapIds: ["1", "6"] }
    ]);
    assert.equal(retaining, "child-b"); // 3 members beats 2 (no size tie here)

    const tie = selectRetainingChildOnSplit([
      { key: "child-x", gapIds: ["9", "10"] },
      { key: "child-y", gapIds: ["2", "3"] }
    ]);
    // Equal size: compare the lowest gap id numerically; child-y (2) < child-x (9).
    assert.equal(tie, "child-y");
  });
});
