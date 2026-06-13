import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresKnowledgeStore vector search", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("counts sections needing an embedding without error", async () => {
    const store = new PostgresKnowledgeStore(databaseUrl as string);
    const pending = await store.countSectionsNeedingEmbedding();
    assert.ok(pending >= 0);
  });
});
