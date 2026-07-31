import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresSourceConflictStore } from "./postgres-source-conflict-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresSourceConflictStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const pool = makeTestPool(databaseUrl as string);
  const store = new PostgresSourceConflictStore(pool);

  const positions = [
    { sourceId: "policy", path: "security/logging.md", statement: "retained for 1 year" },
    { sourceId: "ingest", path: "src/retention.ts", statement: "RETENTION_DAYS = 60" }
  ];

  function input(overrides: { flowId?: string; documentPath?: string; topic?: string } = {}) {
    return {
      flowId: `flow-${randomUUID()}`,
      documentPath: `kb/${randomUUID()}.md`,
      anchor: "logging-retention",
      topic: "log retention period",
      summary: "One source states 1 year, another enforces 60 days.",
      claim: "Logs are retained for 1 year.",
      positions,
      ...overrides
    };
  }

  it("round-trips a conflict and bumps seenCount on re-detection", async () => {
    const args = input();
    const first = await store.upsert(args);
    assert.equal(first.created, true);
    assert.equal(first.conflict.seenCount, 1);
    assert.equal(first.conflict.status, "open");
    assert.deepEqual(first.conflict.positions, positions);

    const second = await store.upsert(args);
    assert.equal(second.created, false);
    assert.equal(second.conflict.id, first.conflict.id);
    assert.equal(second.conflict.seenCount, 2);
  });

  it("keeps a dismissed conflict dismissed when re-detected", async () => {
    const args = input();
    const { conflict } = await store.upsert(args);
    await store.dismiss(conflict.id, "the policy is authoritative here");
    const again = await store.upsert(args);
    assert.equal(again.conflict.status, "dismissed");
    assert.equal(again.conflict.seenCount, 2);
    assert.equal(again.conflict.dismissalNote, "the policy is authoritative here");
  });

  it("dedupes on the unscoped flow, where a NULL key would not", async () => {
    const args = input({ flowId: undefined });
    const first = await store.upsert(args);
    const second = await store.upsert(args);
    assert.equal(second.created, false);
    assert.equal(second.conflict.id, first.conflict.id);
  });

  it("lists open document paths and drops them once resolved", async () => {
    const args = input();
    const { conflict } = await store.upsert(args);
    assert.deepEqual(await store.listOpenPaths(args.flowId), [args.documentPath]);
    await store.resolve(conflict.id, "Logs are retained for 60 days.");
    assert.deepEqual(await store.listOpenPaths(args.flowId), []);
    const resolved = await store.get(conflict.id);
    assert.equal(resolved?.status, "resolved");
    assert.equal(resolved?.agreedStatement, "Logs are retained for 60 days.");
    assert.ok(resolved?.resolvedAt);
  });

  it("filters the register by flow and status", async () => {
    const args = input();
    await store.upsert(args);
    const open = await store.list({ flowId: args.flowId, status: "open", limit: 10 });
    assert.equal(open.length, 1);
    assert.equal(open[0]?.documentPath, args.documentPath);
    assert.deepEqual(await store.list({ flowId: args.flowId, status: "dismissed", limit: 10 }), []);
  });

  it("links the annotation proposal", async () => {
    const { conflict } = await store.upsert(input());
    const proposalId = randomUUID();
    const updated = await store.recordAnnotation(conflict.id, proposalId);
    assert.equal(updated?.annotatedProposalId, proposalId);
  });
});
