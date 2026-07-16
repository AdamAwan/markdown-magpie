import { test } from "node:test";
import assert from "node:assert/strict";
import type { EmbeddingProvider } from "@magpie/core";
import { makeTestContext } from "../../test-support/context.js";
import { route } from "./service.js";

// A deterministic embedding provider: each text maps to a caller-supplied vector, and
// every embed() call is recorded so tests can assert batching and cache reuse.
class FakeEmbeddingProvider implements EmbeddingProvider {
  calls: string[][] = [];
  constructor(private readonly vectorFor: (text: string) => number[]) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((text) => this.vectorFor(text));
  }
}

const FLOWS = [
  { id: "deploy", name: "Deploy" },
  { id: "billing", name: "Billing" }
];

// Billing text → [0,1]; everything else (deploy flow + a deploy question) → [1,0].
const deployVsBilling = (text: string): number[] => (text.includes("Billing") ? [0, 1] : [1, 0]);

test("routes to the flow whose embedding clearly wins", async () => {
  const ctx = makeTestContext({ providers: { embedding: new FakeEmbeddingProvider(deployVsBilling) } });

  const result = await route(ctx, { question: "how do I deploy", flows: FLOWS });

  assert.equal(result.status, "routed");
  if (result.status === "routed") {
    assert.equal(result.flowId, "deploy");
    assert.equal(result.confidence, "high");
  }
});

test("abstains when no embedding provider is configured (no embed call)", async () => {
  const ctx = makeTestContext(); // providers.embedding is undefined by default
  const result = await route(ctx, { question: "how do I deploy", flows: FLOWS });
  assert.equal(result.status, "abstain");
});

test("embeds question + flows in one batched call, then reuses cached flow vectors", async () => {
  const provider = new FakeEmbeddingProvider(deployVsBilling);
  const ctx = makeTestContext({ providers: { embedding: provider } });

  await route(ctx, { question: "deploy question one", flows: FLOWS });
  assert.equal(provider.calls.length, 1, "one batched embedding call");
  assert.deepEqual(provider.calls[0], ["deploy question one", "Deploy", "Billing"], "question first, then flow texts");

  await route(ctx, { question: "deploy question two", flows: FLOWS });
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(
    provider.calls[1],
    ["deploy question two"],
    "flow vectors are cached — only the question is re-embedded"
  );
});

test("routes using each flow's config routing summary, resolved server-side by id", async () => {
  // Names alone are neutral ([0.5,0.5]); only the summaries carry the topical signal.
  const provider = new FakeEmbeddingProvider((text) =>
    /rollback|deploy/i.test(text) ? [1, 0] : /billing|invoice/i.test(text) ? [0, 1] : [0.5, 0.5]
  );
  const ctx = makeTestContext({ providers: { embedding: provider } });
  ctx.knowledgeConfig.flows = [
    { id: "a", name: "Team A", sourceIds: ["s"], destinationId: "kb-a", routingSummary: "deployments and rollbacks" },
    { id: "b", name: "Team B", sourceIds: ["s"], destinationId: "kb-b", routingSummary: "billing and invoices" }
  ];

  const result = await route(ctx, {
    question: "how do I roll back a deploy",
    // The watcher sends only id + name; the summary is looked up from config, not trusted here.
    flows: [
      { id: "a", name: "Team A" },
      { id: "b", name: "Team B" }
    ]
  });

  assert.equal(result.status, "routed");
  if (result.status === "routed") {
    assert.equal(result.flowId, "a");
  }
  assert.ok(
    provider.calls[0].includes("Team A\ndeployments and rollbacks"),
    "the flow's config routing summary is folded into the embedded text"
  );
});

test("abstains on a near-tie (all flows equally similar)", async () => {
  const ctx = makeTestContext({ providers: { embedding: new FakeEmbeddingProvider(() => [1, 1]) } });
  const result = await route(ctx, {
    question: "ambiguous",
    flows: [
      { id: "a", name: "A" },
      { id: "b", name: "B" }
    ]
  });
  assert.equal(result.status, "abstain");
});

test("abstains when the embedding call fails (routing must never fail the ask)", async () => {
  const provider: EmbeddingProvider = {
    embed: async () => {
      throw new Error("embedding backend down");
    }
  };
  const ctx = makeTestContext({ providers: { embedding: provider } });
  const result = await route(ctx, { question: "how do I deploy", flows: FLOWS });
  assert.equal(result.status, "abstain");
});
