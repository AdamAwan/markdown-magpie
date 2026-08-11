import { test } from "node:test";
import assert from "node:assert/strict";
import type { RankedSection } from "@magpie/core";
import { makeTestContext } from "../../test-support/context.js";
import { retrieve, type RetrieveResult } from "./service.js";

// Builds a context whose knowledge index returns exactly the given
// (id, relevance) candidates, regardless of the question asked — lets the
// relevance-floor tests assert on precise boundary values without depending on
// the real keyword scorer's distribution. No embedding provider is configured
// (makeTestContext's default), so retrievalMode resolves to "keyword".
function buildContext(candidates: { id: string; relevance: number }[]): ReturnType<typeof makeTestContext> {
  const ctx = makeTestContext();
  ctx.stores.knowledgeIndex.search = async (): Promise<RankedSection[]> =>
    candidates.map(({ id, relevance }) => ({
      section: {
        id,
        documentId: `${id}-doc`,
        path: `${id}.md`,
        heading: id,
        headingPath: [id],
        anchor: id,
        content: `content for ${id}`,
        ordinal: 0
      },
      relevance
    }));
  return ctx;
}

async function seedTwoRepos(ctx: ReturnType<typeof makeTestContext>): Promise<void> {
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    documents: [{ path: "rollback.md", content: "# Hotfix Rollback\nRun the rollback workflow.\n" }],
    repositoryId: "support-kb"
  });
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    documents: [{ path: "rollback.md", content: "# Hotfix Rollback\nRun the rollback workflow.\n" }],
    repositoryId: "eng-kb"
  });
}

function expectOk(result: RetrieveResult): Extract<RetrieveResult, { ok: true }> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

const TWO_FLOWS = [
  { id: "support", name: "Support", sourceIds: ["s"], destinationId: "support-kb" },
  { id: "eng", name: "Engineering", sourceIds: ["s"], destinationId: "eng-kb" }
];

test("retrieve scopes sections to the flow's destination repository", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [...TWO_FLOWS];
  await seedTwoRepos(ctx);

  const { sections } = expectOk(await retrieve(ctx, { question: "how do I rollback the hotfix", flowId: "support" }));

  assert.ok(sections.length >= 1);
  assert.ok(
    sections.every((section) => section.sectionId.startsWith("support-kb:")),
    "sections should be scoped to the flow's destination"
  );
  assert.equal(sections[0].path, "rollback.md");
  assert.ok(sections[0].heading.length > 0);
  assert.ok(sections[0].content.length > 0);
  assert.ok(sections[0].relevance > 0, "each section carries its retrieval relevance");
});

test("retrieve returns no sections for a question nothing matches (no filler citations)", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [...TWO_FLOWS];
  await seedTwoRepos(ctx);

  // A question with no term overlap and no strong match must not be padded out
  // with weak sections — otherwise every bogus question yields citations.
  const { sections } = expectOk(await retrieve(ctx, { question: "xylophone quantum barnacle" }));

  assert.equal(sections.length, 0);
});

test("retrieve searches unscoped when no flowId is given", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [...TWO_FLOWS];
  await seedTwoRepos(ctx);

  const { sections } = expectOk(await retrieve(ctx, { question: "how do I rollback the hotfix" }));

  const repos = new Set(sections.map((section) => section.sectionId.split(":")[0]));
  assert.ok(repos.has("support-kb") && repos.has("eng-kb"), "both repositories should be searchable unscoped");
});

test("retrieve honours the limit", async () => {
  const ctx = makeTestContext();
  await seedTwoRepos(ctx);

  const { sections } = expectOk(await retrieve(ctx, { question: "rollback workflow", limit: 1 }));

  assert.equal(sections.length, 1);
});

test("retrieve rejects an unknown flowId rather than searching unscoped", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [...TWO_FLOWS];
  await seedTwoRepos(ctx);

  const result = await retrieve(ctx, { question: "how do I rollback the hotfix", flowId: "does-not-exist" });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unknown_flow");
  }
});

test("the relative floor keeps a uniformly-scoring pool intact", async () => {
  // No candidate stands out, so there is nothing for the relative floor to be
  // relative to and all three survive. This test owns the RELATIVE floor only:
  // the values sit above MIN_RELEVANCE deliberately, because above the absolute
  // floor is the only region where the relative floor decides anything.
  //
  // Note this is NOT the general "a weak pool is never returned empty" property
  // the design aimed for — that property does not hold. Below MIN_RELEVANCE a
  // uniformly weak pool IS returned empty; see the next test.
  const ctx = buildContext([
    { id: "s1", relevance: 0.5 },
    { id: "s2", relevance: 0.45 },
    { id: "s3", relevance: 0.42 }
  ]);
  const result = await retrieve(ctx, { question: "anything" });
  assert.ok(result.ok);
  assert.equal(result.sections.length, 3);
});

test("returns nothing when every candidate is below the absolute floor", async () => {
  // The absolute floor still cliff-edges to empty, by design: a pool of pure
  // single-lexeme noise (see MIN_RELEVANCE's derivation) is not evidence of
  // anything, and a genuine knowledge-gap question must not collect citations
  // from it. `candidateCount` is what tells the caller these matches existed —
  // so a lexical near-miss is still distinguishable from "nothing matched".
  const ctx = buildContext([
    { id: "s1", relevance: 0.2 },
    { id: "s2", relevance: 0.18 },
    { id: "s3", relevance: 0.17 }
  ]);
  const result = await retrieve(ctx, { question: "anything" });
  assert.ok(result.ok);
  assert.equal(result.sections.length, 0);
  assert.equal(result.candidateCount, 3);
});

test("drops weak results that sit alongside a strong one", async () => {
  // s2 clears the absolute floor, so only the relative floor can drop it —
  // keeping this test honest about which of the two parts it exercises.
  const ctx = buildContext([
    { id: "s1", relevance: 0.9 },
    { id: "s2", relevance: 0.42 }
  ]);
  const result = await retrieve(ctx, { question: "anything" });
  assert.ok(result.ok);
  assert.deepEqual(
    result.sections.map((section) => section.sectionId),
    ["s1"]
  );
});

test("reports candidate count before the floor, and the retrieval mode", async () => {
  const ctx = buildContext([
    { id: "s1", relevance: 0.9 },
    { id: "s2", relevance: 0.02 }
  ]);
  const result = await retrieve(ctx, { question: "anything" });
  assert.ok(result.ok);
  assert.equal(result.sections.length, 1);
  assert.equal(result.candidateCount, 2, "candidateCount counts matches before the floor");
  assert.equal(result.retrievalMode, "keyword", "no embedding provider is configured in the fixture");
});
