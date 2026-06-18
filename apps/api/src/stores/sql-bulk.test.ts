import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunk, valuesClause } from "./sql-bulk.js";

describe("chunk", () => {
  it("splits into batches of at most size", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it("returns an empty array for no items", () => {
    assert.deepEqual(chunk([], 3), []);
  });

  it("keeps a single batch when smaller than size", () => {
    assert.deepEqual(chunk([1, 2], 10), [[1, 2]]);
  });

  it("rejects a size below 1", () => {
    assert.throws(() => chunk([1], 0));
  });
});

describe("valuesClause", () => {
  it("numbers parameters across rows", () => {
    assert.equal(valuesClause(2, 3), "($1, $2, $3), ($4, $5, $6)");
  });

  it("appends per-row trailing literals without consuming params", () => {
    assert.equal(valuesClause(2, 2, ["now()"]), "($1, $2, now()), ($3, $4, now())");
  });

  it("handles a single row", () => {
    assert.equal(valuesClause(1, 4), "($1, $2, $3, $4)");
  });

  it("returns an empty string for no rows", () => {
    assert.equal(valuesClause(0, 3), "");
  });
});
