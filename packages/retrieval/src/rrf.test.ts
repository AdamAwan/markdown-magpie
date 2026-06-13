import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuseRankings } from "./rrf.js";

describe("fuseRankings", () => {
  it("rewards items ranked highly across multiple lists", () => {
    const scores = fuseRankings([
      ["a", "b", "c"],
      ["b", "a", "d"]
    ]);
    assert.ok((scores.get("a") ?? 0) > (scores.get("c") ?? 0));
    assert.ok((scores.get("b") ?? 0) > (scores.get("d") ?? 0));
    assert.equal(scores.get("c"), 1 / 63);
  });

  it("sums contributions for an item appearing in every list", () => {
    const scores = fuseRankings([["x"], ["x"]]);
    assert.equal(scores.get("x"), 1 / 61 + 1 / 61);
  });

  it("honours a custom k", () => {
    const scores = fuseRankings([["x"]], 9);
    assert.equal(scores.get("x"), 1 / 10);
  });

  it("returns an empty map for no rankings", () => {
    assert.equal(fuseRankings([]).size, 0);
  });
});
