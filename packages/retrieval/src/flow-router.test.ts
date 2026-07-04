import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cosineSimilarity, routeByEmbeddingSimilarity } from "./flow-router.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal, -1 for opposite", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  });

  it("ignores magnitude (direction only)", () => {
    assert.equal(cosineSimilarity([2, 0], [5, 0]), 1);
  });

  it("returns 0 for a zero vector or a length mismatch rather than NaN", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  });
});

describe("routeByEmbeddingSimilarity", () => {
  const options = { minTopScore: 0.2, minMargin: 0.1 };

  it("routes to the clear top flow with high confidence", () => {
    const route = routeByEmbeddingSimilarity(
      [1, 0],
      [
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [0, 1] }
      ],
      options
    );
    assert.equal(route.status, "routed");
    if (route.status === "routed") {
      assert.equal(route.flowId, "a");
      assert.equal(route.confidence, "high");
      assert.ok(route.margin > 0.1);
    }
  });

  it("routes but only medium confidence when the margin is slim", () => {
    // q=[1,0]: sim(a)=1, sim(b)=1/sqrt(1.25)=0.894 → margin ≈ 0.106, between minMargin and 2·minMargin.
    const route = routeByEmbeddingSimilarity(
      [1, 0],
      [
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [1, 0.5] }
      ],
      options
    );
    assert.equal(route.status, "routed");
    if (route.status === "routed") {
      assert.equal(route.flowId, "a");
      assert.equal(route.confidence, "medium");
    }
  });

  it("abstains on a near-tie (margin below the threshold)", () => {
    const route = routeByEmbeddingSimilarity(
      [1, 1],
      [
        { id: "a", vector: [1, 1] },
        { id: "b", vector: [1, 0.9] }
      ],
      options
    );
    assert.equal(route.status, "abstain");
  });

  it("abstains when even the top flow is below the score floor", () => {
    const route = routeByEmbeddingSimilarity(
      [-1, -1],
      [
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [0, 1] }
      ],
      options
    );
    assert.equal(route.status, "abstain");
  });

  it("abstains when there are no flows to route to", () => {
    assert.equal(routeByEmbeddingSimilarity([1, 0], [], options).status, "abstain");
  });

  it("routes a single above-floor flow (no runner-up to beat)", () => {
    const route = routeByEmbeddingSimilarity([1, 0], [{ id: "only", vector: [1, 0] }], options);
    assert.equal(route.status, "routed");
    if (route.status === "routed") {
      assert.equal(route.flowId, "only");
    }
  });
});
