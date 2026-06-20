import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import { retrieve } from "./service.js";

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

test("retrieve scopes sections to the flow's destination repository", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "support", name: "Support", sourceIds: ["s"], destinationId: "support-kb" },
    { id: "eng", name: "Engineering", sourceIds: ["s"], destinationId: "eng-kb" }
  ];
  await seedTwoRepos(ctx);

  const { sections } = await retrieve(ctx, { question: "how do I rollback the hotfix", flowId: "support" });

  assert.ok(sections.length >= 1);
  assert.ok(
    sections.every((section) => section.sectionId.startsWith("support-kb:")),
    "sections should be scoped to the flow's destination"
  );
  assert.equal(sections[0].path, "rollback.md");
  assert.ok(sections[0].heading.length > 0);
  assert.ok(sections[0].content.length > 0);
});

test("retrieve searches unscoped when no flowId is given", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "support", name: "Support", sourceIds: ["s"], destinationId: "support-kb" },
    { id: "eng", name: "Engineering", sourceIds: ["s"], destinationId: "eng-kb" }
  ];
  await seedTwoRepos(ctx);

  const { sections } = await retrieve(ctx, { question: "how do I rollback the hotfix" });

  const repos = new Set(sections.map((section) => section.sectionId.split(":")[0]));
  assert.ok(repos.has("support-kb") && repos.has("eng-kb"), "both repositories should be searchable unscoped");
});

test("retrieve honours the limit", async () => {
  const ctx = makeTestContext();
  await seedTwoRepos(ctx);

  const { sections } = await retrieve(ctx, { question: "rollback workflow", limit: 1 });

  assert.equal(sections.length, 1);
});
