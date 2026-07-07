import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withCheckoutLock } from "./checkout-lock.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Records start/end markers so a test can assert whether two runs overlapped.
function tracker() {
  const events: string[] = [];
  const task = (id: string, ms: number) => async () => {
    events.push(`${id}:start`);
    await delay(ms);
    events.push(`${id}:end`);
    return id;
  };
  return { events, task };
}

describe("withCheckoutLock", () => {
  it("serializes calls that share a key (the second waits for the first)", async () => {
    const { events, task } = tracker();
    await Promise.all([
      withCheckoutLock("repo-a", task("first", 30)),
      withCheckoutLock("repo-a", task("second", 5))
    ]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  });

  it("runs calls with different keys concurrently", async () => {
    const { events, task } = tracker();
    await Promise.all([
      withCheckoutLock("repo-a", task("a", 30)),
      withCheckoutLock("repo-b", task("b", 5))
    ]);
    // Both started before either finished — they overlapped.
    assert.deepEqual(events.slice(0, 2).sort(), ["a:start", "b:start"]);
  });

  it("returns the function's resolved value to the caller", async () => {
    const value = await withCheckoutLock("repo-a", async () => 42);
    assert.equal(value, 42);
  });

  it("does not wedge the key when a held function rejects", async () => {
    await assert.rejects(
      withCheckoutLock("repo-a", async () => {
        throw new Error("boom");
      }),
      /boom/
    );
    const after = await withCheckoutLock("repo-a", async () => "recovered");
    assert.equal(after, "recovered");
  });
});
