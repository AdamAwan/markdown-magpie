import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

describe("GET /api/source-map", () => {
  it("returns the most-recently-updated entries for the requested sources", async () => {
    const ctx = makeTestContext();
    await ctx.stores.sourceMap.upsert({ sourceId: "s1", topic: "events", paths: ["src/events/"], description: "Event bus" });
    await ctx.stores.sourceMap.upsert({ sourceId: "s2", topic: "specs", paths: ["Docs/Specs/"], description: "Specifications" });
    await ctx.stores.sourceMap.upsert({ sourceId: "s3", topic: "unrelated", paths: ["x/"], description: "Not requested" });
    const app = buildApp(ctx);

    const res = await app.request("/api/source-map?sourceIds=s1,s2");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<{ sourceId: string; topic: string }> };
    assert.deepEqual(body.entries.map((e) => e.sourceId).sort(), ["s1", "s2"]);
  });

  it("rejects a request without sourceIds", async () => {
    const app = buildApp(makeTestContext());
    const res = await app.request("/api/source-map");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "source_ids_required" });
  });
});
