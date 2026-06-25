import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../test-support/context.js";
import { proposalFlowId } from "./flow.js";

test("proposalFlowId prefers a first-class flowId over the cluster lookup", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "t",
    targetPath: "a.md",
    markdown: "# a",
    rationale: "r",
    evidence: [],
    flowId: "billing"
  });
  assert.equal(await proposalFlowId(ctx, proposal), "billing");
});

test("proposalFlowId falls back to undefined when neither flowId nor cluster is set", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "t",
    targetPath: "a.md",
    markdown: "# a",
    rationale: "r",
    evidence: []
  });
  assert.equal(await proposalFlowId(ctx, proposal), undefined);
});
