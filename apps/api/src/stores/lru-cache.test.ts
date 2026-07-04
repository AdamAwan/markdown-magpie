import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LruCache } from "./lru-cache.js";

describe("LruCache", () => {
  it("returns undefined for a missing key and the value for a present one", () => {
    const cache = new LruCache<string, number>(2);
    assert.equal(cache.get("a"), undefined);
    cache.set("a", 1);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.size, 1);
  });

  it("evicts the least-recently-used entry once capacity is exceeded", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // exceeds capacity 2 -> evicts "a" (oldest)

    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.get("c"), 3);
    assert.equal(cache.size, 2);
  });

  it("counts a get as a use, protecting the touched entry from eviction", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    // Touch "a" so "b" becomes least-recently-used.
    assert.equal(cache.get("a"), 1);
    cache.set("c", 3); // evicts "b", not "a"

    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("c"), 3);
  });

  it("re-setting an existing key refreshes its recency and updates its value", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 11); // update + refresh recency of "a"
    cache.set("c", 3); // evicts "b" (now oldest), keeps "a"

    assert.equal(cache.get("a"), 11);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("c"), 3);
  });

  it("rejects a non-positive or non-integer capacity", () => {
    assert.throws(() => new LruCache<string, number>(0), /positive integer/);
    assert.throws(() => new LruCache<string, number>(-1), /positive integer/);
    assert.throws(() => new LruCache<string, number>(1.5), /positive integer/);
  });
});
