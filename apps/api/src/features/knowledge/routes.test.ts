import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the route shape directly.

test("GET /api/knowledge/flows returns id/name for each configured flow", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb", persona: "Be kind" },
    { id: "eng", name: "Engineering", sourceIds: ["s"], destinationId: "kb2" }
  ];
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/flows");

  assert.equal(res.status, 200);
  // Only id and name are exposed — personas/sources/destinations stay internal.
  assert.deepEqual(await res.json(), {
    flows: [
      { id: "support", name: "Support" },
      { id: "eng", name: "Engineering" }
    ]
  });
});

test("GET /api/knowledge/flows returns an empty list when none are configured", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/flows");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { flows: [] });
});

test("GET /api/knowledge/documents paginates with a default limit of 50 and reports the unpaginated total", async () => {
  const ctx = makeTestContext();
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    documents: Array.from({ length: 60 }, (_, index) => ({
      path: `doc-${String(index).padStart(2, "0")}.md`,
      content: `# Doc ${index}`
    }))
  });
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/documents");
  const body = (await res.json()) as { documents: Array<{ path: string }>; total: number };

  assert.equal(res.status, 200);
  assert.equal(body.documents.length, 50);
  assert.equal(body.total, 60);
  assert.equal(body.documents[0]?.path, "doc-00.md");
});

test("GET /api/knowledge/documents honours limit/offset and caps limit at 200", async () => {
  const ctx = makeTestContext();
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    documents: Array.from({ length: 10 }, (_, index) => ({
      path: `doc-${String(index).padStart(2, "0")}.md`,
      content: `# Doc ${index}`
    }))
  });
  const app = buildApp(ctx);

  const page = await app.request("/api/knowledge/documents?limit=3&offset=2");
  const pageBody = (await page.json()) as { documents: Array<{ path: string }>; total: number };
  assert.equal(pageBody.documents.length, 3);
  assert.equal(pageBody.total, 10);
  assert.deepEqual(
    pageBody.documents.map((document) => document.path),
    ["doc-02.md", "doc-03.md", "doc-04.md"]
  );

  const overLimit = await app.request("/api/knowledge/documents?limit=500");
  const overLimitBody = (await overLimit.json()) as { documents: unknown[]; total: number };
  assert.equal(overLimitBody.documents.length, 10);
  assert.equal(overLimitBody.total, 10);
});

test("GET /api/knowledge/sections/:id returns the full section", async () => {
  const ctx = makeTestContext();
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    documents: [{ path: "guide.md", content: "# Guide\n\n## Setup\n\nInstall steps." }]
  });
  const [ranked] = await ctx.stores.knowledgeIndex.search("install", 1);
  assert.ok(ranked, "expected an indexed section to cite");
  const app = buildApp(ctx);

  const res = await app.request(`/api/knowledge/sections/${encodeURIComponent(ranked.section.id)}`);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { section: ranked.section });
});

test("GET /api/knowledge/sections/:id returns 404 section_not_found for an unknown id", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/sections/does-not-exist");

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "section_not_found" });
});

test("GET /api/knowledge/repositories paginates and reports the unpaginated total", async () => {
  const ctx = makeTestContext();
  for (let index = 0; index < 3; index += 1) {
    await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
      repositoryId: `repo-${index}`,
      name: `Repo ${index}`,
      documents: [{ path: "doc.md", content: "# Doc" }]
    });
  }
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/repositories?limit=2");
  const body = (await res.json()) as { repositories: Array<{ id: string }>; total: number };

  assert.equal(res.status, 200);
  assert.equal(body.repositories.length, 2);
  assert.equal(body.total, 3);
});
